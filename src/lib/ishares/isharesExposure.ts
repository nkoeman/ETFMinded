import crypto from "crypto";
import { inferSingleCountryExposure } from "@/lib/etf/exposure/inferSingleCountryExposure";
import { extractPdfText } from "@/lib/etf/issuers/pdfText";
import { isharesGetBytes } from "@/lib/ishares/isharesClient";
import type { IsharesRequestContext } from "@/lib/ishares/isharesClient";
import { resolveIsharesFundByIsin } from "@/lib/ishares/isharesResolve";
import { fetchIsharesProductData } from "@/lib/ishares/isharesProductData";
import type {
  ExposureRowCountry,
  ExposureRowSector,
  IsharesExposurePayload,
  IsharesExposureResult
} from "@/lib/ishares/types";

const DATE_PATTERN = /as (?:at|of)\s*:?\s*([0-9]{1,2}[\/\-][A-Za-z]{3}[\/\-][0-9]{4})/i;
function parseJsArray<T>(value: string): T[] {
  const normalized = value
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    .replace(/\n/g, " ");
  return JSON.parse(normalized) as T[];
}

function extractDataTable(pageHtml: string, varName: string) {
  const regex = new RegExp(`var\\s+${varName}\\s*=\\s*(\\[[\\s\\S]*?\\]);`, "i");
  const match = regex.exec(pageHtml);
  if (!match?.[1]) return [];
  return parseJsArray<{ name: string; value: string }>(match[1]);
}

function parseDateLabel(value: string | null) {
  if (!value) return null;
  const normalized = value.replace(/-/g, "/").trim();
  const [day, monthText, year] = normalized.split("/");
  if (!day || !monthText || !year) return null;
  const monthMap: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };
  const month = monthMap[monthText.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  const parsed = new Date(Date.UTC(Number(year), month, Number(day)));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractAsOfDate(pageHtml: string) {
  const sectionMatch = /id="exposureBreakdowns"([\s\S]*?)(?:<!-- COMPONENT: PPV3\/Benchmark Breakdowns -->|<\/div>\s*<\/div>\s*<\/div>)/i.exec(
    pageHtml
  );
  const scope = sectionMatch?.[1] || pageHtml;
  const dateMatch = DATE_PATTERN.exec(scope);
  return parseDateLabel(dateMatch?.[1] || null);
}

function toWeight(value: string | number) {
  const normalized = String(value).replace(",", ".").trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0) return null;
  return parsed / 100;
}

function cleanLabel(value: string) {
  return String(value || "");
}

function normalizeSectorRows(rows: Array<{ name: string; value: string }>): ExposureRowSector[] {
  return rows
    .map((row) => {
      const sector = cleanLabel(row.name);
      const weight = toWeight(row.value);
      if (!sector || weight === null) return null;
      return {
        sector,
        weight
      };
    })
    .filter((row): row is ExposureRowSector => Boolean(row));
}

function normalizeCountryRows(rows: Array<{ name: string; value: string }>): ExposureRowCountry[] {
  return rows
    .map((row) => {
      const country = cleanLabel(row.name);
      const weight = toWeight(row.value);
      if (!country || weight === null) return null;
      return {
        country,
        weight
      };
    })
    .filter((row): row is ExposureRowCountry => Boolean(row));
}

function sumWeights(rows: Array<{ weight: number }>) {
  return rows.reduce((acc, row) => acc + row.weight, 0);
}

function hasValidCountryExposure(rows: ExposureRowCountry[]) {
  if (!rows.length) return false;
  return sumWeights(rows) >= 0.9;
}

function applySingleCountryFallback(
  payload: IsharesExposurePayload,
  options: {
    instrumentId?: string | null;
    displayName?: string | null;
    benchmarkName?: string | null;
    indexName?: string | null;
  }
) {
  const instrumentId = options.instrumentId || "unknown";
  if (hasValidCountryExposure(payload.country)) {
    console.info("[ETF][EXPOSURE] country_present -> keep factsheet country exposure", {
      instrumentId,
      countryRows: payload.country.length,
      countryTotal: sumWeights(payload.country)
    });
    return {
      payload,
      meta: {
        applied: false,
        reason: "COUNTRY_PRESENT"
      }
    };
  }

  const inference = inferSingleCountryExposure({
    displayName: options.displayName,
    benchmarkName: options.benchmarkName,
    indexName: options.indexName
  });

  if (!inference || inference.confidence < 70) {
    console.warn("[ETF][EXPOSURE] country_missing -> inference_skipped ambiguous", {
      instrumentId
    });
    return {
      payload,
      meta: {
        applied: false,
        reason: "AMBIGUOUS_OR_LOW_CONFIDENCE"
      }
    };
  }

  const inferredCountry = inference.countryName || inference.countryCode;
  console.info("[ETF][EXPOSURE] country_missing -> inferred_single_country", {
    instrumentId,
    source: inference.source,
    country: inferredCountry
  });

  return {
    payload: {
      ...payload,
      country: [{ country: inferredCountry, weight: 1 }]
    },
    meta: {
      applied: true,
      source: inference.source,
      confidence: inference.confidence,
      countryCode: inference.countryCode,
      countryName: inference.countryName || null
    }
  };
}

function sanitizeText(text: string) {
  return text.replace(/\u00a0/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSectionRows(lines: string[]): Array<{ label: string; weight: number }> {
  const rows: Array<{ label: string; weight: number }> = [];
  const rowPattern = /(.+?)\s+([0-9]{1,3}(?:[.,][0-9]{1,2})?)%?(?=\s+[A-Z]|$)/g;

  for (const rawLine of lines) {
    const line = sanitizeText(rawLine);
    if (!line) continue;
    rowPattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = rowPattern.exec(line)) !== null) {
      const label = match[1].trim();
      const weight = toWeight(match[2]);
      if (!label || weight === null) continue;
      rows.push({ label, weight });
    }
  }

  return rows;
}

function extractSectionLines(
  lines: string[],
  startMarkers: RegExp[],
  stopMarkers: RegExp[]
) {
  const collected: string[] = [];
  let active = false;

  for (const rawLine of lines) {
    const line = sanitizeText(rawLine);
    if (!line) continue;

    if (!active) {
      const matchedMarker = startMarkers.find((marker) => {
        marker.lastIndex = 0;
        return marker.test(line);
      });

      if (matchedMarker) {
        matchedMarker.lastIndex = 0;
        const markerMatch = matchedMarker.exec(line);
        active = true;

        const trailing = markerMatch
          ? line.slice(markerMatch.index + markerMatch[0].length).trim()
          : "";
        if (trailing) {
          collected.push(trailing);
        }
        continue;
      }
    }

    if (!active) continue;
    if (stopMarkers.some((marker) => marker.test(line))) break;

    collected.push(line);
  }

  return collected;
}

function extractSectionRowsByRegex(
  text: string,
  startMarkers: string[],
  stopMarkers: string[]
): Array<{ label: string; weight: number }> {
  const normalizedText = sanitizeText(text);
  const lowerText = normalizedText.toLowerCase();
  let startIndex = -1;

  for (const marker of startMarkers) {
    const index = lowerText.indexOf(marker.toLowerCase());
    if (index !== -1 && (startIndex === -1 || index < startIndex)) {
      startIndex = index;
    }
  }

  if (startIndex === -1) return [];

  let endIndex = lowerText.length;
  for (const marker of stopMarkers) {
    const index = lowerText.indexOf(marker.toLowerCase(), startIndex + 1);
    if (index !== -1 && index < endIndex) {
      endIndex = index;
    }
  }

  const sectionText = normalizedText.slice(startIndex, endIndex);
  const numberPattern = /([0-9]{1,3}(?:[.,][0-9]{1,2})?)%?/g;
  const rows: Array<{ label: string; weight: number }> = [];

  const startMarkerPattern = new RegExp(
    `^(?:${startMarkers.map((marker) => escapeRegExp(marker)).join("|")})`,
    "i"
  );

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = numberPattern.exec(sectionText)) !== null) {
    let label = sectionText.slice(cursor, match.index);
    if (cursor === 0) {
      label = label.replace(startMarkerPattern, "");
    }
    label = label.trim();
    const weight = toWeight(match[1]);
    if (!label || weight === null) continue;
    rows.push({ label, weight });
    cursor = match.index + match[0].length;
  }

  return rows;
}

function extractRowBlocks(lines: string[]) {
  const blocks: Array<Array<{ label: string; weight: number }>> = [];
  let current: Array<{ label: string; weight: number }> = [];

  for (const rawLine of lines) {
    const line = sanitizeText(rawLine);
    if (!line) {
      if (current.length) {
        blocks.push(current);
        current = [];
      }
      continue;
    }

    const rows = parseSectionRows([line]);
    if (rows.length) {
      current.push(...rows);
      continue;
    }

    if (current.length) {
      blocks.push(current);
      current = [];
    }
  }

  if (current.length) {
    blocks.push(current);
  }

  return blocks;
}

export function parseIsharesFactsheetText(
  text: string
): Pick<IsharesExposureResult, "asOfDate" | "payload" | "sourceMeta"> {
  const dateMatch = DATE_PATTERN.exec(text);
  const asOfDate = parseDateLabel(dateMatch?.[1] || null);
  const lines = text.split(/\r?\n/);
  const rowBlocks = extractRowBlocks(lines);
  const sectionStopMarkers = [
    /market allocation/i,
    /country breakdown/i,
    /country exposure/i,
    /geographical/i,
    /geographic/i,
    /top [0-9]+ holdings/i,
    /holdings/i,
    /fund benchmark/i,
    /trading information/i,
    /risk indicator/i
  ];
  const sectorSectionLines = extractSectionLines(
    lines,
    [/weighted exposure/i, /sector allocation/i, /sector exposure/i, /industry allocation/i, /industry exposure/i],
    sectionStopMarkers
  );
  const countrySectionLines = extractSectionLines(
    lines,
    [/market allocation/i, /country breakdown/i, /country exposure/i, /geographical/i, /geographic/i],
    [/weighted exposure/i, /sector allocation/i, /sector exposure/i, /industry allocation/i, /industry exposure/i, /top [0-9]+ holdings/i, /holdings/i, /fund benchmark/i, /trading information/i, /risk indicator/i]
  );

  let sectorRows = parseSectionRows(sectorSectionLines).map((row) => ({
    sector: row.label,
    weight: row.weight
  }));
  let countryRows = parseSectionRows(countrySectionLines).map((row) => ({
    country: row.label,
    weight: row.weight
  }));

  const sectorFallbackRows =
    sectorRows.length === 0
      ? extractSectionRowsByRegex(
          text,
          ["weighted exposure", "sector allocation", "sector exposure", "industry allocation", "industry exposure"],
          ["market allocation", "country breakdown", "country exposure", "geographical", "geographic", "top holdings", "fund benchmark", "trading information", "risk indicator"]
        )
      : [];
  if (sectorFallbackRows.length > 0) {
    sectorRows = sectorFallbackRows.map((row) => ({
      sector: row.label,
      weight: row.weight
    }));
  }
  const hasExplicitSectorSection = sectorSectionLines.length > 0 || sectorFallbackRows.length > 0;
  if (!hasExplicitSectorSection && sectorRows.length === 0 && rowBlocks[0]?.length) {
    sectorRows = rowBlocks[0].map((row) => ({
      sector: row.label,
      weight: row.weight
    }));
  }
  const countryFallbackRows = countryRows.length === 0
    ? extractSectionRowsByRegex(
        text,
        ["market allocation", "country breakdown", "country exposure", "geographical", "geographic"],
        ["weighted exposure", "sector allocation", "sector exposure", "industry allocation", "industry exposure", "top holdings", "fund benchmark", "trading information", "risk indicator"]
      )
    : [];
  if (countryRows.length === 0) {
    if (countryFallbackRows.length > 0) {
      countryRows = countryFallbackRows.map((row) => ({
        country: row.label,
        weight: row.weight
      }));
    }
  }
  const hasExplicitCountrySection = countrySectionLines.length > 0 || countryFallbackRows.length > 0;
  const secondRowBlockTotal = rowBlocks[1]?.reduce((acc, row) => acc + row.weight, 0) ?? 0;
  if (!hasExplicitCountrySection && countryRows.length === 0 && rowBlocks[1]?.length && secondRowBlockTotal >= 0.9) {
    countryRows = rowBlocks[1].map((row) => ({
      country: row.label,
      weight: row.weight
    }));
  }

  return {
    asOfDate,
    payload: {
      country: countryRows,
      sector: sectorRows
    },
    sourceMeta: {
      parser: "factsheet-text",
      countriesExtracted: countryRows.length,
      sectorsExtracted: sectorRows.length,
      sectorRegexFallback: sectorFallbackRows.length > 0
    }
  };
}

export async function parseIsharesFactsheetPdfBytes(
  bytes: Buffer
): Promise<Pick<IsharesExposureResult, "asOfDate" | "payload" | "sourceMeta">> {
  try {
    const text = await extractPdfText(bytes);
    return parseIsharesFactsheetText(text);
  } catch (error) {
    console.warn("[ISHARES][PARSE] pdf extraction failed, falling back to utf8 text decode", {
      error: error instanceof Error ? error.message : String(error)
    });
    const text = bytes.toString("utf8");
    return parseIsharesFactsheetText(text);
  }
}

function parseProductPageExposures(pageHtml: string): IsharesExposureResult | null {
  const sectorsRaw = extractDataTable(pageHtml, "tabsSectorDataTable");
  const countriesRaw = extractDataTable(pageHtml, "subTabsCountriesDataTable");
  if (!sectorsRaw.length) return null;

  const sector = normalizeSectorRows(sectorsRaw);
  const country = normalizeCountryRows(countriesRaw);
  const asOfDate = extractAsOfDate(pageHtml);
  if (!sector.length) return null;

  const countryTotal = country.length ? sumWeights(country) : null;
  const sectorTotal = sumWeights(sector);
  const countryOutOfTolerance = countryTotal !== null && (countryTotal < 0.98 || countryTotal > 1.02);
  const sectorOutOfTolerance = sectorTotal < 0.98 || sectorTotal > 1.02;

  return {
    asOfDate,
    payload: { country, sector },
    sourceMeta: {
      parsingMode: "PRODUCT_PAGE",
      countryTotal,
      sectorTotal,
      partial: countryOutOfTolerance || sectorOutOfTolerance
    }
  };
}

export async function fetchIsharesExposureByIsin(
  isin: string,
  hints: {
    ticker?: string | null;
    productName?: string | null;
    benchmarkName?: string | null;
    indexName?: string | null;
    instrumentId?: string | null;
  } = {}
): Promise<IsharesExposureResult> {
  console.info("[ISHARES][FETCH] start", {
    isin,
    tickerHint: hints.ticker ?? null
  });
  const requestContext: IsharesRequestContext = {
    cookieJar: new Map()
  };
  try {
    const current = await fetchIsharesProductData(isin, requestContext);
    if (current) {
      const fallback = applySingleCountryFallback(current.payload, {
        instrumentId: hints.instrumentId,
        displayName: hints.productName,
        benchmarkName: hints.benchmarkName,
        indexName: hints.indexName
      });
      return { ...current, payload: fallback.payload,
        sourceMeta: { ...current.sourceMeta, countryInference: fallback.meta } };
    }
  } catch (error) {
    console.warn("[ISHARES][PRODUCT_API] falling back to legacy page discovery", {
      isin, message: error instanceof Error ? error.message : String(error)
    });
  }
  const resolved = await resolveIsharesFundByIsin(
    isin,
    {
      ticker: hints.ticker,
      productName: hints.productName
    },
    requestContext
  );
  if (!resolved) {
    throw new Error("Unable to resolve iShares fund page from ISIN.");
  }

  const fromPage = parseProductPageExposures(resolved.pageHtml);
  if (fromPage) {
    const pageFallback = applySingleCountryFallback(fromPage.payload, {
      instrumentId: hints.instrumentId,
      displayName: hints.productName,
      benchmarkName: hints.benchmarkName,
      indexName: hints.indexName
    });
    const sourceMeta = {
      ...fromPage.sourceMeta,
      locale: resolved.locale,
      productUrl: resolved.productUrl,
      productId: resolved.productId,
      ticker: resolved.ticker,
      factsheetUrl: resolved.factsheetUrl,
      countryInference: pageFallback.meta
    };

    console.info("[ISHARES][PARSE] success", {
      isin,
      mode: "PRODUCT_PAGE",
      countries: pageFallback.payload.country.length,
      sectors: fromPage.payload.sector.length,
      asOfDate: fromPage.asOfDate ? fromPage.asOfDate.toISOString().slice(0, 10) : null
    });

    return {
      ...fromPage,
      payload: pageFallback.payload,
      sourceMeta
    };
  }

  if (!resolved.factsheetUrl) {
    throw new Error("iShares product resolved but no factsheet URL available.");
  }

  console.info("[ISHARES][FETCH] fallback factsheet", {
    isin,
    factsheetUrl: resolved.factsheetUrl
  });

  const factsheetBytes = await isharesGetBytes(resolved.factsheetUrl, requestContext);
  const parsed = await parseIsharesFactsheetPdfBytes(factsheetBytes);
  const payloadWithFallback = applySingleCountryFallback(parsed.payload, {
    instrumentId: hints.instrumentId,
    displayName: hints.productName,
    benchmarkName: hints.benchmarkName,
    indexName: hints.indexName
  });
  const payload = payloadWithFallback.payload;
  if (!payload.country.length && !payload.sector.length) {
    throw new Error("Factsheet parsed but no country/sector exposures detected.");
  }

  const checksum = crypto.createHash("sha256").update(factsheetBytes).digest("hex");
  const sourceMeta = {
    ...parsed.sourceMeta,
    parsingMode: "PDF",
    locale: resolved.locale,
    productUrl: resolved.productUrl,
    factsheetUrl: resolved.factsheetUrl,
    factsheetChecksum: checksum,
    countryInference: payloadWithFallback.meta
  };

  console.info("[ISHARES][PARSE] success", {
    isin,
    mode: "PDF",
    countries: payload.country.length,
    sectors: payload.sector.length,
    asOfDate: parsed.asOfDate ? parsed.asOfDate.toISOString().slice(0, 10) : null
  });

  return {
    asOfDate: parsed.asOfDate,
    payload,
    sourceMeta
  };
}

export const __testables = {
  parseProductPageExposures,
  parseIsharesFactsheetText,
  extractSectionRowsByRegex,
  parseDateLabel,
  normalizeSectorRows,
  normalizeCountryRows,
  applySingleCountryFallback,
  hasValidCountryExposure
};
