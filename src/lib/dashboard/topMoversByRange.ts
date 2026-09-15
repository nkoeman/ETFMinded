import { startOfDay } from "date-fns";
import { getFxRateForWeek } from "@/lib/fx/convert";
import { prisma } from "@/lib/prisma";
import { getWeeklySeriesFromDaily } from "@/lib/valuation/portfolioSeries";
import {
  getPerformanceRangeCutoff,
  PERFORMANCE_RANGE_LABELS,
  type PerformanceRangeOption,
  usesWeeklyGranularity
} from "@/lib/charts/performanceRange";

type ListingLite = {
  id: string;
  isPrimary: boolean;
  mappingStatus: string;
  eodhdCode: string | null;
};

type InstrumentLite = {
  id: string;
  isin: string;
  name: string;
  displayName: string | null;
  listings: ListingLite[];
};

type TopMoversCacheEntry = {
  expiresAt: number;
  value: TopMoversRangeResult;
};

const TOP_MOVERS_CACHE_TTL_MS = 2 * 60 * 1000;
const TOP_MOVERS_CACHE_MAX_ENTRIES = 500;
const topMoversCache = new Map<string, TopMoversCacheEntry>();
const topMoversInFlight = new Map<string, Promise<TopMoversRangeResult>>();

export type TopMoversRangeContributor = {
  instrumentId: string;
  isin: string;
  instrumentName: string;
  contributionEur: number;
  contributionPctOfMove: number | null;
  localReturnPct: number | null;
};

export type TopMoversRangeResult = {
  range: PerformanceRangeOption;
  label: string;
  granularity: "WEEKLY" | "DAILY";
  window: {
    startDate: Date | null;
    endDate: Date | null;
  };
  contributors: {
    topGainers: TopMoversRangeContributor[];
    topLosers: TopMoversRangeContributor[];
  };
  lastUpdatedAt: Date | null;
};

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  return Number(value);
}

function pickListing(listings: ListingLite[], fallbackListingId: string | null) {
  const primaryMapped = listings.find((listing) =>
    listing.isPrimary && listing.mappingStatus === "MAPPED" && listing.eodhdCode
  );
  const fallback = fallbackListingId
    ? listings.find((listing) => listing.id === fallbackListingId && listing.eodhdCode)
    : null;
  const anyMapped = listings.find((listing) => listing.mappingStatus === "MAPPED" && listing.eodhdCode);
  return primaryMapped || fallback || anyMapped || null;
}

function rankRows(rows: TopMoversRangeContributor[]) {
  const valid = rows.filter((row) => typeof row.localReturnPct === "number" && Number.isFinite(row.localReturnPct));
  return {
    topGainers: [...valid]
      .filter((row) => (row.localReturnPct || 0) > 0)
      .sort((a, b) => (b.localReturnPct || 0) - (a.localReturnPct || 0))
      .slice(0, 5),
    topLosers: [...valid]
      .filter((row) => (row.localReturnPct || 0) < 0)
      .sort((a, b) => (a.localReturnPct || 0) - (b.localReturnPct || 0))
      .slice(0, 5)
  };
}

function buildTopMoversCacheKey(userId: string, range: PerformanceRangeOption, latestDateIso: string) {
  return `${userId}:${range}:${latestDateIso}`;
}

function pruneTopMoversCache(now: number) {
  for (const [key, entry] of topMoversCache.entries()) {
    if (entry.expiresAt <= now) {
      topMoversCache.delete(key);
    }
  }
  while (topMoversCache.size > TOP_MOVERS_CACHE_MAX_ENTRIES) {
    const firstKey = topMoversCache.keys().next().value;
    if (!firstKey) break;
    topMoversCache.delete(firstKey);
  }
}

export function invalidateTopMoversCacheForUser(userId: string) {
  const prefix = `${userId}:`;
  for (const key of topMoversCache.keys()) {
    if (key.startsWith(prefix)) {
      topMoversCache.delete(key);
    }
  }
}

export async function getTopMoversByRange(
  userId: string,
  range: PerformanceRangeOption
): Promise<TopMoversRangeResult> {
  const latestDaily = await prisma.dailyPortfolioValue.findFirst({
    where: { userId },
    orderBy: { date: "desc" },
    select: { date: true }
  });

  if (!latestDaily?.date) {
    return {
      range,
      label: PERFORMANCE_RANGE_LABELS[range],
      granularity: usesWeeklyGranularity(range) ? "WEEKLY" : "DAILY",
      window: { startDate: null, endDate: null },
      contributors: { topGainers: [], topLosers: [] },
      lastUpdatedAt: null
    };
  }

  const endDate = startOfDay(latestDaily.date);
  const cacheKey = buildTopMoversCacheKey(userId, range, toIsoDate(endDate));
  const now = Date.now();
  const cached = topMoversCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached && cached.expiresAt <= now) {
    topMoversCache.delete(cacheKey);
  }

  const inFlight = topMoversInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const startDate = range === "max" ? null : startOfDay(getPerformanceRangeCutoff(endDate, range));
    const granularity: TopMoversRangeResult["granularity"] =
      usesWeeklyGranularity(range) ? "WEEKLY" : "DAILY";

    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        type: "TRADE",
        tradeAt: { lte: endDate }
      },
      include: {
        instrument: {
          include: {
            listings: {
              select: {
                id: true,
                isPrimary: true,
                mappingStatus: true,
                eodhdCode: true
              }
            }
          }
        }
      },
      orderBy: { tradeAt: "asc" }
    });

    const byInstrument = new Map<
      string,
      { instrument: InstrumentLite; qty: number; fallbackListingId: string | null }
    >();

    for (const tx of transactions) {
      const entry = byInstrument.get(tx.instrumentId) || {
        instrument: tx.instrument,
        qty: 0,
        fallbackListingId: tx.listingId
      };
      entry.qty += toNumber(tx.quantity);
      if (!entry.fallbackListingId && tx.listingId) entry.fallbackListingId = tx.listingId;
      byInstrument.set(tx.instrumentId, entry);
    }

    const chosenListingByInstrument = new Map<string, ListingLite>();
    const listingIds = new Set<string>();
    for (const [instrumentId, entry] of byInstrument.entries()) {
      if (entry.qty <= 0) continue;
      const listing = pickListing(entry.instrument.listings, entry.fallbackListingId);
      if (!listing) continue;
      chosenListingByInstrument.set(instrumentId, listing);
      listingIds.add(listing.id);
    }

    const prices = listingIds.size
      ? await prisma.dailyListingPrice.findMany({
          where: {
            listingId: { in: Array.from(listingIds) },
            date: {
              ...(startDate ? { gte: startDate } : {}),
              lte: endDate
            }
          },
          orderBy: [{ listingId: "asc" }, { date: "asc" }],
          select: {
            listingId: true,
            date: true,
            adjustedClose: true,
            currency: true
          }
        })
      : [];

    const pricesByListing = new Map<string, Array<{ date: Date; adjClose: number; currency: string }>>();
    for (const row of prices) {
      const list = pricesByListing.get(row.listingId) || [];
      list.push({
        date: startOfDay(row.date),
        adjClose: toNumber(row.adjustedClose),
        currency: String(row.currency || "EUR")
      });
      pricesByListing.set(row.listingId, list);
    }

    const fxCache = new Map<string, number>();
    const contributors: TopMoversRangeContributor[] = [];

    for (const [instrumentId, entry] of byInstrument.entries()) {
      if (entry.qty <= 0) continue;
      const listing = chosenListingByInstrument.get(instrumentId);
      if (!listing) continue;

      const dailySeries = pricesByListing.get(listing.id) || [];
      if (dailySeries.length < 2) continue;

      const points = usesWeeklyGranularity(range)
        ? (() => {
            const currencyByDate = new Map(
              dailySeries.map((row) => [toIsoDate(row.date), row.currency] as const)
            );
            const fallbackCurrency = dailySeries[dailySeries.length - 1].currency;
            return getWeeklySeriesFromDaily(
              dailySeries.map((row) => ({
                date: row.date,
                valueEur: row.adjClose
              }))
            ).map((row) => ({
              date: row.weekEndDate,
              adjClose: row.valueEur,
              currency: currencyByDate.get(toIsoDate(row.weekEndDate)) || fallbackCurrency
            }));
          })()
        : dailySeries;

      if (points.length < 2) continue;

      const startPoint = points[0];
      const endPoint = points[points.length - 1];
      if (!startPoint || !endPoint || startPoint.adjClose <= 0 || endPoint.adjClose <= 0) continue;

      const startFxKey = `${toIsoDate(startPoint.date)}:${startPoint.currency}`;
      const endFxKey = `${toIsoDate(endPoint.date)}:${endPoint.currency}`;

      let startFx = fxCache.get(startFxKey);
      if (startFx === undefined) {
        try {
          startFx = await getFxRateForWeek(startPoint.date, startPoint.currency);
          fxCache.set(startFxKey, startFx);
        } catch {
          continue;
        }
      }

      let endFx = fxCache.get(endFxKey);
      if (endFx === undefined) {
        try {
          endFx = await getFxRateForWeek(endPoint.date, endPoint.currency);
          fxCache.set(endFxKey, endFx);
        } catch {
          continue;
        }
      }

      const startUnitEur = startPoint.adjClose * startFx;
      const endUnitEur = endPoint.adjClose * endFx;
      if (!Number.isFinite(startUnitEur) || !Number.isFinite(endUnitEur) || startUnitEur <= 0) continue;

      const contributionEur = entry.qty * (endUnitEur - startUnitEur);
      const localReturnPct = endUnitEur / startUnitEur - 1;

      contributors.push({
        instrumentId,
        isin: entry.instrument.isin,
        instrumentName: entry.instrument.displayName || entry.instrument.name,
        contributionEur,
        contributionPctOfMove: null,
        localReturnPct
      });
    }

    const ranked = rankRows(contributors);
    const actualStartDate = prices.length ? prices[0].date : startDate;
    const actualEndDate = prices.length ? prices[prices.length - 1].date : endDate;

    console.info("[DASH][TOP_MOVERS]", {
      userId,
      range,
      granularity,
      startDate: actualStartDate ? toIsoDate(actualStartDate) : null,
      endDate: actualEndDate ? toIsoDate(actualEndDate) : null,
      topGainers: ranked.topGainers.map((row) => ({
        instrumentId: row.instrumentId,
        returnPct: row.localReturnPct
      })),
      topLosers: ranked.topLosers.map((row) => ({
        instrumentId: row.instrumentId,
        returnPct: row.localReturnPct
      }))
    });

    return {
      range,
      label: PERFORMANCE_RANGE_LABELS[range],
      granularity,
      window: {
        startDate: actualStartDate ?? null,
        endDate: actualEndDate ?? null
      },
      contributors: ranked,
      lastUpdatedAt: latestDaily.date
    };
  })();

  topMoversInFlight.set(cacheKey, task);
  try {
    const result = await task;
    const expiresAt = Date.now() + TOP_MOVERS_CACHE_TTL_MS;
    topMoversCache.set(cacheKey, { expiresAt, value: result });
    pruneTopMoversCache(Date.now());
    return result;
  } finally {
    topMoversInFlight.delete(cacheKey);
  }
}
