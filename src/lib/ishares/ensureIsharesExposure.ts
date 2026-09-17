import { Prisma } from "@prisma/client";
import { resolveAdapterForInstrument } from "@/lib/etf/issuers/registry";
import type { AdapterInstrumentHints, IssuerKey } from "@/lib/etf/issuers/types";
import { NORMALIZER_VERSION, normalizeExposurePayload } from "@/lib/exposure/normalize";
import { prisma } from "@/lib/prisma";

const DEFAULT_TTL_DAYS = 30;
const FAILED_TTL_DAYS = 1;
const DEFAULT_REFRESH_DAYS = 30;

type EnsureContext = {
  userId?: string;
  instrumentIds?: string[];
  issuers?: IssuerKey[];
  force?: boolean;
  onlyMissing?: boolean;
};

export type EnsureIsharesExposureSummary = {
  selected: number;
  attempted: number;
  skippedFresh: number;
  skippedNotEligible: number;
  ready: number;
  failed: number;
};

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function toUpper(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase();
}

function resolveTickerHintFromListings(
  listings: Array<{ eodhdCode: string | null; isPrimary: boolean }>
) {
  const preferred = listings.find((listing) => listing.isPrimary && listing.eodhdCode) || listings.find((listing) => listing.eodhdCode);
  if (!preferred?.eodhdCode) return null;
  const [ticker] = preferred.eodhdCode.split(".");
  const normalized = toUpper(ticker);
  return normalized || null;
}

function toJson(value: unknown) {
  return value as Prisma.InputJsonValue;
}

function parseCachedProductUrl(meta: unknown) {
  if (!meta || typeof meta !== "object") return null;
  const record = meta as Record<string, unknown>;
  const factsheetUrl = record.factsheetUrl;
  if (typeof factsheetUrl === "string" && factsheetUrl.trim().length > 0) return factsheetUrl;
  const productUrl = record.productUrl;
  if (typeof productUrl === "string" && productUrl.trim().length > 0) return productUrl;
  return null;
}

function getTtlDays(issuer: string) {
  const perIssuer = Number(process.env[`${issuer}_EXPOSURE_TTL_DAYS`] || "");
  if (Number.isFinite(perIssuer) && perIssuer > 0) return perIssuer;
  const shared = Number(process.env.ETF_EXPOSURE_TTL_DAYS || process.env.ISHARES_EXPOSURE_TTL_DAYS || DEFAULT_TTL_DAYS);
  return Number.isFinite(shared) && shared > 0 ? shared : DEFAULT_TTL_DAYS;
}

function getRefreshDays() {
  const configured = Number(process.env.ETF_EXPOSURE_REFRESH_DAYS || DEFAULT_REFRESH_DAYS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REFRESH_DAYS;
}

function isSnapshotStale(updatedAt: Date, now: Date, refreshDays: number) {
  const cutoff = addDays(now, -refreshDays).getTime();
  return updatedAt.getTime() <= cutoff;
}

function toHints(instrument: {
  id: string;
  isin: string;
  name: string;
  displayName: string | null;
  issuer: string | null;
  securityType: string | null;
  securityType2: string | null;
  marketSector: string | null;
  profile: { trackedIndexName: string | null } | null;
  listings: Array<{ eodhdCode: string | null; isPrimary: boolean }>;
  exposureSnapshots: Array<{
    source: string;
    sourceMeta: Prisma.JsonValue | null;
    payload: Prisma.JsonValue | null;
    status: string;
    expiresAt: Date;
    updatedAt: Date;
  }>;
}): AdapterInstrumentHints {
  const adapter = resolveAdapterForInstrument({
    instrumentId: instrument.id,
    isin: instrument.isin,
    name: instrument.name,
    displayName: instrument.displayName,
    issuer: instrument.issuer,
    securityType: instrument.securityType,
    securityType2: instrument.securityType2,
    marketSector: instrument.marketSector,
    trackedIndexName: instrument.profile?.trackedIndexName || null,
    tickerHint: resolveTickerHintFromListings(instrument.listings),
    cachedProductUrl: null
  });
  const cachedFromSameSource = adapter
    ? instrument.exposureSnapshots.find((row) => row.source === adapter.source)
    : null;

  return {
    instrumentId: instrument.id,
    isin: instrument.isin,
    name: instrument.name,
    displayName: instrument.displayName,
    issuer: instrument.issuer,
    securityType: instrument.securityType,
    securityType2: instrument.securityType2,
    marketSector: instrument.marketSector,
    trackedIndexName: instrument.profile?.trackedIndexName || null,
    tickerHint: resolveTickerHintFromListings(instrument.listings),
    cachedProductUrl: parseCachedProductUrl(cachedFromSameSource?.sourceMeta)
  };
}

export async function ensureIsharesExposureSnapshots(
  context: EnsureContext = {}
): Promise<EnsureIsharesExposureSummary> {
  const now = new Date();
  const failedTtlDays = Number(process.env.ETF_EXPOSURE_FAILED_TTL_DAYS || FAILED_TTL_DAYS);
  const refreshDays = getRefreshDays();

  const issuerFilters = context.issuers?.length
    ? context.issuers
    : ["ISHARES", "VANGUARD", "SPDR", "COMGEST", "VANECK"] satisfies IssuerKey[];
  const issuerWhere: Prisma.InstrumentWhereInput["OR"] = [];
  if (issuerFilters.includes("ISHARES")) {
    issuerWhere.push(
      { issuer: { contains: "iShares", mode: "insensitive" } },
      { name: { contains: "iShares", mode: "insensitive" } },
      { displayName: { contains: "iShares", mode: "insensitive" } }
    );
  }
  if (issuerFilters.includes("VANGUARD")) {
    issuerWhere.push(
      { issuer: { contains: "Vanguard", mode: "insensitive" } },
      { name: { contains: "Vanguard", mode: "insensitive" } },
      { displayName: { contains: "Vanguard", mode: "insensitive" } }
    );
  }
  if (issuerFilters.includes("SPDR")) {
    issuerWhere.push(
      { issuer: { contains: "SPDR", mode: "insensitive" } },
      { name: { contains: "SPDR", mode: "insensitive" } },
      { displayName: { contains: "SPDR", mode: "insensitive" } },
      { issuer: { contains: "State Street", mode: "insensitive" } },
      { issuer: { contains: "SSGA", mode: "insensitive" } }
    );
  }
  if (issuerFilters.includes("COMGEST")) {
    issuerWhere.push(
      { issuer: { contains: "Comgest", mode: "insensitive" } },
      { name: { contains: "Comgest", mode: "insensitive" } },
      { displayName: { contains: "Comgest", mode: "insensitive" } }
    );
  }
  if (issuerFilters.includes("VANECK")) {
    issuerWhere.push(
      { issuer: { contains: "VanEck", mode: "insensitive" } },
      { name: { contains: "VanEck", mode: "insensitive" } },
      { displayName: { contains: "VanEck", mode: "insensitive" } }
    );
  }

  const instruments = await prisma.instrument.findMany({
    where: {
      ...(context.instrumentIds?.length ? { id: { in: context.instrumentIds } } : {}),
      ...(context.userId ? { transactions: { some: { userId: context.userId } } } : {}),
      OR: issuerWhere
    },
    select: {
      id: true,
      isin: true,
      name: true,
      displayName: true,
      issuer: true,
      securityType: true,
      securityType2: true,
      marketSector: true,
      listings: {
        select: {
          eodhdCode: true,
          isPrimary: true
        }
      },
      profile: {
        select: {
          trackedIndexName: true
        }
      },
      exposureSnapshots: {
        select: {
          source: true,
          status: true,
          expiresAt: true,
          updatedAt: true,
          sourceMeta: true,
          payload: true
        }
      }
    },
    orderBy: { isin: "asc" }
  });

  const summary: EnsureIsharesExposureSummary = {
    selected: instruments.length,
    attempted: 0,
    skippedFresh: 0,
    skippedNotEligible: 0,
    ready: 0,
    failed: 0
  };

  for (const instrument of instruments) {
    const hints = toHints(instrument);
    const adapter = resolveAdapterForInstrument(hints);
    if (!adapter) {
      summary.skippedNotEligible += 1;
      continue;
    }
    if (context.issuers?.length && !context.issuers.includes(adapter.issuer)) {
      summary.skippedNotEligible += 1;
      continue;
    }

    const existing = instrument.exposureSnapshots.find((row) => row.source === adapter.source);
    if (context.onlyMissing && existing?.status === "READY" && existing.payload) {
      summary.skippedFresh += 1;
      continue;
    }
    const shouldSkipByAge =
      existing &&
      !context.force &&
      (existing.status === "READY"
        ? !context.onlyMissing && !isSnapshotStale(existing.updatedAt, now, refreshDays)
        : existing.expiresAt > now);
    if (shouldSkipByAge) {
      summary.skippedFresh += 1;
      console.info(`${`[${adapter.issuer}]`}[SKIP] snapshot still within refresh window`, {
        instrumentId: instrument.id,
        isin: instrument.isin,
        source: adapter.source,
        updatedAt: existing.updatedAt.toISOString(),
        refreshDays
      });
      continue;
    }

    summary.attempted += 1;
    const logPrefix = `[${adapter.issuer}]`;

    try {
      console.info(`${logPrefix}[RESOLVE] start`, {
        instrumentId: instrument.id,
        isin: instrument.isin,
        tickerHint: hints.tickerHint
      });
      const resolved =
        adapter.issuer === "ISHARES"
          ? {
              issuer: adapter.issuer,
              isin: instrument.isin,
              locale: null,
              productUrl: hints.cachedProductUrl || "",
              factsheetUrl: null,
              pageHtml: null
            }
          : await adapter.resolveByIsin(instrument.isin, hints);
      if (!resolved) {
        throw new Error("Unable to resolve issuer fund page from ISIN.");
      }

      const result = await adapter.fetchExposure(resolved, hints);
      if (!result.payload.country.length && !result.payload.sector.length) {
        throw new Error("Provider returned no exposure data.");
      }
      const expiresAt = addDays(now, getTtlDays(adapter.issuer));
      const normalized = normalizeExposurePayload(result.payload);

      await prisma.instrumentExposureSnapshot.upsert({
        where: {
          instrumentId_source: {
            instrumentId: instrument.id,
            source: adapter.source
          }
        },
        update: {
          status: "READY",
          asOfDate: result.asOfDate ?? null,
          fetchedAt: now,
          expiresAt,
          payload: toJson(result.payload),
          normalizedPayload: toJson(normalized.normalizedPayload),
          normalizerVersion: NORMALIZER_VERSION,
          coverageMeta: toJson(normalized.coverageMeta),
          sourceMeta: toJson(result.sourceMeta),
          errorMessage: null
        },
        create: {
          instrumentId: instrument.id,
          source: adapter.source,
          status: "READY",
          asOfDate: result.asOfDate ?? null,
          fetchedAt: now,
          expiresAt,
          payload: toJson(result.payload),
          normalizedPayload: toJson(normalized.normalizedPayload),
          normalizerVersion: NORMALIZER_VERSION,
          coverageMeta: toJson(normalized.coverageMeta),
          sourceMeta: toJson(result.sourceMeta),
          errorMessage: null
        }
      });

      summary.ready += 1;
      console.info(`${logPrefix}[UPSERT] ready`, {
        instrumentId: instrument.id,
        isin: instrument.isin,
        productUrl:
          typeof (result.sourceMeta as Record<string, unknown>)?.productUrl === "string"
            ? (result.sourceMeta as Record<string, string>).productUrl
            : null,
        asOfDate: result.asOfDate ? result.asOfDate.toISOString().slice(0, 10) : null,
        countries: result.payload.country.length,
        sectors: result.payload.sector.length,
        expiresAt: expiresAt.toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const expiresAt = addDays(now, failedTtlDays);

      // A provider outage must not erase the last successful exposure breakdown.
      if (existing?.status === "READY" && existing.payload) {
        summary.failed += 1;
        console.warn(`${logPrefix}[REFRESH] keeping last successful exposure`, {
          instrumentId: instrument.id, error: message
        });
        continue;
      }

      await prisma.instrumentExposureSnapshot.upsert({
        where: {
          instrumentId_source: {
            instrumentId: instrument.id,
            source: adapter.source
          }
        },
        update: {
          status: "FAILED",
          fetchedAt: now,
          expiresAt,
          payload: Prisma.JsonNull,
          normalizedPayload: Prisma.JsonNull,
          normalizerVersion: null,
          coverageMeta: Prisma.JsonNull,
          sourceMeta: toJson({ reason: "FETCH_FAILED", issuer: adapter.issuer }),
          errorMessage: message
        },
        create: {
          instrumentId: instrument.id,
          source: adapter.source,
          status: "FAILED",
          fetchedAt: now,
          expiresAt,
          payload: Prisma.JsonNull,
          normalizedPayload: Prisma.JsonNull,
          normalizerVersion: null,
          coverageMeta: Prisma.JsonNull,
          sourceMeta: toJson({ reason: "FETCH_FAILED", issuer: adapter.issuer }),
          errorMessage: message
        }
      });

      summary.failed += 1;
      console.warn(`${logPrefix}[UPSERT] failed`, {
        instrumentId: instrument.id,
        isin: instrument.isin,
        error: message,
        retryAfter: expiresAt.toISOString()
      });
    }
  }

  return summary;
}

export function kickoffIsharesExposureSnapshots(
  context: EnsureContext = {}
) {
  void ensureIsharesExposureSnapshots(context)
    .then((summary) => {
      console.info("[ETF][DONE]", {
        userId: context.userId,
        selected: summary.selected,
        attempted: summary.attempted,
        skippedFresh: summary.skippedFresh,
        skippedNotEligible: summary.skippedNotEligible,
        ready: summary.ready,
        failed: summary.failed
      });
    })
    .catch((error) => {
      console.error("[ETF][DONE] enrichment failed", {
        userId: context.userId,
        instrumentIds: context.instrumentIds,
        message: error instanceof Error ? error.message : String(error)
      });
    });
}
