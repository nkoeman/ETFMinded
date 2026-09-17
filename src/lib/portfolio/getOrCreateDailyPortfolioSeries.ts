import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getExternalCashFlowSeries } from "@/lib/portfolio/getNetExternalCashFlow";
import { modifiedDietzReturn } from "@/lib/performance/dietz";

type FxIndexRow = {
  weekEndDate: Date;
  observedDate: Date;
  rate: number;
};

type HoldingsTx = {
  listingId: string;
  date: Date;
  qty: number;
};

export type DailyPortfolioPoint = {
  date: Date;
  valueEur: number;
  cumulativeReturnAmountEur: number | null;
  netExternalFlowEur: number;
  periodReturnPct: number | null;
  returnIndex: number | null;
  cumulativeReturnPct: number | null;
  partialValuation: boolean;
};

export type DailyPortfolioSeries = {
  startDate: Date;
  endDate: Date;
  points: DailyPortfolioPoint[];
  lastUpdatedAt: Date | null;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_INPUT_VERSION = "v3";
const DEFAULT_DIETZ_TIMING = "END_OF_DAY" as const;
const FIRST_PERIOD_DIETZ_TIMING = "START_OF_DAY" as const;

function startOfDay(value: Date) {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function normalizeCurrency(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase();
}

function toFiniteNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildDateRange(start: Date, end: Date) {
  const dates: Date[] = [];
  let cursor = startOfDay(start);
  const endDay = startOfDay(end);
  while (cursor.getTime() <= endDay.getTime()) {
    dates.push(cursor);
    cursor = new Date(cursor.getTime() + ONE_DAY_MS);
  }
  return dates;
}

function findLatestFxRow(rows: FxIndexRow[], day: Date) {
  let left = 0;
  let right = rows.length - 1;
  let found: FxIndexRow | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const row = rows[mid];
    if (row.weekEndDate.getTime() <= day.getTime()) {
      found = row;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return found;
}

function computeInputHash(payload: Record<string, unknown>) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function getOrCreateDailyPortfolioSeries(
  userId: string,
  options: {
    fromDate?: Date;
    toDate?: Date;
    endDate?: Date;
    days?: number;
    priceLookbackDays?: number;
    forceRecompute?: boolean;
  } = {}
): Promise<DailyPortfolioSeries> {
  const endDate = startOfDay(options.toDate ?? options.endDate ?? new Date());
  const endOfFinalDay = new Date(endDate.getTime() + ONE_DAY_MS - 1);
  const hasExplicitRange = Boolean(options.fromDate);
  const days = Math.max(1, options.days ?? 28);
  const priceLookbackDays = Math.max(0, options.priceLookbackDays ?? 7);
  const forceRecompute = options.forceRecompute ?? false;
  const startDate = hasExplicitRange
    ? startOfDay(options.fromDate as Date)
    : startOfDay(new Date(endDate.getTime() - (days - 1) * ONE_DAY_MS));
  if (startDate.getTime() > endDate.getTime()) {
    return { startDate, endDate, points: [], lastUpdatedAt: null };
  }
  const windowDates = buildDateRange(startDate, endDate);
  const priceStart = startOfDay(
    new Date(startDate.getTime() - priceLookbackDays * ONE_DAY_MS)
  );

  if (!windowDates.length) {
    return { startDate, endDate, points: [], lastUpdatedAt: null };
  }

  const existing = await prisma.dailyPortfolioValue.findMany({
    where: {
      userId,
      date: { gte: startDate, lte: endDate }
    },
    orderBy: { date: "asc" }
  });

  if (!forceRecompute && existing.length === windowDates.length) {
    const hasCumulativeAmountForWindow = existing.every(
      (row) => row.cumulativeReturnAmountEur !== null && row.cumulativeReturnAmountEur !== undefined
    );
    if (hasCumulativeAmountForWindow) {
      const points = existing.map((row) => ({
        date: row.date,
        valueEur: Number(row.valueEur),
        cumulativeReturnAmountEur:
          row.cumulativeReturnAmountEur == null ? null : Number(row.cumulativeReturnAmountEur),
        netExternalFlowEur: Number(row.netExternalFlowEur ?? 0),
        periodReturnPct: row.periodReturnPct == null ? null : Number(row.periodReturnPct),
        returnIndex: row.returnIndex == null ? null : Number(row.returnIndex),
        cumulativeReturnPct: row.cumulativeReturnPct == null ? null : Number(row.cumulativeReturnPct),
        partialValuation: Boolean(row.partialValuation)
      }));
      const lastUpdatedAt =
        existing.reduce<Date | null>((latest, row) => {
          if (!latest || row.computedAt > latest) return row.computedAt;
          return latest;
        }, null) || null;

      return { startDate, endDate, points, lastUpdatedAt };
    }
  }

  const previousDaily = await prisma.dailyPortfolioValue.findFirst({
    where: {
      userId,
      date: { lt: startDate }
    },
    orderBy: { date: "desc" },
    select: { date: true, valueEur: true, returnIndex: true }
  });

  const transactions = await prisma.transaction.findMany({
    where: { userId, tradeAt: { lte: endOfFinalDay } },
    select: {
      instrumentId: true,
      listingId: true,
      tradeAt: true,
      quantity: true,
      valueEur: true,
      totalEur: true,
      instrument: {
        select: {
          listings: {
            where: {
              mappingStatus: "MAPPED",
              eodhdCode: { not: null }
            },
            orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
            select: { id: true }
          }
        }
      }
    },
    orderBy: { tradeAt: "asc" }
  });

  if (!transactions.length) {
    return { startDate, endDate, points: [], lastUpdatedAt: null };
  }

  const fallbackListingByInstrument = new Map<string, string>();
  for (const tx of transactions) {
    const fallback = tx.instrument.listings[0]?.id;
    if (fallback && !fallbackListingByInstrument.has(tx.instrumentId)) {
      fallbackListingByInstrument.set(tx.instrumentId, fallback);
    }
  }

  const resolveListingId = (instrumentId: string, listingId: string | null) =>
    listingId || fallbackListingByInstrument.get(instrumentId) || null;

  const holdingsTransactions: HoldingsTx[] = transactions
    .map((tx) => ({
      listingId: resolveListingId(tx.instrumentId, tx.listingId),
      date: startOfDay(tx.tradeAt),
      qty: Number(tx.quantity)
    }))
    .filter((tx): tx is HoldingsTx => Boolean(tx.listingId))
    .map((tx) => ({ ...tx, listingId: tx.listingId as string }));

  if (!holdingsTransactions.length) {
    return { startDate, endDate, points: [], lastUpdatedAt: null };
  }

  const listingIds = Array.from(new Set(holdingsTransactions.map((tx) => tx.listingId)));

  const [listings, prices] = await Promise.all([
    prisma.instrumentListing.findMany({
      where: { id: { in: listingIds } },
      select: { id: true, isin: true, currency: true }
    }),
    prisma.dailyListingPrice.findMany({
      where: {
        listingId: { in: listingIds },
        date: { gte: priceStart, lte: endDate }
      },
      select: {
        listingId: true,
        date: true,
        adjustedClose: true,
        close: true,
        currency: true
      },
      orderBy: [{ listingId: "asc" }, { date: "asc" }]
    })
  ]);

  if (!prices.length) {
    return { startDate, endDate, points: [], lastUpdatedAt: null };
  }

  const listingMeta = new Map(listings.map((row) => [row.id, row]));
  const pricesByListing = new Map<
    string,
    Array<{ date: Date; close: number | null; adjustedClose: number | null; currency: string | null }>
  >();

  for (const price of prices) {
    const list = pricesByListing.get(price.listingId) || [];
    list.push({
      date: startOfDay(price.date),
      close: price.close === null ? null : Number(price.close),
      adjustedClose: price.adjustedClose === null ? null : Number(price.adjustedClose),
      currency: price.currency || null
    });
    pricesByListing.set(price.listingId, list);
  }

  // Invested capital should only include transactions for listings that have
  // usable market price coverage in the valuation window.
  const pricedListingIds = new Set(prices.map((row) => row.listingId));

  const requiredCurrencies = Array.from(
    new Set(
      listings
        .map((listing) => normalizeCurrency(listing.currency))
        .filter((currency) => Boolean(currency) && currency !== "EUR")
    )
  );

  const fxRows = requiredCurrencies.length
    ? await prisma.fxRate.findMany({
        where: {
          base: "EUR",
          quote: { in: requiredCurrencies },
          weekEndDate: { lte: endDate }
        },
        select: { quote: true, weekEndDate: true, observedDate: true, rate: true },
        orderBy: [{ quote: "asc" }, { weekEndDate: "asc" }]
      })
    : [];

  const fxByCurrency = new Map<string, FxIndexRow[]>();
  for (const row of fxRows) {
    const quote = normalizeCurrency(row.quote);
    const list = fxByCurrency.get(quote) || [];
    list.push({
      weekEndDate: startOfDay(row.weekEndDate),
      observedDate: startOfDay(row.observedDate),
      rate: Number(row.rate)
    });
    fxByCurrency.set(quote, list);
  }

  holdingsTransactions.sort((a, b) => a.date.getTime() - b.date.getTime());
  const investmentFlows = transactions
    .map((tx) => {
      const resolvedListingId = resolveListingId(tx.instrumentId, tx.listingId);
      if (!resolvedListingId || !pricedListingIds.has(resolvedListingId)) {
        return null;
      }
      const raw = toFiniteNumber(tx.valueEur ?? tx.totalEur);
      const absValue = raw === null ? null : Math.abs(raw);
      const qty = toFiniteNumber(tx.quantity);
      if (absValue === null || qty === null) {
        return { date: startOfDay(tx.tradeAt), flow: 0 };
      }
      if (qty > 0) return { date: startOfDay(tx.tradeAt), flow: absValue };
      if (qty < 0) return { date: startOfDay(tx.tradeAt), flow: -absValue };
      return { date: startOfDay(tx.tradeAt), flow: 0 };
    })
    .filter((flow): flow is { date: Date; flow: number } => flow !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  let txIndex = 0;
  let investmentFlowIndex = 0;
  let cumulativeInvestedEur = 0;
  const holdings = new Map<string, number>();
  const priceCursor = new Map<
    string,
    {
      idx: number;
      lastClose: number | null;
      lastAdjustedClose: number | null;
      lastCurrency: string | null;
      lastDate: Date | null;
      series: Array<{ date: Date; close: number | null; adjustedClose: number | null; currency: string | null }>;
    }
  >();

  for (const listingId of listingIds) {
    priceCursor.set(listingId, {
      idx: 0,
      lastClose: null,
      lastAdjustedClose: null,
      lastCurrency: null,
      lastDate: null,
      series: pricesByListing.get(listingId) || []
    });
  }

  const computedAt = new Date();
  const externalFlows = await getExternalCashFlowSeries(userId, startDate, endOfFinalDay);
  const externalFlowByDate = new Map(
    externalFlows.map((flow) => [toIsoDate(flow.date), flow.amountEur])
  );
  let prevValue: number | null = previousDaily ? Number(previousDaily.valueEur) : null;
  let prevIndex: number | null =
    previousDaily && previousDaily.returnIndex !== null
      ? Number(previousDaily.returnIndex)
      : previousDaily
        ? 100
        : null;
  let prevDateForReturn: Date | null = previousDaily ? startOfDay(previousDaily.date) : null;
  let missingPrices = 0;
  const points: DailyPortfolioPoint[] = [];

  for (const day of windowDates) {
    while (
      investmentFlowIndex < investmentFlows.length &&
      investmentFlows[investmentFlowIndex].date.getTime() <= day.getTime()
    ) {
      cumulativeInvestedEur += investmentFlows[investmentFlowIndex].flow;
      investmentFlowIndex += 1;
    }

    while (txIndex < holdingsTransactions.length && holdingsTransactions[txIndex].date.getTime() <= day.getTime()) {
      const tx = holdingsTransactions[txIndex];
      holdings.set(tx.listingId, (holdings.get(tx.listingId) || 0) + tx.qty);
      txIndex += 1;
    }

    let totalValueEur = 0;
    let partialValuation = false;
    const priceSnapshots: Array<{ listingId: string; priceDate: string; close: number; priceType: "close" | "adjusted"; currency: string }> = [];
    const fxSnapshots: Array<{ currency: string; weekEndDate: string; rate: number }> = [];
    const holdingsSnapshot: Array<{ listingId: string; qty: number }> = [];

    for (const [listingId, qty] of holdings.entries()) {
      if (qty === 0) continue;
      holdingsSnapshot.push({ listingId, qty });

      const cursor = priceCursor.get(listingId);
      if (!cursor) continue;

      while (cursor.idx < cursor.series.length && cursor.series[cursor.idx].date.getTime() <= day.getTime()) {
        cursor.lastClose = cursor.series[cursor.idx].close;
        cursor.lastAdjustedClose = cursor.series[cursor.idx].adjustedClose;
        cursor.lastCurrency = cursor.series[cursor.idx].currency;
        cursor.lastDate = cursor.series[cursor.idx].date;
        cursor.idx += 1;
      }

      if (!cursor.lastDate) {
        missingPrices += 1;
        partialValuation = true;
        continue;
      }

      const currency = normalizeCurrency(
        cursor.lastCurrency || listingMeta.get(listingId)?.currency || "UNKNOWN"
      );
      const priceValue =
        cursor.lastClose ?? cursor.lastAdjustedClose;
      const priceType = cursor.lastClose === null ? "adjusted" : "close";
      if (priceValue === null) {
        missingPrices += 1;
        partialValuation = true;
        continue;
      }
      let multiplier = 1;

      if (currency !== "EUR") {
        const fxRow = findLatestFxRow(fxByCurrency.get(currency) || [], day);
        if (!fxRow || !Number.isFinite(fxRow.rate) || fxRow.rate <= 0) {
          missingPrices += 1;
          partialValuation = true;
          continue;
        }

        if (toIsoDate(fxRow.weekEndDate) !== toIsoDate(day)) {
          console.warn("[FX][FALLBACK] valuation used prior weekly FX row", {
            userId,
            listingId,
            currency,
            requestedDate: toIsoDate(day),
            fxWeekEndDate: toIsoDate(fxRow.weekEndDate),
            observedDate: toIsoDate(fxRow.observedDate)
          });
        }

        multiplier = 1 / fxRow.rate;
        fxSnapshots.push({
          currency,
          weekEndDate: toIsoDate(fxRow.weekEndDate),
          rate: fxRow.rate
        });
      }

      priceSnapshots.push({
        listingId,
        priceDate: toIsoDate(cursor.lastDate),
        close: priceValue,
        priceType,
        currency
      });

      totalValueEur += qty * priceValue * multiplier;
    }

    const cumulativeReturnAmountEur = totalValueEur - cumulativeInvestedEur;
    const netExternalFlowEur = externalFlowByDate.get(toIsoDate(day)) ?? 0;
    const flowForReturn = -netExternalFlowEur;
    const periodCashFlows = flowForReturn === 0 ? [] : [{ amountEur: flowForReturn, occurredAt: day }];
    let periodReturnPct: number | null = null;
    let returnIndex: number | null = null;
    if (prevValue !== null && prevValue > 0) {
      periodReturnPct = modifiedDietzReturn({
        startValueEur: prevValue,
        endValueEur: totalValueEur,
        cashFlows: periodCashFlows,
        periodStart: prevDateForReturn ?? new Date(day.getTime() - ONE_DAY_MS),
        periodEnd: day,
        timingAssumption: DEFAULT_DIETZ_TIMING
      });
      if (periodReturnPct !== null) {
        returnIndex = (prevIndex ?? 100) * (1 + periodReturnPct);
        console.info("[INDEX][CHAIN]", {
          userId,
          period: "DAILY",
          date: toIsoDate(day),
          prevIndex,
          r: Number(periodReturnPct.toFixed(10)),
          index: Number(returnIndex.toFixed(10))
        });
      } else {
        returnIndex = prevIndex;
      }
    } else if (prevValue === null) {
      periodReturnPct = modifiedDietzReturn({
        startValueEur: 0,
        endValueEur: totalValueEur,
        cashFlows: periodCashFlows,
        periodStart: day,
        periodEnd: day,
        timingAssumption: FIRST_PERIOD_DIETZ_TIMING
      });
      if (periodReturnPct !== null) {
        returnIndex = 100 * (1 + periodReturnPct);
        console.info("[INDEX][SEED]", {
          userId,
          period: "DAILY",
          date: toIsoDate(day),
          A: 0,
          B: Number(totalValueEur.toFixed(8)),
          F: Number(flowForReturn.toFixed(8)),
          r: Number(periodReturnPct.toFixed(10)),
          index: Number(returnIndex.toFixed(10)),
          assumption: "FIRST_PERIOD_START"
        });
      } else {
        console.warn("[INDEX][SEED] unable to compute first-period return", {
          userId,
          period: "DAILY",
          date: toIsoDate(day),
          A: 0,
          B: Number(totalValueEur.toFixed(8)),
          F: Number(flowForReturn.toFixed(8)),
          assumption: "FIRST_PERIOD_START"
        });
      }
    } else {
      returnIndex = 100;
    }
    const cumulativeReturnPct = returnIndex === null ? null : returnIndex / 100 - 1;

    const inputHash = computeInputHash({
      version: DAILY_INPUT_VERSION,
      date: toIsoDate(day),
      holdings: holdingsSnapshot.sort((a, b) => a.listingId.localeCompare(b.listingId)),
      pricesUsed: priceSnapshots,
      fxUsed: fxSnapshots,
      externalFlowEur: Number(netExternalFlowEur.toFixed(8))
    });

    await prisma.dailyPortfolioValue.upsert({
      where: {
        userId_date: {
          userId,
          date: day
        }
      },
      update: {
        valueEur: Number(totalValueEur.toFixed(8)),
        cumulativeReturnAmountEur: Number(cumulativeReturnAmountEur.toFixed(8)),
        netExternalFlowEur: Number(netExternalFlowEur.toFixed(8)),
        periodReturnPct: periodReturnPct === null ? null : Number(periodReturnPct.toFixed(10)),
        returnIndex: returnIndex === null ? null : Number(returnIndex.toFixed(10)),
        cumulativeReturnPct: cumulativeReturnPct === null ? null : Number(cumulativeReturnPct.toFixed(10)),
        partialValuation,
        inputHash,
        computedAt
      },
      create: {
        userId,
        date: day,
        valueEur: Number(totalValueEur.toFixed(8)),
        cumulativeReturnAmountEur: Number(cumulativeReturnAmountEur.toFixed(8)),
        netExternalFlowEur: Number(netExternalFlowEur.toFixed(8)),
        periodReturnPct: periodReturnPct === null ? null : Number(periodReturnPct.toFixed(10)),
        returnIndex: returnIndex === null ? null : Number(returnIndex.toFixed(10)),
        cumulativeReturnPct: cumulativeReturnPct === null ? null : Number(cumulativeReturnPct.toFixed(10)),
        partialValuation,
        inputHash,
        computedAt
      }
    });

    points.push({
      date: day,
      valueEur: Number(totalValueEur.toFixed(8)),
      cumulativeReturnAmountEur: Number(cumulativeReturnAmountEur.toFixed(8)),
      netExternalFlowEur: Number(netExternalFlowEur.toFixed(8)),
      periodReturnPct: periodReturnPct === null ? null : Number(periodReturnPct.toFixed(10)),
      returnIndex: returnIndex === null ? null : Number(returnIndex.toFixed(10)),
      cumulativeReturnPct: cumulativeReturnPct === null ? null : Number(cumulativeReturnPct.toFixed(10)),
      partialValuation
    });
    prevValue = totalValueEur;
    prevIndex = returnIndex;
    prevDateForReturn = day;
  }

  console.info("[SYNC][DAILY_VALUE] computed", {
    userId,
    days: points.length,
    missingPrices
  });

  return {
    startDate,
    endDate,
    points,
    lastUpdatedAt: computedAt
  };
}
