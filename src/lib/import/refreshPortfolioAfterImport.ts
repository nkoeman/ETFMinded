import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { syncDailyPricesForListings } from "@/lib/prices/syncDailyPrices";
import { ensureWeeklyFxRates } from "@/lib/fx/sync";
import { refreshDailyPortfolioValuesForUser } from "@/lib/valuation/dailyPortfolioValue";
import { invalidateTopMoversCacheForUser } from "@/lib/dashboard/topMoversByRange";
import { ensureIsharesExposureSnapshots } from "@/lib/ishares/ensureIsharesExposure";

// Caller holds the user's price-sync lock across import and refresh.
export async function refreshPortfolioAfterImport(
  userId: string,
  input: { listingIds: string[]; instrumentIds: string[] }
) {
  const startedAt = Date.now();
  let stageStartedAt = startedAt;
  const logStage = (stage: string) => {
    const now = Date.now();
    console.info("[IMPORT][TIMING]", { userId, stage, durationMs: now - stageStartedAt, elapsedMs: now - startedAt });
    stageStartedAt = now;
  };
  const warnings: string[] = [];
  const missing = input.listingIds.length ? await prisma.instrumentListing.findMany({
    where: {
      id: { in: input.listingIds },
      mappingStatus: "MAPPED",
      eodhdCode: { not: null },
      dailyPrices: { none: {} }
    },
    select: { id: true }
  }) : [];

  const first = await prisma.transaction.findFirst({
    where: { userId }, orderBy: { tradeAt: "asc" }, select: { tradeAt: true }
  });
  const toDate = new Date();
  const fromDate = first?.tradeAt ?? toDate;
  if (missing.length) {
    try {
      await syncDailyPricesForListings(missing.map((listing) => listing.id), fromDate, toDate);
      await ensureWeeklyFxRates({ userId, fromDate, toDate });
    } catch (error) {
      console.error("[IMPORT] missing market data sync failed", { userId, error });
      warnings.push("Some new assets could not fetch market data. Retry price sync to complete their valuation.");
    }
  }

  logStage("market-data");
  // Rebuild the entire chain: historical corrections affect all subsequent returns.
  await refreshDailyPortfolioValuesForUser(userId);
  logStage("valuation");
  await prisma.portfolioAiSummary.deleteMany({ where: { userId } });
  invalidateTopMoversCacheForUser(userId);

  if (input.instrumentIds.length) {
    try {
      const exposure = await ensureIsharesExposureSnapshots({
        userId, instrumentIds: input.instrumentIds, onlyMissing: true
      });
      if (exposure.failed) warnings.push("Exposure is unavailable for some assets; existing exposure data has been preserved.");
    } catch (error) {
      console.error("[IMPORT] exposure preparation failed", { userId, error });
      warnings.push("Exposure preparation could not finish. Existing exposure data has been preserved.");
    }
  }

  logStage("exposure-and-invalidation");
  revalidatePath("/app", "layout");
  return { syncedListings: missing.length, warnings };
}
