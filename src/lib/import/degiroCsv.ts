import { parse } from "csv-parse/sync";
import { parse as parseDate } from "date-fns";

export type DegiroTransaction = {
  tradeAt: Date;
  product: string;
  isin: string;
  orderId: string | null;
  exchange: string;
  quantity: number;
  price: number | null;
  valueEur: number | null;
  totalEur: number | null;
  currency: string;
  raw: Record<string, string>;
};

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function normalizeText(value: string | null | undefined) {
  return String(value || "").trim();
}

function normalizeCode(value: string | null | undefined) {
  return normalizeText(value).toUpperCase();
}

// Converts Dutch-formatted numeric text (comma decimals, optional thousand separators) to numbers.
function normalizeDecimal(input: string | undefined) {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\./g, "").replace(/,/g, ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

// Parses DeGiro date+time columns into a single trade timestamp.
function parseTradeDate(dateValue: string, timeValue?: string) {
  const dateStr = dateValue.trim();
  const timeStr = (timeValue || "00:00").trim();
  const parsed = parseDate(`${dateStr} ${timeStr}`, "dd-MM-yyyy HH:mm", new Date());
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function findHeaderValue(row: Record<string, string>, headerAlias: string) {
  const normalizedAlias = headerAlias.replace(/\s+/g, "").toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = key.replace(/\s+/g, "").toLowerCase();
    if (normalizedKey === normalizedAlias) return value;
  }
  return "";
}

// Transforms a DeGiro CSV export into normalized transaction rows used by the import pipeline.
export function parseDegiroCsv(csv: string): DegiroTransaction[] {
  const records = parse(csv, {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_records_with_error: true,
    skip_empty_lines: true,
    trim: true
  }) as Record<string, string>[];

  return records
    .map((row) => {
      const dateRaw = row["Datum"] || row["Datum "] || "";
      const timeRaw = row["Tijd"] || "";
      const tradeAt = parseTradeDate(dateRaw, timeRaw);
      const exchange = (row["Beurs"] || "UNKNOWN").trim() || "UNKNOWN";
      const quantity = normalizeDecimal(row["Aantal"]);
      const price = normalizeDecimal(row["Koers"]);
      const valueEur = normalizeDecimal(row["Waarde EUR"] ?? row["Waarde EUR "]);
      const totalEur = normalizeDecimal(row["Totaal EUR"] ?? row["Totaal EUR "]);
      const product = row["Product"] || "";
      const isin = row["ISIN"] || "";
      const orderId = findHeaderValue(row, "Order ID").trim() || null;
      const currency = row["Valuta"] || "EUR";

      if (!tradeAt || !isin || !product || quantity === null) return null;

      return {
        tradeAt,
        product,
        isin,
        orderId,
        exchange,
        quantity,
        price,
        valueEur,
        totalEur,
        currency,
        raw: row
      } as DegiroTransaction;
    })
    .filter(Boolean) as DegiroTransaction[];
}

function sameDirection(a: number, b: number) {
  if (a === 0 || b === 0) return a === b;
  return Math.sign(a) === Math.sign(b);
}

function sumNullable(values: Array<number | null>) {
  const numericValues = values.filter((value): value is number => value !== null);
  if (!numericValues.length) return null;
  return numericValues.reduce((sum, value) => sum + value, 0);
}

function weightedAveragePrice(rows: DegiroTransaction[]) {
  let numerator = 0;
  let denominator = 0;

  for (const row of rows) {
    if (row.price === null) continue;
    const weight = Math.abs(row.quantity);
    numerator += row.price * weight;
    denominator += weight;
  }

  return denominator > 0 ? numerator / denominator : null;
}

function assertCompatibleOrderRows(orderId: string, rows: DegiroTransaction[]) {
  const first = rows[0];

  for (const row of rows.slice(1)) {
    if (normalizeCode(row.isin) !== normalizeCode(first.isin)) {
      throw new Error(`Order ID ${orderId} contains multiple ISINs and cannot be imported safely.`);
    }
    if (!sameDirection(row.quantity, first.quantity)) {
      throw new Error(`Order ID ${orderId} contains both buy and sell executions and cannot be imported safely.`);
    }
    if (normalizeCode(row.currency) !== normalizeCode(first.currency)) {
      throw new Error(`Order ID ${orderId} contains multiple currencies and cannot be imported safely.`);
    }
    if (toIsoDate(row.tradeAt) !== toIsoDate(first.tradeAt)) {
      throw new Error(`Order ID ${orderId} spans multiple trade dates and cannot be imported safely.`);
    }
  }
}

function aggregateOrderRows(orderId: string, rows: DegiroTransaction[]): DegiroTransaction {
  assertCompatibleOrderRows(orderId, rows);

  const first = rows[0];
  const quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const valueEur = sumNullable(rows.map((row) => row.valueEur));
  const totalEur = sumNullable(rows.map((row) => row.totalEur));
  const price = weightedAveragePrice(rows);
  const tradeAt = rows.reduce((earliest, row) => (row.tradeAt < earliest ? row.tradeAt : earliest), first.tradeAt);

  return {
    ...first,
    tradeAt,
    quantity,
    price,
    valueEur,
    totalEur,
    raw: {
      ...first.raw,
      aggregatedExecutionRows: String(rows.length)
    }
  };
}

// DeGiro can split a single order into multiple execution rows with the same Order ID.
// Aggregate those rows before dedupe so the database stores one logical order with the full quantity/value.
export function aggregateDegiroOrderExecutions(rows: DegiroTransaction[]) {
  const result: DegiroTransaction[] = [];
  const orderGroups = new Map<string, DegiroTransaction[]>();
  const firstIndexByOrderId = new Map<string, number>();

  rows.forEach((row, index) => {
    const orderId = normalizeText(row.orderId);
    if (!orderId) {
      result.push(row);
      return;
    }

    const group = orderGroups.get(orderId) || [];
    if (!firstIndexByOrderId.has(orderId)) {
      firstIndexByOrderId.set(orderId, index);
    }
    group.push(row);
    orderGroups.set(orderId, group);
  });

  const aggregatedRows = Array.from(orderGroups.entries())
    .map(([orderId, group]) => ({
      index: firstIndexByOrderId.get(orderId) ?? Number.MAX_SAFE_INTEGER,
      row: group.length === 1 ? group[0] : aggregateOrderRows(orderId, group)
    }))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.row);

  return [...result, ...aggregatedRows].sort((a, b) => {
    const originalA = rows.indexOf(a);
    const originalB = rows.indexOf(b);
    const indexA = originalA >= 0 ? originalA : firstIndexByOrderId.get(a.orderId || "") ?? Number.MAX_SAFE_INTEGER;
    const indexB = originalB >= 0 ? originalB : firstIndexByOrderId.get(b.orderId || "") ?? Number.MAX_SAFE_INTEGER;
    return indexA - indexB;
  });
}
