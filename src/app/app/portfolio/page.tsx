import { redirect } from "next/navigation";
import { format, startOfDay, startOfYear } from "date-fns";
import { ClosedPositionsTable, ClosedPositionRow } from "@/components/ClosedPositionsTable";
import {
  OpenPositionsTable,
  OpenPositionRow,
  OpenPositionColumn,
  OpenPositionsTotals
} from "@/components/OpenPositionsTable";
import { PortfolioExposureCharts } from "@/components/PortfolioExposureCharts";
import { PortfolioSetupScreen } from "@/components/PortfolioSetupScreen";
import { PageContainer } from "@/components/layout/PageContainer";
import { Section } from "@/components/layout/Section";
import { Card } from "@/components/layout/Card";
import { getCurrentAppUser } from "@/lib/auth/appUser";
import { getFxRateForWeek } from "@/lib/fx/convert";
import { getPortfolioSetupStatus, shouldBlockPortfolioAnalytics } from "@/lib/portfolio/setupStatus";
import { prisma } from "@/lib/prisma";

type SortKey =
  | "name"
  | "isin"
  | "quantity"
  | "latestAdjCloseEur"
  | "marketValueEur"
  | "totalPnlEur"
  | "ytdPnlEur"
  | "ytdPct";

type SortDir = "asc" | "desc";

function toSingleQueryParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function compareNullableNumbers(a: number | null, b: number | null) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  return Number(value);
}

function sumNullable(values: Array<number | null>) {
  let total = 0;
  let hasValue = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
    hasValue = true;
  }
  return hasValue ? total : null;
}

function buildProfileTags(profile: { assetType: string; region: string; trackedIndexName: string | null } | null) {
  if (!profile) return [];
  const tags: string[] = [];
  if (profile.assetType && profile.assetType !== "OTHER") tags.push(profile.assetType);
  if (profile.region && profile.region !== "UNKNOWN") tags.push(profile.region);
  if (profile.trackedIndexName) tags.push(profile.trackedIndexName);
  return tags;
}

function buildClosedPositions(
  transactions: Array<{
    instrumentId: string;
    quantity: unknown;
    tradeAt: Date;
    price: unknown;
    valueEur: unknown;
    instrument: { name: string; displayName: string | null; isin: string };
  }>,
  pricedInstrumentIds: Set<string>
): ClosedPositionRow[] {
  const map = new Map<
    string,
    {
      name: string;
      isin: string;
      netQty: number;
      soldQty: number;
      buyCostEur: number | null;
      sellProceedsEur: number | null;
      lastTradeAt: Date;
    }
  >();

  for (const tx of transactions) {
    const qty = toNumber(tx.quantity);
    const txPrice = tx.price === null || tx.price === undefined ? null : toNumber(tx.price);
    const txValueEur = tx.valueEur === null || tx.valueEur === undefined ? null : toNumber(tx.valueEur);

    const current = map.get(tx.instrumentId) || {
      name: tx.instrument.displayName || tx.instrument.name,
      isin: tx.instrument.isin,
      netQty: 0,
      soldQty: 0,
      buyCostEur: 0,
      sellProceedsEur: 0,
      lastTradeAt: tx.tradeAt
    };

    current.netQty += qty;

    if (qty > 0) {
      const buyLegEur = txValueEur !== null && Number.isFinite(txValueEur) ? Math.abs(txValueEur) : null;
      if (buyLegEur !== null) {
        if (current.buyCostEur !== null) current.buyCostEur += buyLegEur;
      } else if (txPrice !== null && Number.isFinite(txPrice) && current.buyCostEur !== null) {
        current.buyCostEur += qty * txPrice;
      } else {
        current.buyCostEur = null;
      }
    }

    if (qty < 0) {
      const sold = Math.abs(qty);
      current.soldQty += sold;
      const sellLegEur = txValueEur !== null && Number.isFinite(txValueEur) ? Math.abs(txValueEur) : null;
      if (sellLegEur !== null) {
        if (current.sellProceedsEur !== null) current.sellProceedsEur += sellLegEur;
      } else if (txPrice !== null && Number.isFinite(txPrice) && current.sellProceedsEur !== null) {
        current.sellProceedsEur += sold * txPrice;
      } else {
        current.sellProceedsEur = null;
      }
    }

    if (tx.tradeAt > current.lastTradeAt) current.lastTradeAt = tx.tradeAt;
    map.set(tx.instrumentId, current);
  }

  return Array.from(map.entries())
    .filter(([, row]) => Math.abs(row.netQty) < 1e-8 && row.soldQty > 0)
    .map(([instrumentId, row]) => {
      const pnl =
        row.buyCostEur === null || row.sellProceedsEur === null ? null : row.sellProceedsEur - row.buyCostEur;
      const pnlPct = pnl === null || !row.buyCostEur || row.buyCostEur === 0 ? null : pnl / row.buyCostEur;

      return {
        instrumentId,
        name: row.name,
        isin: row.isin,
        buyCostEur: row.buyCostEur,
        sellProceedsEur: row.sellProceedsEur,
        pnl,
        pnlPct,
        closedAt: row.lastTradeAt,
        priceAvailabilityMessage: pricedInstrumentIds.has(instrumentId) ? null : "No prices available"
      };
    })
    .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());
}

export default async function PortfolioPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const user = await getCurrentAppUser();
  if (!user) redirect("/sign-in");

  const setupStatus = await getPortfolioSetupStatus(user.id);
  if (shouldBlockPortfolioAnalytics(setupStatus)) {
    return (
      <PageContainer>
        <PortfolioSetupScreen initialStatus={setupStatus} />
      </PageContainer>
    );
  }

  const transactions = await prisma.transaction.findMany({
    where: { userId: user.id },
    include: {
      instrument: {
        include: {
          listings: true,
          profile: true
        }
      },
      listing: true
    },
    orderBy: { tradeAt: "asc" }
  });

  if (!transactions.length) {
    return (
      <PageContainer>
        <Section>
          <Card>
            <div className="section-title">Portfolio</div>
            <h1>Portfolio</h1>
            <p>No transactions yet. Import your DeGiro CSV to get started.</p>
          </Card>
        </Section>
      </PageContainer>
    );
  }

  const firstTransactionDate = startOfDay(transactions[0].tradeAt);
  const today = startOfDay(new Date());
  const ytdStart = startOfYear(today);

  const byInstrument = new Map<
    string,
    {
      instrumentId: string;
      isin: string;
      name: string;
      qty: number;
      fallbackListingId: string | null;
      listings: typeof transactions[number]["instrument"]["listings"];
      profile: typeof transactions[number]["instrument"]["profile"];
    }
  >();

  for (const tx of transactions) {
    const key = tx.instrumentId;
    const entry = byInstrument.get(key) ?? {
      instrumentId: tx.instrumentId,
      isin: tx.instrument.isin,
      name: tx.instrument.displayName || tx.instrument.name,
      qty: 0,
      fallbackListingId: tx.listingId,
      listings: tx.instrument.listings,
      profile: tx.instrument.profile
    };
    entry.qty += toNumber(tx.quantity);
    if (!entry.fallbackListingId && tx.listingId) {
      entry.fallbackListingId = tx.listingId;
    }
    byInstrument.set(key, entry);
  }

  const chosenListingByInstrument = new Map<string, string>();
  const chosenListingIds = new Set<string>();

  for (const entry of byInstrument.values()) {
    const primaryMapped = entry.listings.find((l) => l.isPrimary && l.mappingStatus === "MAPPED" && l.eodhdCode);
    const anyMapped = entry.listings.find((l) => l.mappingStatus === "MAPPED" && l.eodhdCode);
    const fallback = entry.listings.find((l) => l.id === entry.fallbackListingId && l.eodhdCode);

    const chosen = primaryMapped || fallback || anyMapped || null;
    if (!chosen) {
      continue;
    }

    chosenListingByInstrument.set(entry.instrumentId, chosen.id);
    chosenListingIds.add(chosen.id);
  }

  const prices = await prisma.dailyListingPrice.findMany({
    where: {
      listingId: { in: Array.from(chosenListingIds) },
      date: { gte: firstTransactionDate }
    },
    orderBy: [{ listingId: "asc" }, { date: "asc" }]
  });

  const pricesByListing = new Map<string, Array<{ date: Date; adjClose: number; currency: string }>>();
  for (const price of prices) {
    const list = pricesByListing.get(price.listingId) ?? [];
    list.push({
      date: startOfDay(price.date),
      adjClose: toNumber(price.adjustedClose),
      currency: price.currency || "EUR"
    });
    pricesByListing.set(price.listingId, list);
  }
  const pricedInstrumentIds = new Set<string>();
  for (const entry of byInstrument.values()) {
    const listingId = chosenListingByInstrument.get(entry.instrumentId);
    if (!listingId) continue;
    if ((pricesByListing.get(listingId)?.length ?? 0) > 0) {
      pricedInstrumentIds.add(entry.instrumentId);
    }
  }

  const closedPositions = buildClosedPositions(transactions, pricedInstrumentIds);

  const costBasisEurByInstrument = new Map<string, { buyCostEur: number | null; sellProceedsEur: number | null }>();

  for (const tx of transactions) {
    const qty = toNumber(tx.quantity);
    const valueEur = tx.valueEur === null || tx.valueEur === undefined ? null : toNumber(tx.valueEur);

    const basis = costBasisEurByInstrument.get(tx.instrumentId) || { buyCostEur: 0, sellProceedsEur: 0 };

    if (qty > 0) {
      if (valueEur !== null && Number.isFinite(valueEur)) {
        if (basis.buyCostEur !== null) basis.buyCostEur += Math.abs(valueEur);
      } else {
        basis.buyCostEur = null;
      }
    }

    if (qty < 0) {
      if (valueEur !== null && Number.isFinite(valueEur)) {
        if (basis.sellProceedsEur !== null) basis.sellProceedsEur += Math.abs(valueEur);
      } else {
        basis.sellProceedsEur = null;
      }
    }

    costBasisEurByInstrument.set(tx.instrumentId, basis);
  }

  // Collect all unique FX lookups needed across all positions, then fetch in parallel.
  type FxCacheKey = string; // "yyyy-MM-dd:CURRENCY"
  const fxLookups = new Map<FxCacheKey, { date: Date; currency: string }>();

  for (const entry of byInstrument.values()) {
    const listingId = chosenListingByInstrument.get(entry.instrumentId);
    if (!listingId || entry.qty === 0) continue;

    const series = pricesByListing.get(listingId) ?? [];
    const latest = series[series.length - 1] ?? null;
    const ytdStartPrice = series.find((point) => point.date.getTime() >= ytdStart.getTime()) ?? null;

    if (latest) {
      const key: FxCacheKey = `${format(latest.date, "yyyy-MM-dd")}:${latest.currency}`;
      if (!fxLookups.has(key)) fxLookups.set(key, { date: latest.date, currency: latest.currency });
    }
    if (ytdStartPrice) {
      const key: FxCacheKey = `${format(ytdStartPrice.date, "yyyy-MM-dd")}:${ytdStartPrice.currency}`;
      if (!fxLookups.has(key)) fxLookups.set(key, { date: ytdStartPrice.date, currency: ytdStartPrice.currency });
    }
  }

  const fxCache = new Map<FxCacheKey, number | null>();
  await Promise.all(
    Array.from(fxLookups.entries()).map(async ([key, { date, currency }]) => {
      try {
        fxCache.set(key, await getFxRateForWeek(date, currency));
      } catch {
        fxCache.set(key, null);
      }
    })
  );

  const rows = [] as OpenPositionRow[];

  for (const entry of byInstrument.values()) {
    const listingId = chosenListingByInstrument.get(entry.instrumentId);
    if (entry.qty === 0) continue;

    if (!listingId) {
      rows.push({
        name: entry.name,
        isin: entry.isin,
        quantity: entry.qty,
        latestAdjCloseEur: null,
        marketValueEur: null,
        totalPnlEur: null,
        ytdPnlEur: null,
        ytdPct: null,
        profileTags: buildProfileTags(entry.profile),
        priceAvailabilityMessage: "No prices available"
      });
      continue;
    }

    const series = pricesByListing.get(listingId) ?? [];
    const latest = series[series.length - 1] ?? null;
    const ytdStartPrice = series.find((point) => point.date.getTime() >= ytdStart.getTime()) ?? null;

    const latestAdjClose = latest?.adjClose ?? null;

    let latestFx: number | null = null;
    if (latest && latestAdjClose !== null) {
      const key: FxCacheKey = `${format(latest.date, "yyyy-MM-dd")}:${latest.currency}`;
      latestFx = fxCache.get(key) ?? null;
      if (latestFx === null) {
        console.warn("[VAL][EUR] missing latest FX conversion for position", {
          userId: user.id,
          instrumentId: entry.instrumentId,
          isin: entry.isin,
          listingId,
          currency: latest.currency,
          weekEndDate: format(latest.date, "yyyy-MM-dd")
        });
      }
    }

    const latestAdjCloseEur = latestAdjClose === null || latestFx === null ? null : latestAdjClose * latestFx;
    const marketValueEur = latestAdjClose === null || latestFx === null ? null : entry.qty * latestAdjClose * latestFx;

    const basis = costBasisEurByInstrument.get(entry.instrumentId) || { buyCostEur: null, sellProceedsEur: null };
    const netInvestedEur =
      basis.buyCostEur === null || basis.sellProceedsEur === null
        ? null
        : basis.buyCostEur - basis.sellProceedsEur;
    const totalPnlEur = marketValueEur === null || netInvestedEur === null ? null : marketValueEur - netInvestedEur;

    let ytdPnlEur: number | null = null;
    let ytdPct: number | null = null;

    if (latestAdjClose !== null && ytdStartPrice && ytdStartPrice.adjClose !== 0 && latestFx !== null) {
      const ytdKey: FxCacheKey = `${format(ytdStartPrice.date, "yyyy-MM-dd")}:${ytdStartPrice.currency}`;
      const ytdFx = fxCache.get(ytdKey) ?? null;
      if (ytdFx !== null) {
        const latestUnitEur = latestAdjClose * latestFx;
        const ytdUnitEur = ytdStartPrice.adjClose * ytdFx;
        ytdPnlEur = entry.qty * (latestUnitEur - ytdUnitEur);
        ytdPct = ytdUnitEur === 0 ? null : latestUnitEur / ytdUnitEur - 1;
      } else {
        console.warn("[VAL][EUR] missing YTD FX conversion for position", {
          userId: user.id,
          instrumentId: entry.instrumentId,
          isin: entry.isin,
          listingId,
          latestCurrency: latest?.currency,
          ytdCurrency: ytdStartPrice.currency,
          latestWeekEndDate: latest ? format(latest.date, "yyyy-MM-dd") : null,
          ytdWeekEndDate: format(ytdStartPrice.date, "yyyy-MM-dd")
        });
      }
    }

    rows.push({
      name: entry.name,
      isin: entry.isin,
      quantity: entry.qty,
      latestAdjCloseEur,
      marketValueEur,
      totalPnlEur,
      ytdPnlEur,
      ytdPct,
      profileTags: buildProfileTags(entry.profile),
      priceAvailabilityMessage: latestAdjClose === null ? "No prices available" : null
    });
  }

  const rawSort = toSingleQueryParam(searchParams?.sort);
  const rawDir = toSingleQueryParam(searchParams?.dir);

  const allowedSorts: SortKey[] = [
    "name",
    "isin",
    "quantity",
    "latestAdjCloseEur",
    "marketValueEur",
    "totalPnlEur",
    "ytdPnlEur",
    "ytdPct"
  ];

  const sortKey: SortKey = allowedSorts.includes(rawSort as SortKey) ? (rawSort as SortKey) : "name";
  const sortDir: SortDir = rawDir === "desc" ? "desc" : "asc";
  const direction = sortDir === "asc" ? 1 : -1;

  rows.sort((a, b) => {
    switch (sortKey) {
      case "name":
        return direction * a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      case "isin":
        return direction * a.isin.localeCompare(b.isin, undefined, { sensitivity: "base" });
      case "quantity":
        return direction * (a.quantity - b.quantity);
      case "latestAdjCloseEur":
        return direction * compareNullableNumbers(a.latestAdjCloseEur, b.latestAdjCloseEur);
      case "marketValueEur":
        return direction * compareNullableNumbers(a.marketValueEur, b.marketValueEur);
      case "totalPnlEur":
        return direction * compareNullableNumbers(a.totalPnlEur, b.totalPnlEur);
      case "ytdPnlEur":
        return direction * compareNullableNumbers(a.ytdPnlEur, b.ytdPnlEur);
      case "ytdPct":
        return direction * compareNullableNumbers(a.ytdPct, b.ytdPct);
      default:
        return 0;
    }
  });

  const columns: OpenPositionColumn[] = [
    { key: "name", label: "Product" },
    { key: "isin", label: "ISIN" },
    { key: "quantity", label: "Qty" },
    { key: "latestAdjCloseEur", label: "Latest adj close (EUR)" },
    { key: "marketValueEur", label: "Market value (EUR)" },
    { key: "totalPnlEur", label: "P&L (EUR)" },
    { key: "ytdPnlEur", label: "YTD P&L (EUR)" },
    { key: "ytdPct", label: "% YTD" }
  ];

  const marketValueTotalEur = sumNullable(rows.map((row) => row.marketValueEur));
  const totalPnlTotalEur = sumNullable(rows.map((row) => row.totalPnlEur));
  const ytdPnlTotalEur = sumNullable(rows.map((row) => row.ytdPnlEur));
  const ytdBaseValueEur =
    marketValueTotalEur !== null && ytdPnlTotalEur !== null ? marketValueTotalEur - ytdPnlTotalEur : null;
  const ytdPctTotal =
    ytdBaseValueEur !== null && ytdBaseValueEur !== 0 && ytdPnlTotalEur !== null
      ? ytdPnlTotalEur / ytdBaseValueEur
      : null;
  const totals: OpenPositionsTotals = {
    positionCount: rows.length,
    marketValueEur: marketValueTotalEur,
    totalPnlEur: totalPnlTotalEur,
    ytdPnlEur: ytdPnlTotalEur,
    ytdPct: ytdPctTotal
  };
  const noPriceCount = rows.filter((row) => row.priceAvailabilityMessage !== null).length;

  return (
    <PageContainer>
      <div className="page-stack">
        <div className="page-head">
          <div>
            <h1 className="page-title">Portfolio</h1>
          </div>
        </div>

        <Section>
          <Card>
            <PortfolioExposureCharts />
          </Card>
        </Section>

        <Section>
          <Card>
            <h2 className="card-title">Open positions</h2>
            {noPriceCount > 0 ? (
              <small className="warning-text">
                {noPriceCount} position{noPriceCount === 1 ? "" : "s"} currently have no price coverage and are shown as
                {" "}No prices available.
              </small>
            ) : null}
            <OpenPositionsTable
              rows={rows}
              columns={columns}
              sortKey={sortKey}
              sortDir={sortDir}
              basePath="/app/portfolio"
              totals={totals}
            />
          </Card>
        </Section>

        <Section>
          <Card>
            <div className="section-title">Realized</div>
            <h2 className="card-title">Closed positions</h2>
            <ClosedPositionsTable rows={closedPositions} />
          </Card>
        </Section>
      </div>
    </PageContainer>
  );
}
