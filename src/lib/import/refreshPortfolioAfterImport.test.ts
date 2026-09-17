import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listings: vi.fn(), first: vi.fn(), prices: vi.fn(), fx: vi.fn(), recalculate: vi.fn(),
  summaries: vi.fn(), movers: vi.fn(), exposure: vi.fn(), revalidate: vi.fn()
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  instrumentListing: { findMany: mocks.listings }, transaction: { findFirst: mocks.first },
  portfolioAiSummary: { deleteMany: mocks.summaries }
} }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/prices/syncDailyPrices", () => ({ syncDailyPricesForListings: mocks.prices }));
vi.mock("@/lib/fx/sync", () => ({ ensureWeeklyFxRates: mocks.fx }));
vi.mock("@/lib/valuation/dailyPortfolioValue", () => ({ refreshDailyPortfolioValuesForUser: mocks.recalculate }));
vi.mock("@/lib/dashboard/topMoversByRange", () => ({ invalidateTopMoversCacheForUser: mocks.movers }));
vi.mock("@/lib/ishares/ensureIsharesExposure", () => ({ ensureIsharesExposureSnapshots: mocks.exposure }));

import { refreshPortfolioAfterImport } from "./refreshPortfolioAfterImport";

describe("post-import portfolio refresh", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listings.mockResolvedValue([]);
    mocks.first.mockResolvedValue({ tradeAt: new Date("2020-01-01") });
    mocks.exposure.mockResolvedValue({ failed: 0 });
  });

  it("recomputes all history and invalidates dependents without fetching prices for existing assets", async () => {
    await refreshPortfolioAfterImport("user", { listingIds: ["existing"], instrumentIds: ["asset"] });
    expect(mocks.listings).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: { in: ["existing"] }, dailyPrices: { none: {} }
    }) }));
    expect(mocks.prices).not.toHaveBeenCalled();
    expect(mocks.fx).not.toHaveBeenCalled();
    expect(mocks.recalculate).toHaveBeenCalledWith("user");
    expect(mocks.summaries).toHaveBeenCalledWith({ where: { userId: "user" } });
    expect(mocks.movers).toHaveBeenCalledWith("user");
    expect(mocks.revalidate).toHaveBeenCalledWith("/app", "layout");
    expect(mocks.exposure).toHaveBeenCalledWith({ userId: "user", instrumentIds: ["asset"], onlyMissing: true });
  });

  it("fetches only listings without stored prices, then FX, then recalculates", async () => {
    mocks.listings.mockResolvedValue([{ id: "new" }]);
    await refreshPortfolioAfterImport("user", { listingIds: ["existing", "new"], instrumentIds: [] });
    expect(mocks.prices).toHaveBeenCalledWith(["new"], new Date("2020-01-01"), expect.any(Date));
    expect(mocks.prices.mock.invocationCallOrder[0]).toBeLessThan(mocks.fx.mock.invocationCallOrder[0]);
    expect(mocks.fx.mock.invocationCallOrder[0]).toBeLessThan(mocks.recalculate.mock.invocationCallOrder[0]);
  });

  it("waits for recomputation before reporting completion", async () => {
    let complete!: () => void;
    mocks.recalculate.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const refresh = refreshPortfolioAfterImport("user", { listingIds: [], instrumentIds: [] });
    await vi.waitFor(() => expect(mocks.recalculate).toHaveBeenCalled());
    expect(mocks.revalidate).not.toHaveBeenCalled();
    complete();
    await refresh;
    expect(mocks.revalidate).toHaveBeenCalled();
  });

  it("reports a provider failure but still recalculates using stored prices", async () => {
    mocks.listings.mockResolvedValue([{ id: "new" }]);
    mocks.prices.mockRejectedValue(new Error("unavailable"));
    const result = await refreshPortfolioAfterImport("user", { listingIds: ["new"], instrumentIds: [] });
    expect(result.warnings).toHaveLength(1);
    expect(mocks.recalculate).toHaveBeenCalled();
  });
});
