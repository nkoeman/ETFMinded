# ETFMinded - Implemented Functionality and Logic

## 0. Parallel threads playbook
Use this section when multiple engineers/agents work at the same time.

### 0.1 Non-negotiable invariants
- Do not change pricing, FX conversion, transaction interpretation, or valuation formulas unless explicitly scoped.
- Keep sync pipeline order intact:
  1. Price sync
  2. FX sync
  3. Daily portfolio valuation recompute
- Keep runtime canonical valuation source as `DailyPortfolioValue`.
- Keep imports and sync best-effort: enrichment failures must never block core import/sync.

### 0.2 Suggested thread ownership
- Thread A: ingestion + sync
  - `src/lib/prices/**`
  - `src/lib/fx/**`
  - `src/app/api/sync-prices/**`
- Thread B: valuation + analytics
  - `src/lib/portfolio/**`
  - `src/lib/valuation/**`
  - `src/lib/dashboard/**`
- Thread C: issuer enrichment
  - `src/lib/ishares/**`
  - `src/lib/etf/**`
  - `src/app/api/admin/enrich-ishares/**`
- Thread D: UI-only changes
  - `src/components/**`
  - `src/app/**/page.tsx`
  - `src/app/globals.css`

### 0.3 High-conflict files (single owner per PR)
- `prisma/schema.prisma`
- `src/lib/prisma.ts`
- `src/lib/prices/sync.ts`
- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/components/AppShell.tsx`

### 0.4 Merge protocol
- Rebase each thread branch before merge; resolve conflicts locally and rerun smoke checks.
- Never mix schema migration changes with large UI restyling in one PR.
- If touching `prisma/schema.prisma`, include migration + deploy command notes.
- Prefer additive API changes over route behavior changes unless explicitly required.

### 0.5 Minimum smoke checks before merge
- `docker compose up --build -d`
- `docker compose exec -T web npm run build`
- `docker compose exec -T web npx prisma migrate deploy`
- `docker compose exec -T web curl -s http://localhost:3000/api/sync-prices/recent -X POST` (authenticated path can be validated through UI/session flow)

### 0.6 Required handoff note in PR description
- Scope completed
- Files touched
- Invariants verified
- Any DB migration included
- Any known risk/follow-up

## 1. What the app does
The app imports DeGiro transactions, maps instruments to exchange listings, syncs market prices and FX rates, computes portfolio valuation series, and shows portfolio analytics across:
- Public landing page (`/`)
- `Performance` (`/app`)
- `Portfolio` (`/app/portfolio`)
- `Transactions` (`/app/import`)

It also generates a cached AI insights block for the last 4 weeks.

## 2. Runtime stack
- Next.js 14 App Router + TypeScript
- Prisma + PostgreSQL
- Clerk authentication (`@clerk/nextjs`) with Prisma-backed app user linking
- EODHD for listing discovery and historical prices
- ECB SDMX API for FX series
- OpenFIGI for instrument enrichment
- OpenAI Chat Completions for AI insights (structured JSON output)
- Recharts for chart rendering
- Vitest for tests

## 3. Auth and route protection

### 3.1 Middleware
`src/middleware.ts` protects:
- `/app/:path*`
- `/api/:path*`

Unauthenticated users are redirected to Clerk sign-in.
`redirect_url` is now passed as a relative in-app path (`pathname + search`) to avoid proxy-origin leakage (for example `localhost` showing up in production redirect params).

### 3.2 Server-side auth guards
Pages and API routes also resolve the authenticated user server-side via `getCurrentAppUser()` and reject unauthorized access.

### 3.3 App shell behavior
`AppShell` shows sidebar + header for app pages, but hides both on:
- `/` (public landing page)
- legacy redirects (`/portfolio`, `/import`)
- `/login`
- `/register`
- `/sign-in`
- `/sign-up`

## 4. Current pages

### 4.1 `/` (Public landing page)
Public marketing/entry page with:
- Product positioning and feature overview
- CTA links to `/sign-in` and `/sign-up`

### 4.2 `/app` (Performance)
Main authenticated performance page with:
- Portfolio performance card (default: `Return (%)` + `YTD`; range: `Max`, `YTD`, `1Y`, `3M`, `1M`; metric toggle for value/return)
- Return chart with periodic return bars, cumulative cashflow-aware return line, and optional global benchmark comparison lines
- `Gainers & losers` card with timeframe dropdown (`Max`, `YTD`, `1Y`, `1M`) and top contributors chart

### 4.3 `/app/portfolio` (Portfolio)
Portfolio composition page with:
- Top card: `Portfolio exposure` pie chart module (single-chart view switcher: Region / Development / Country / Sector)
- Open positions overview table
- Closed positions overview table
- Server-side sorting support for open positions via query params
- Positions with missing price coverage remain visible and are labeled `No prices available`

### 4.4 `/app/import` (Transactions)
Transactions page with:
- `Data update` section (sync buttons)
- CSV import form
- Full transaction table with:
  - Date (`tradeAt`)
  - Name (`instrument.displayName` fallback to `instrument.name`)
  - Quantity
  - Price
  - Amount (`valueEur` fallback to `totalEur`)

### 4.5 Auth pages
- `/login`: backward-compatible redirect to `/sign-in`
- `/register`: backward-compatible redirect to `/sign-up`
- `/sign-in`: Clerk sign-in flow (embedded component, no iframe)
- `/sign-up`: Clerk sign-up flow (embedded component, no iframe)

### 4.6 Legacy route redirects
- `/portfolio` -> `/app/portfolio` (permanent redirect)
- `/import` -> `/app/import` (permanent redirect)

## 5. API endpoints
- `POST /api/import`: import DeGiro CSV, fetch prices only for imported listings without stored prices, and await full valuation recalculation
- `GET /api/ai-summary`: get/generate cached AI insights
- `GET /api/dashboard/top-movers?range=max|ytd|1y|1m`: get gainers/losers payload for the selected timeframe
- `POST /api/sync-prices/recent`: sync last ~4 weeks
- `POST /api/sync-prices/full`: full sync from first transaction date
- `POST /api/sync-prices`: legacy wrapper (`force=true` => full, else recent)
- `POST /api/sync-prices/daily`: alias of recent sync
- `POST /api/sync-prices/weekly`: alias of full sync
- `POST /api/admin/sync-exchanges`: refresh EODHD exchange directory
- `POST /api/admin/enrich-ishares`: issuer exposure enrichment for user holdings (now includes post-run normalization backfill)
- `POST /api/admin/enrich-vaneck`: VanEck exposure enrichment for user holdings
- `POST /api/admin/normalize-exposure`: manual exposure normalization backfill trigger
- `GET /api/portfolio/exposure`: aggregated portfolio exposure analytics payload (region/development/country/sector)

## 6. Prisma data model (runtime-relevant)

### 6.1 Core
- `User`
- `ImportBatch`
- `Transaction`

### 6.2 Instruments and listing mapping
- `Instrument`
- `InstrumentListing`
- `DegiroVenueMap` (beurs -> MIC)
- `EodhdExchange` (exchange directory)

### 6.3 Market data and valuation caches
- `DailyListingPrice` (canonical price cache; unique `(listingId, date)`)
- `FxRate` (weekly FX cache; unique `(weekEndDate, base, quote)`)
- `DailyPortfolioValue` (canonical valuation cache; unique `(userId, date)`)
- Global benchmark ETF prices are cached in `DailyListingPrice` via benchmark `Instrument` / `InstrumentListing` rows; they are not stored per user.

### 6.4 AI and enrichment
- `PortfolioAiSummary`
- `InstrumentEnrichment`
- `InstrumentProfile`
- `InstrumentExposureSnapshot` (raw + normalized exposure payloads, versioned normalization metadata)

### 6.5 Concurrency
- `SyncLock` (server-side sync lock)

### 6.6 Removed
- `WeeklyPortfolioValue` has been removed from schema/runtime.

## 7. CSV import flow (`POST /api/import`)
1. Validate auth and uploaded file
2. Parse CSV rows (`parseDegiroCsv`)
3. Create `ImportBatch`
4. Upsert instruments by ISIN
5. Run OpenFIGI enrichment (best effort)
6. Run rules-based profile enrichment (best effort)
7. Resolve listing per row (`resolveOrCreateListingForTransaction`)
8. Generate deterministic `uniqueKey` hash per transaction
9. Bulk insert with `skipDuplicates: true` (idempotent import)
10. Under the per-user sync lock, fetch historical prices only for imported mapped listings without stored daily prices; ensure FX for those new listings before recalculating.
11. Await full daily valuation recomputation using stored prices (including trades throughout the final valuation day), invalidate AI summaries/top movers and app route caches, then return success. Duplicate re-uploads also repair previously interrupted recalculation.
12. Reuse successful exposure snapshots and fetch missing/failed exposure after transaction persistence. Provider refresh failures preserve the last successful snapshot. Exposure weights are computed from current holdings; exposure responses are not browser-cached.

The Open positions table total is the sum of its displayed market-value rows, rather than a potentially older daily valuation snapshot.

Import feedback includes a loading spinner, elapsed time and a longer-running message after 30 seconds. File selection is disabled while processing. Import timing logs separate market-data, valuation and exposure work. Exposure imports respect failed-snapshot retry cooldowns; permanent iShares HTTP errors (such as 404) fail immediately instead of consuming transient-error retries.

iShares exposure now first uses the official product-screener JSON catalog (exact ISIN matching, cached for one hour) and the current product-data API country/sector breakdowns. Published percentage weights and as-of dates are retained, with the existing single-country inference used only when geography is absent. Legacy HTML/PDF discovery remains a fallback. Existing failed snapshots can be repaired using the authenticated enrichment endpoint with `force: true` after deployment.

## 8. Listing mapping logic
Mapping uses MIC-first resolution:
1. DeGiro beurs code -> MIC (`DegiroVenueMap`)
2. MIC -> target EODHD exchange code
3. Fetch EODHD candidates by ISIN
4. Candidate selection strategy:
   - `EXACT`: suffix/exchange exact match
   - `COUNTRY`: fallback by exchange country
   - `CURRENCY`: fallback by currency
   - deterministic low-confidence fallback if needed
5. Upsert listing mapping result; mark failures as `FAILED` with `mappingError`

Logs include structured `[MAP]` stages and selection reason/confidence.

## 9. Price sync architecture (`src/lib/prices/sync.ts`)

Two sync modes:
- `syncLast4WeeksForUser(userId)`
- `syncFullForUser(userId)`

Pipeline order:
1. Ensure exchange directory loaded
2. Re-link unmapped transactions where possible
3. Sync daily prices (`syncDailyPricesForUser`)
4. Ensure weekly FX coverage for required range (`ensureWeeklyFxRates`)
5. Recompute daily portfolio values (`refreshDailyPortfolioValuesForUser`)

Important:
- Recent sync does **not** delete historical prices.
- Overlapping sync requests are prevented via `withSyncLock(...)`.

## 10. Daily price ingestion
`fetchDailyPricesForListings(...)`:
- Calls EODHD historical endpoint with `period="d"` (daily)
- Upserts into `DailyListingPrice` by `(listingId, date)`
- Stores `adjustedClose` and `close` when available
- Includes retry/backoff and small inter-call delay
- Emits `[DAILY][PRICES]` logs

Benchmark price ingestion:
- Benchmark ETFs are configured through `BENCHMARK_*` environment variables.
- Benchmark sync reuses the same EODHD daily adjusted-close fetcher used for normal listings.
- Missing benchmark ranges are queued in the background from the earliest portfolio-relevant date to the current date.
- Cached benchmark prices are global app-level data and reused for all users.

## 11. FX ingestion
`ensureWeeklyFxRates(...)`:
- Determines required currencies from mapped listings
- Determines required Friday week-end dates from date range / known prices
- Fetches ECB daily series
- For each week-end date, uses nearest observation on/before week end
- Upserts `FxRate`
- Emits `[FX]` and `[FX][FALLBACK]` logs

## 12. Canonical valuation computation (`DailyPortfolioValue`)
`getOrCreateDailyPortfolioSeries(...)` computes and upserts per day:
- Holdings as-of each day from transaction history
- Price selection with carry-forward fallback (lookback window)
- EUR conversion using FX nearest on/before valuation day
- `partialValuation=true` when holdings are excluded due to missing price/FX
- Invested-capital accumulation includes only transactions tied to listings with actual price coverage in the valuation window

Return fields stored:
- `netExternalFlowEur`
- `periodReturnPct`
- `returnIndex`
- `cumulativeReturnPct`

Price field used in valuation:
- `close` when present
- otherwise fallback to `adjustedClose`

Return chain continuity:
- If prior `DailyPortfolioValue` exists before the requested window, index continuation uses that prior value/index instead of resetting.

## 13. Weekly series derivation (without weekly table)
`getWeeklySeriesFromDaily(...)` groups daily values by ISO week (Monday start) and selects the latest point in each week, returning:
- `weekStartDate`
- `weekEndDate`
- `valueEur`
- `partialValuation`
- `cumulativeReturnPct`

This derived weekly series is used in runtime reads (charts and recent analytics).

## 14. Performance page logic (`/app`)

### 14.1 Portfolio performance card
- Range toggle:
  - `Max` -> yearly return bars and full-history value/return window
  - `1Y` -> monthly return bars and trailing-year value/return window
  - `YTD` -> monthly return bars from Jan 1
  - `3M` -> monthly return bars over the trailing three months
  - `1M` -> daily return bars over the trailing month
- Metric toggle:
  - `Value (EUR)` (green value line + dotted invested line)
  - `Return (%)` (periodic return bars + cumulative cashflow-aware return line)
- Initial page-load state is `Return (%)` with the `YTD` timeframe selected.
- Invested line is derived from canonical valuation (`Invested = EUR - cumulativeReturnAmountEur`) to stay aligned with `DailyPortfolioValue` logic
- Cumulative portfolio return in the chart is compounded from `periodReturnPct`; it does not use raw portfolio value divided by the first visible portfolio value.
- The first visible cumulative-return point is initialized at `0%` for the selected chart window.
- Benchmark comparison is available only in `Return (%)` mode:
  - `S&P 500` line color: `#2f6fd6`
  - `FTSE All-World` line color: `#c9761c`
  - benchmark returns are price-rebased from the first available benchmark close at or after the selected window start
  - compare pills toggle each benchmark on/off
- Return chart tooltip is container-clamped and flips left near the right edge to avoid overflow/wrapping.

### 14.2 Gainers & losers card
`Gainers & losers` card:
- Timeframe dropdown options: `Max`, `YTD`, `1Y`, `1M`
- Initial server render loads only the default range (`max`)
- Other ranges are fetched on-demand via `GET /api/dashboard/top-movers`
- Client caches loaded ranges locally to avoid duplicate fetches during range switching
- Shows window and last-updated metadata

Server-side movers service behavior:
- `getTopMoversByRange(userId, range)` uses in-memory TTL cache keyed by `userId + range + latestDailyDate`
- Includes in-flight promise dedupe for concurrent requests with the same cache key
- Weekly conversion avoids O(n²) date matching by pre-indexing daily rows by date

### 14.3 AI insights
- AI insights are available on `/app/insights`.
- The Performance page no longer renders the AI summary card.

### 14.4 Page-load safeguards
- Homepage no longer blocks response on synchronous daily valuation backfill when return fields are missing.
- If a missing cumulative-return segment is detected, a background refresh is queued, while existing `DailyPortfolioValue` rows are rendered immediately.

## 15. Portfolio page logic (`/app/portfolio`)
- Renders `Portfolio exposure` card first, before positions tables
- Builds open positions from transactions + mapped listings + price/FX data, while keeping unmapped/unpriced positions visible
- Calculates market value, total P&L, YTD P&L and YTD%
- Builds closed positions when net quantity returns to ~0
- Uses existing table style (`.table`) and server-side sort query params
- Open and closed positions without price coverage are explicitly labeled `No prices available`

### 15.1 Portfolio exposure module
- Fetches `GET /api/portfolio/exposure` and shows one pie chart at a time with dropdown switching:
  - Region
  - Development
  - Country
  - Sector
- Supports hover/tap tooltip and active-slice highlighting
- Shows coverage metadata (`Exposure coverage`, `No data`, `As of`)
- Handles partial exposure coverage by including a `No data` slice to keep chart totals at 100%
- Uses normalized exposure snapshots; raw labels remain stored for audit/debug

## 16. Transactions page logic (`/app/import`)
- Data update controls:
  - `Sync last 4 weeks`
  - `Full sync`
  - `Sync iShares enrichment` (includes normalization pass after enrichment)
- CSV import form (`POST /api/import`)
- Full transaction table in same style as open positions

## 17. AI summary pipeline
`getOrCreatePortfolioAiSummary(...)`:
- Uses canonical `getRecentPerformance(userId, 4)` output
- Builds facts payload with contributor metadata
- Hash key: `sha256(promptVersion + temperature + factsPayload)`
- Caches by `(userId, weekEndDate, windowWeeks)`
- Uses structured output schema:
  - `oneLiner` (single sentence, <=180 chars)
  - `bullets` (1..5 items, each <=120 chars)
- If history is insufficient (`weeksCount < 2`), returns `EMPTY`

## 18. Environment variables used
- `DATABASE_URL`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL` (optional, default `/sign-in`)
- `NEXT_PUBLIC_CLERK_SIGN_UP_URL` (optional, default `/sign-up`)
- `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` (optional; set to `/app` for consistency)
- `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` (optional; set to `/app` for consistency)
- `EODHD_API_KEY`
- `EODHD_BASE_URL` (optional)
- `BENCHMARK_SP500_ENABLED` (optional, default `false`)
- `BENCHMARK_SP500_LABEL` (optional, default `S&P 500`)
- `BENCHMARK_SP500_PROVIDER` (optional, default `eodhd`)
- `BENCHMARK_SP500_SYMBOL` (optional, default `VUAA.XETRA`)
- `BENCHMARK_SP500_ISIN` (optional, default `IE00BFMXXD54`)
- `BENCHMARK_SP500_CURRENCY` (optional, default `EUR`)
- `BENCHMARK_FTSE_ALL_WORLD_ENABLED` (optional, default `false`)
- `BENCHMARK_FTSE_ALL_WORLD_LABEL` (optional, default `FTSE All-World`)
- `BENCHMARK_FTSE_ALL_WORLD_PROVIDER` (optional, default `eodhd`)
- `BENCHMARK_FTSE_ALL_WORLD_SYMBOL` (optional, default `VWCE.XETRA`)
- `BENCHMARK_FTSE_ALL_WORLD_ISIN` (optional, default `IE00BK5BQT80`)
- `BENCHMARK_FTSE_ALL_WORLD_CURRENCY` (optional, default `EUR`)
- `OPENFIGI_API_KEY`
- `OPENFIGI_BASE_URL` (optional)
- `OPENFIGI_ENRICH_TTL_DAYS` (optional)
- `ECB_BASE_URL` (optional)
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (optional, default `gpt-4o-mini`)
- `OPENAI_TEMPERATURE` (optional, default `0.2`)

## 19. Notable constraints / caveats
- `src/middleware.ts` matcher protects `/app/*` and `/api/*`; server-side guards remain in pages/routes as defense in depth.
- Position valuation on `/app/portfolio` currently reads `DailyListingPrice.adjustedClose` for instrument-level metrics.

## 20. Deployment topology (dev vs prod)

### 20.1 Production (`docker-compose.yml`)
- Public entrypoint is `caddy` only (ports `80`/`443`).
- `web` is internal-only (`expose: 3000`, no public `ports` mapping).
- Runtime environment variables must be listed under `web.environment`; values in `.env` are only visible to the container when explicitly passed through Compose.
- TLS is managed automatically by Caddy (Let's Encrypt).
- Domain behavior:
  - `https://www.etfminded.com` redirects to `https://etfminded.com`
  - `https://etfminded.com` reverse-proxies to `web:3000`

### 20.2 Development (`docker-compose.dev.yml`)
- Adds local `db` (`postgres:16`) and overrides `web` database URL to local Postgres.
- Re-exposes `web` on `3000` for local development convenience.
- Production Caddy service is disabled in dev override.

### 20.3 Reverse-proxy headers
- Caddy forwards host/proto headers upstream.
- App auth redirects are designed to remain stable behind proxies by using relative `redirect_url`.

## 21. Migration and runtime operations
- Schema changes must be applied in production with:
  - `docker compose exec -T web npx prisma migrate deploy`
- `migrate deploy` should run on every production deploy (idempotent, safe).
- Build success alone is insufficient if DB schema is behind application code.
- Known failure signatures and causes:
  - `P2022` (`User.clerkUserId` missing): migration not applied.
  - `P2011` (`passwordHash` null constraint): DB schema drift vs Clerk user creation flow.
