import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dailyPortfolioValueFindMany: vi.fn(),
  dailyPortfolioValueFindFirst: vi.fn(),
  dailyPortfolioValueUpsert: vi.fn(),
  transactionFindMany: vi.fn(),
  listingFindMany: vi.fn(),
  dailyListingPriceFindMany: vi.fn(),
  fxRateFindMany: vi.fn(),
  externalFlowSeries: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
    prisma: {
      dailyPortfolioValue: {
        findMany: mocks.dailyPortfolioValueFindMany,
        findFirst: mocks.dailyPortfolioValueFindFirst,
        upsert: mocks.dailyPortfolioValueUpsert
      },
    transaction: {
      findMany: mocks.transactionFindMany
    },
    instrumentListing: {
      findMany: mocks.listingFindMany
    },
    dailyListingPrice: {
      findMany: mocks.dailyListingPriceFindMany
    },
    fxRate: {
      findMany: mocks.fxRateFindMany
    }
  }
}));

vi.mock("@/lib/portfolio/getNetExternalCashFlow", () => ({
  getExternalCashFlowSeries: mocks.externalFlowSeries
}));

import { getOrCreateDailyPortfolioSeries } from "@/lib/portfolio/getOrCreateDailyPortfolioSeries";

describe("getOrCreateDailyPortfolioSeries", () => {
  it("includes an afternoon sale on the final day and its cash flow", async () => {
    const buy = { instrumentId: "asset", listingId: "listing", quantity: 10,
      tradeAt: new Date("2026-02-01T10:00:00Z"), valueEur: -100, totalEur: -100,
      instrument: { listings: [{ id: "listing" }] } };
    const sell = { ...buy, quantity: -4, tradeAt: new Date("2026-02-02T15:00:00Z"), valueEur: 40, totalEur: 40 };
    mocks.transactionFindMany.mockImplementation(({ where }) => Promise.resolve(
      [buy, sell].filter((tx) => tx.tradeAt <= where.tradeAt.lte)
    ));
    mocks.listingFindMany.mockResolvedValue([{ id: "listing", isin: "test", currency: "EUR" }]);
    mocks.dailyListingPriceFindMany.mockResolvedValue([{ listingId: "listing", date: new Date("2026-02-01"),
      close: 10, adjustedClose: 10, currency: "EUR" }]);
    mocks.externalFlowSeries.mockImplementation((_user, _start, end) => Promise.resolve(
      [{ date: new Date("2026-02-01"), amountEur: -100 },
        ...(sell.tradeAt <= end ? [{ date: new Date("2026-02-02"), amountEur: 40 }] : [])]
    ));
    const series = await getOrCreateDailyPortfolioSeries("user", {
      fromDate: new Date("2026-02-01"), toDate: new Date("2026-02-02"), forceRecompute: true
    });
    expect(series.points.map((point) => point.valueEur)).toEqual([100, 60]);
    expect(series.points[1].netExternalFlowEur).toBe(40);
    expect(series.points[1].periodReturnPct).toBeCloseTo(0);
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.dailyPortfolioValueFindMany.mockReset().mockResolvedValue([]);
    mocks.dailyPortfolioValueFindFirst.mockReset().mockResolvedValue(null);
    mocks.dailyPortfolioValueUpsert.mockReset().mockResolvedValue({});
    mocks.transactionFindMany.mockReset().mockResolvedValue([]);
    mocks.listingFindMany.mockReset().mockResolvedValue([]);
    mocks.dailyListingPriceFindMany.mockReset().mockResolvedValue([]);
    mocks.fxRateFindMany.mockReset().mockResolvedValue([]);
    mocks.externalFlowSeries.mockReset().mockResolvedValue([]);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns cached daily values when the full window exists", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([
      {
        date: new Date("2026-02-01T00:00:00.000Z"),
        valueEur: 10,
        cumulativeReturnAmountEur: 0,
        computedAt: new Date("2026-02-03T01:00:00.000Z")
      },
      {
        date: new Date("2026-02-02T00:00:00.000Z"),
        valueEur: 11,
        cumulativeReturnAmountEur: 1,
        computedAt: new Date("2026-02-03T02:00:00.000Z")
      },
      {
        date: new Date("2026-02-03T00:00:00.000Z"),
        valueEur: 12,
        cumulativeReturnAmountEur: 2,
        computedAt: new Date("2026-02-03T03:00:00.000Z")
      }
    ]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-03T00:00:00.000Z"),
      days: 3
    });

    expect(series.points).toHaveLength(3);
    expect(series.points[0].valueEur).toBe(10);
    expect(series.lastUpdatedAt?.toISOString()).toBe("2026-02-03T03:00:00.000Z");
    expect(mocks.transactionFindMany).not.toHaveBeenCalled();
  });

  it("computes a sorted daily series with fallback to prior prices", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([]);
    mocks.transactionFindMany.mockResolvedValue([
      {
        instrumentId: "inst_1",
        listingId: "lst_1",
        tradeAt: new Date("2026-02-01T00:00:00.000Z"),
        quantity: 2,
        instrument: {
          listings: [{ id: "lst_1" }]
        }
      }
    ]);

    mocks.listingFindMany.mockResolvedValue([
      { id: "lst_1", isin: "IE0000000001", currency: "EUR" }
    ]);

    mocks.dailyListingPriceFindMany.mockResolvedValue([
      {
        listingId: "lst_1",
        date: new Date("2026-02-01T00:00:00.000Z"),
        adjustedClose: 10,
        close: 10,
        currency: "EUR"
      },
      {
        listingId: "lst_1",
        date: new Date("2026-02-03T00:00:00.000Z"),
        adjustedClose: 12,
        close: 12,
        currency: "EUR"
      }
    ]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-03T00:00:00.000Z"),
      days: 3
    });

    expect(series.points.map((point) => point.valueEur)).toEqual([20, 20, 24]);
    expect(series.points[0].returnIndex).toBeNull();
    expect(series.points[1].returnIndex).toBeCloseTo(100, 8);
    expect(series.points[2].returnIndex).toBeGreaterThan(100);
    expect(series.points.map((point) => point.date.toISOString().slice(0, 10))).toEqual([
      "2026-02-01",
      "2026-02-02",
      "2026-02-03"
    ]);
    expect(mocks.dailyPortfolioValueUpsert).toHaveBeenCalledTimes(3);
    expect(mocks.fxRateFindMany).not.toHaveBeenCalled();
  });

  it("computes organic returns excluding external deposits", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([]);
    mocks.externalFlowSeries.mockResolvedValue([
      { date: new Date("2026-02-02T00:00:00.000Z"), amountEur: -50 }
    ]);
    mocks.transactionFindMany.mockResolvedValue([
      {
        instrumentId: "inst_1",
        listingId: "lst_1",
        tradeAt: new Date("2026-02-01T00:00:00.000Z"),
        quantity: 10,
        instrument: {
          listings: [{ id: "lst_1" }]
        }
      }
    ]);

    mocks.listingFindMany.mockResolvedValue([
      { id: "lst_1", isin: "IE0000000001", currency: "EUR" }
    ]);

    mocks.dailyListingPriceFindMany.mockResolvedValue([
      {
        listingId: "lst_1",
        date: new Date("2026-02-01T00:00:00.000Z"),
        adjustedClose: 10,
        close: 10,
        currency: "EUR"
      },
      {
        listingId: "lst_1",
        date: new Date("2026-02-02T00:00:00.000Z"),
        adjustedClose: 15,
        close: 15,
        currency: "EUR"
      }
    ]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-02T00:00:00.000Z"),
      days: 2
    });

    expect(series.points[1].netExternalFlowEur).toBe(-50);
    expect(series.points[1].periodReturnPct).toBeCloseTo(0, 8);
    expect(series.points[1].cumulativeReturnPct).toBeCloseTo(0, 8);
  });

  it("seeds first-period index using first-day external funding", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([]);
    mocks.externalFlowSeries.mockResolvedValue([
      { date: new Date("2026-02-01T00:00:00.000Z"), amountEur: -859.38 }
    ]);
    mocks.transactionFindMany.mockResolvedValue([
      {
        instrumentId: "inst_1",
        listingId: "lst_1",
        tradeAt: new Date("2026-02-01T00:00:00.000Z"),
        quantity: 1,
        instrument: {
          listings: [{ id: "lst_1" }]
        }
      }
    ]);

    mocks.listingFindMany.mockResolvedValue([
      { id: "lst_1", isin: "IE0000000001", currency: "EUR" }
    ]);

    mocks.dailyListingPriceFindMany.mockResolvedValue([
      {
        listingId: "lst_1",
        date: new Date("2026-02-01T00:00:00.000Z"),
        adjustedClose: 899.72982709,
        close: 899.72982709,
        currency: "EUR"
      }
    ]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-01T00:00:00.000Z"),
      days: 1,
      forceRecompute: true
    });

    const expectedReturn = 899.72982709 / 859.38 - 1;
    expect(series.points).toHaveLength(1);
    expect(series.points[0].periodReturnPct).toBeCloseTo(expectedReturn, 10);
    expect(series.points[0].returnIndex).toBeCloseTo((899.72982709 / 859.38) * 100, 6);
    expect(series.points[0].cumulativeReturnPct).toBeCloseTo(expectedReturn, 10);
  });

  it("continues return index from prior stored record", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([]);
    mocks.dailyPortfolioValueFindFirst.mockResolvedValue({
      date: new Date("2026-01-31T00:00:00.000Z"),
      valueEur: 100,
      returnIndex: 120
    });
    mocks.externalFlowSeries.mockResolvedValue([]);
    mocks.transactionFindMany.mockResolvedValue([
      {
        instrumentId: "inst_1",
        listingId: "lst_1",
        tradeAt: new Date("2026-01-31T00:00:00.000Z"),
        quantity: 10,
        instrument: {
          listings: [{ id: "lst_1" }]
        }
      }
    ]);

    mocks.listingFindMany.mockResolvedValue([
      { id: "lst_1", isin: "IE0000000001", currency: "EUR" }
    ]);

    mocks.dailyListingPriceFindMany.mockResolvedValue([
      {
        listingId: "lst_1",
        date: new Date("2026-02-01T00:00:00.000Z"),
        adjustedClose: 10,
        close: 10,
        currency: "EUR"
      }
    ]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-01T00:00:00.000Z"),
      days: 1,
      forceRecompute: true
    });

    expect(series.points[0].returnIndex).toBeCloseTo(120, 8);
  });

  it("chains from prior valuation for rolling windows instead of reseeding", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([]);
    mocks.dailyPortfolioValueFindFirst.mockResolvedValue({
      date: new Date("2026-01-31T00:00:00.000Z"),
      valueEur: 100,
      returnIndex: 130
    });
    mocks.externalFlowSeries.mockResolvedValue([
      { date: new Date("2026-02-01T00:00:00.000Z"), amountEur: -50 }
    ]);
    mocks.transactionFindMany.mockResolvedValue([
      {
        instrumentId: "inst_1",
        listingId: "lst_1",
        tradeAt: new Date("2026-01-31T00:00:00.000Z"),
        quantity: 10,
        instrument: {
          listings: [{ id: "lst_1" }]
        }
      }
    ]);

    mocks.listingFindMany.mockResolvedValue([
      { id: "lst_1", isin: "IE0000000001", currency: "EUR" }
    ]);

    mocks.dailyListingPriceFindMany.mockResolvedValue([
      {
        listingId: "lst_1",
        date: new Date("2026-02-01T00:00:00.000Z"),
        adjustedClose: 16,
        close: 16,
        currency: "EUR"
      }
    ]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-01T00:00:00.000Z"),
      days: 1,
      forceRecompute: true
    });

    expect(series.points).toHaveLength(1);
    expect(series.points[0].periodReturnPct).toBeCloseTo(0.1, 8);
    expect(series.points[0].returnIndex).toBeCloseTo(143, 8);
  });

  it("chains return index across days without external flows", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([]);
    mocks.externalFlowSeries.mockResolvedValue([]);
    mocks.transactionFindMany.mockResolvedValue([
      {
        instrumentId: "inst_1",
        listingId: "lst_1",
        tradeAt: new Date("2026-02-01T00:00:00.000Z"),
        quantity: 10,
        instrument: {
          listings: [{ id: "lst_1" }]
        }
      }
    ]);

    mocks.listingFindMany.mockResolvedValue([
      { id: "lst_1", isin: "IE0000000001", currency: "EUR" }
    ]);

    mocks.dailyListingPriceFindMany.mockResolvedValue([
      {
        listingId: "lst_1",
        date: new Date("2026-02-01T00:00:00.000Z"),
        adjustedClose: 10,
        close: 10,
        currency: "EUR"
      },
      {
        listingId: "lst_1",
        date: new Date("2026-02-02T00:00:00.000Z"),
        adjustedClose: 11,
        close: 11,
        currency: "EUR"
      },
      {
        listingId: "lst_1",
        date: new Date("2026-02-03T00:00:00.000Z"),
        adjustedClose: 12.1,
        close: 12.1,
        currency: "EUR"
      }
    ]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-03T00:00:00.000Z"),
      days: 3
    });

    expect(series.points[1].periodReturnPct).toBeCloseTo(0.1, 8);
    expect(series.points[2].periodReturnPct).toBeCloseTo(0.1, 8);
    expect(series.points[2].cumulativeReturnPct).toBeCloseTo(0.21, 8);
  });

  it("excludes unpriced listings from invested capital flows", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([]);
    mocks.externalFlowSeries.mockResolvedValue([]);
    mocks.transactionFindMany.mockResolvedValue([
      {
        instrumentId: "inst_priced",
        listingId: "lst_priced",
        tradeAt: new Date("2026-02-01T00:00:00.000Z"),
        quantity: 1,
        valueEur: 100,
        totalEur: 100,
        instrument: {
          listings: [{ id: "lst_priced" }]
        }
      },
      {
        instrumentId: "inst_unpriced",
        listingId: "lst_unpriced",
        tradeAt: new Date("2026-02-01T00:00:00.000Z"),
        quantity: 1,
        valueEur: 50,
        totalEur: 50,
        instrument: {
          listings: [{ id: "lst_unpriced" }]
        }
      }
    ]);

    mocks.listingFindMany.mockResolvedValue([
      { id: "lst_priced", isin: "IE0000000001", currency: "EUR" },
      { id: "lst_unpriced", isin: "IE0000000002", currency: "EUR" }
    ]);

    mocks.dailyListingPriceFindMany.mockResolvedValue([
      {
        listingId: "lst_priced",
        date: new Date("2026-02-01T00:00:00.000Z"),
        adjustedClose: 100,
        close: 100,
        currency: "EUR"
      }
    ]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-01T00:00:00.000Z"),
      days: 1,
      forceRecompute: true
    });

    expect(series.points).toHaveLength(1);
    expect(series.points[0].valueEur).toBe(100);
    expect(series.points[0].cumulativeReturnAmountEur).toBeCloseTo(0, 8);
  });

  it("returns empty series when no prices exist in range", async () => {
    mocks.dailyPortfolioValueFindMany.mockResolvedValue([]);
    mocks.externalFlowSeries.mockResolvedValue([]);
    mocks.transactionFindMany.mockResolvedValue([
      {
        instrumentId: "inst_1",
        listingId: "lst_1",
        tradeAt: new Date("2026-02-01T00:00:00.000Z"),
        quantity: 10,
        instrument: {
          listings: [{ id: "lst_1" }]
        }
      }
    ]);

    mocks.listingFindMany.mockResolvedValue([
      { id: "lst_1", isin: "IE0000000001", currency: "EUR" }
    ]);

    mocks.dailyListingPriceFindMany.mockResolvedValue([]);

    const series = await getOrCreateDailyPortfolioSeries("user_1", {
      endDate: new Date("2026-02-01T00:00:00.000Z"),
      days: 1,
      forceRecompute: true
    });

    expect(series.points).toHaveLength(0);
  });
});
