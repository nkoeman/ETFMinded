const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_DELAY_MS = 350;
const RETRY_BACKOFF_MS = [400, 900, 1800];

class PermanentIsharesError extends Error {}

export type IsharesLocaleConfig = {
  key: string;
  baseUrl: string;
  localeSuffix: string;
};

export type IsharesRequestContext = {
  cookieJar?: Map<string, string>;
};

export const ISHARES_LOCALES: IsharesLocaleConfig[] = [
  {
    key: "uk/en",
    baseUrl: "https://www.ishares.com/uk/individual/en",
    localeSuffix: "en-gb"
  }
];

let lastRequestAt = 0;
const sharedCookieJar = new Map<string, string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number) {
  return Math.round(ms + Math.random() * 175);
}

async function rateLimit() {
  const minDelay = Number(process.env.ISHARES_MIN_DELAY_MS || DEFAULT_DELAY_MS);
  const now = Date.now();
  const waitMs = Math.max(0, minDelay - (now - lastRequestAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastRequestAt = Date.now();
}

function withPassthroughParams(url: string) {
  const next = new URL(url);
  if (!next.searchParams.has("switchLocale")) {
    next.searchParams.set("switchLocale", "y");
  }
  if (!next.searchParams.has("siteEntryPassthrough")) {
    next.searchParams.set("siteEntryPassthrough", "true");
  }
  return next.toString();
}

function isRetriable(status: number) {
  return status === 429 || status >= 500;
}

function getHeaders(cookieHeader: string | null) {
  return {
    Accept: "*/*",
    "User-Agent": process.env.ISHARES_USER_AGENT || "PortfolioTracker/1.0",
    ...(cookieHeader ? { Cookie: cookieHeader } : {})
  };
}

function buildCookieHeader(cookieJar: Map<string, string>) {
  if (cookieJar.size === 0) return null;
  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function updateCookieJarFromResponse(response: Response, cookieJar: Map<string, string>) {
  const headerBag = response.headers as unknown as { getSetCookie?: () => string[] };
  const setCookies = typeof headerBag.getSetCookie === "function" ? headerBag.getSetCookie() : [];
  for (const setCookie of setCookies) {
    const firstPart = setCookie.split(";")[0]?.trim();
    if (!firstPart || !firstPart.includes("=")) continue;
    const equalsIndex = firstPart.indexOf("=");
    const name = firstPart.slice(0, equalsIndex).trim();
    const value = firstPart.slice(equalsIndex + 1).trim();
    if (!name || !value) continue;
    cookieJar.set(name, value);
  }
}

function resolveCookieJar(context?: IsharesRequestContext) {
  return context?.cookieJar ?? sharedCookieJar;
}

async function fetchWithTimeout(url: string, timeoutMs: number, cookieJar: Map<string, string>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const cookieHeader = buildCookieHeader(cookieJar);
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: getHeaders(cookieHeader)
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function isharesRequest(url: string, context?: IsharesRequestContext): Promise<Response> {
  const timeoutMs = Number(process.env.ISHARES_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const target = withPassthroughParams(url);
  const cookieJar = resolveCookieJar(context);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    await rateLimit();
    try {
      const response = await fetchWithTimeout(target, timeoutMs, cookieJar);
      updateCookieJarFromResponse(response, cookieJar);
      if (response.ok) return response;
      if (!isRetriable(response.status)) {
        const body = await response.text();
        throw new PermanentIsharesError(`iShares request failed (${response.status}): ${body || "empty body"}`);
      }
      lastError = new Error(`iShares request failed (${response.status})`);
    } catch (error) {
      if (error instanceof PermanentIsharesError) throw error;
      lastError = error;
    }

    if (attempt < RETRY_BACKOFF_MS.length) {
      await sleep(jitter(RETRY_BACKOFF_MS[attempt]));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`iShares request failed after retries: ${message}`);
}

export async function isharesGetText(url: string, context?: IsharesRequestContext) {
  const response = await isharesRequest(url, context);
  return response.text();
}

export async function isharesGetJson<T>(url: string, context?: IsharesRequestContext): Promise<T> {
  const response = await isharesRequest(url, context);
  return (await response.json()) as T;
}

export async function isharesGetBytes(url: string, context?: IsharesRequestContext) {
  const response = await isharesRequest(url, context);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function toAbsoluteIsharesUrl(baseUrl: string, pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return new URL(pathOrUrl, `${baseUrl}/`).toString();
}

export const __testables = {
  withPassthroughParams
};
