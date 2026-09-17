import { isharesGetJson, type IsharesRequestContext } from "./isharesClient";
import type { IsharesExposureResult } from "./types";

const CATALOG_URL = "https://www.ishares.com/varnish-api/blk-product-screener-server/api/v1/product-screener/product-data?country=gb&language=en&siteName=ishares-uk&userType=individual";
const PRODUCT_API = "https://www.ishares.com/varnish-api/uk-retail01-product-data/product-data/api/v2/get-product-data";
type Product = { isin: string; productPageUrl: string; localExchangeTicker?: string };
type DataPoint = { value?: unknown };
type Container = {
  dataPointsByNameMap?: Record<string, DataPoint>;
  subContainersByNameMap?: Record<string, Container>;
};
type ProductData = {
  componentsByNameMap?: { exposureBreakdowns?: { containersByNameMap?: Record<string, Container> } };
};
let catalog: { expiresAt: number; promise: Promise<Map<string, Product>> } | null = null;

async function getCatalog(context: IsharesRequestContext) {
  if (!catalog || catalog.expiresAt <= Date.now()) {
    const promise = isharesGetJson<Record<string, Product>>(CATALOG_URL, context).then((rows) => {
      const products = new Map<string, Product>();
      for (const row of Object.values(rows)) {
        if (typeof row?.isin === "string" && typeof row.productPageUrl === "string") {
          products.set(row.isin.trim().toUpperCase(), row);
        }
      }
      if (!products.size) throw new Error("iShares product catalog contained no ISIN mappings.");
      return products;
    });
    catalog = { expiresAt: Date.now() + 60 * 60 * 1000, promise };
    void promise.catch(() => { if (catalog?.promise === promise) catalog = null; });
  }
  return catalog.promise;
}

function parseRows(container?: Container) {
  const points = container?.dataPointsByNameMap;
  const names = points?.type?.value;
  const weights = points?.fund?.value;
  if (!Array.isArray(names) || !Array.isArray(weights) || names.length !== weights.length) return [];
  return names.flatMap((name, index) => {
    const weight = weights[index];
    return typeof name === "string" && typeof weight === "number" && Number.isFinite(weight) && weight > 0
      ? [{ name, weight: weight / 100 }] : [];
  });
}

function parseAsOf(value: unknown) {
  const raw = String(value ?? "");
  if (!/^\d{8}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? date : null;
}

export function parseIsharesProductData(data: ProductData) {
  const containers = data.componentsByNameMap?.exposureBreakdowns?.containersByNameMap;
  const countries = containers?.geography?.subContainersByNameMap?.countries;
  const sectors = containers?.sector;
  const country = parseRows(countries).map((row) => ({ country: row.name, weight: row.weight }));
  const sector = parseRows(sectors).map((row) => ({ sector: row.name, weight: row.weight }));
  if (!country.length && !sector.length) throw new Error("iShares product API returned no exposure breakdowns.");
  const dates = [countries, sectors].map((container) => parseAsOf(container?.dataPointsByNameMap?.asOf?.value))
    .filter((date): date is Date => date !== null).sort((a, b) => a.getTime() - b.getTime());
  return { payload: { country, sector }, asOfDate: dates[0] ?? null };
}

export async function fetchIsharesProductData(isin: string, context: IsharesRequestContext): Promise<IsharesExposureResult | null> {
  const product = (await getCatalog(context)).get(isin.trim().toUpperCase());
  if (!product) return null;
  const productUrl = new URL(product.productPageUrl, "https://www.ishares.com");
  const productId = /\/products\/(\d+)(?:\/|$)/.exec(productUrl.pathname)?.[1];
  if (productUrl.origin !== "https://www.ishares.com" || !productId) return null;
  const apiUrl = new URL(PRODUCT_API);
  apiUrl.search = new URLSearchParams({
    appSubType: "ISHARES", appType: "PRODUCT_PAGE", component: "exposureBreakdowns",
    locale: "en_GB", portfolioId: productId, targetSite: "ishares-uk", userType: "individual",
    excludeContent: "true", includeConfig: "true", asOfDate: ""
  }).toString();
  const result = parseIsharesProductData(await isharesGetJson<ProductData>(apiUrl.toString(), context));
  return { ...result, sourceMeta: {
    parsingMode: "PRODUCT_API", isin, productId, productUrl: productUrl.toString(),
    apiUrl: apiUrl.toString(), ticker: product.localExchangeTicker ?? null
  } };
}
