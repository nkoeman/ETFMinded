import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  instrumentFindMany: vi.fn(),
  snapshotUpsert: vi.fn(),
  fetchExposure: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    instrument: {
      findMany: mocks.instrumentFindMany
    },
    instrumentExposureSnapshot: {
      upsert: mocks.snapshotUpsert
    }
  }
}));

vi.mock("@/lib/ishares/isharesExposure", () => ({
  fetchIsharesExposureByIsin: mocks.fetchExposure
}));

import { ensureIsharesExposureSnapshots } from "@/lib/ishares/ensureIsharesExposure";

describe("ensureIsharesExposureSnapshots", () => {
  it("honors the failed snapshot cooldown during duplicate imports", async () => {
    mocks.instrumentFindMany.mockResolvedValue([{
      id: "inst_1", isin: "IE00TEST0001", name: "iShares Core MSCI World UCITS ETF",
      displayName: null, issuer: "iShares", securityType: "ETF", securityType2: "ETF",
      marketSector: "Funds", listings: [{ eodhdCode: "SWDA.AS", isPrimary: true }],
      exposureSnapshots: [{ source: "ISHARES", status: "FAILED",
        updatedAt: new Date("2026-02-23"), expiresAt: new Date("2026-02-24"),
        payload: null, sourceMeta: null }]
    }]);
    const result = await ensureIsharesExposureSnapshots({ userId: "user_1", onlyMissing: true });
    expect(result.attempted).toBe(0);
    expect(mocks.fetchExposure).not.toHaveBeenCalled();
    expect(mocks.snapshotUpsert).not.toHaveBeenCalled();
  });
  it("preserves a usable snapshot on refresh failure and reuses it during imports", async () => {
    mocks.instrumentFindMany.mockResolvedValue([{
      id: "inst_1", isin: "IE00TEST0001", name: "iShares Core MSCI World UCITS ETF",
      displayName: null, issuer: "iShares", securityType: "ETF", securityType2: "ETF",
      marketSector: "Funds", listings: [{ eodhdCode: "SWDA.AS", isPrimary: true }],
      exposureSnapshots: [{ source: "ISHARES", status: "READY",
        updatedAt: new Date("2025-01-01"), expiresAt: new Date("2025-02-01"),
        payload: { country: [{ country: "US", weight: 1 }], sector: [] }, sourceMeta: null }]
    }]);
    mocks.fetchExposure.mockRejectedValue(new Error("Provider unavailable"));
    const result = await ensureIsharesExposureSnapshots({ userId: "user_1", force: true });
    expect(result.failed).toBe(1);
    expect(mocks.snapshotUpsert).not.toHaveBeenCalled();
    mocks.fetchExposure.mockClear();
    const reused = await ensureIsharesExposureSnapshots({ userId: "user_1", onlyMissing: true });
    expect(reused.skippedFresh).toBe(1);
    expect(mocks.fetchExposure).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T12:00:00.000Z"));
    process.env.ISHARES_EXPOSURE_TTL_DAYS = "30";
    mocks.instrumentFindMany.mockReset();
    mocks.snapshotUpsert.mockReset();
    mocks.fetchExposure.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips fetch when snapshot was updated within the last 30 days", async () => {
    mocks.instrumentFindMany.mockResolvedValue([
      {
        id: "inst_1",
        isin: "IE00TEST0001",
        name: "iShares Core MSCI World UCITS ETF",
        displayName: "iShares Core MSCI World UCITS ETF",
        issuer: "iShares",
        securityType: "ETF",
        securityType2: "ETF",
        marketSector: "Funds",
        listings: [{ eodhdCode: "SWDA.AS", isPrimary: true }],
        exposureSnapshots: [
          {
            source: "ISHARES",
            status: "READY",
            expiresAt: new Date("2026-03-01T00:00:00.000Z"),
            updatedAt: new Date("2026-02-20T00:00:00.000Z"),
            sourceMeta: null
          }
        ]
      }
    ]);

    const result = await ensureIsharesExposureSnapshots({ userId: "user_1" });

    expect(result.selected).toBe(1);
    expect(result.skippedFresh).toBe(1);
    expect(result.attempted).toBe(0);
    expect(mocks.fetchExposure).not.toHaveBeenCalled();
    expect(mocks.snapshotUpsert).not.toHaveBeenCalled();
  });

  it("uses upsert keyed by (instrumentId, source) for idempotency", async () => {
    mocks.instrumentFindMany.mockResolvedValue([
      {
        id: "inst_1",
        isin: "IE00TEST0001",
        name: "iShares Core MSCI World UCITS ETF",
        displayName: "iShares Core MSCI World UCITS ETF",
        issuer: "iShares",
        securityType: "ETF",
        securityType2: "ETF",
        marketSector: "Funds",
        listings: [{ eodhdCode: "SWDA.AS", isPrimary: true }],
        exposureSnapshots: []
      }
    ]);
    mocks.fetchExposure.mockResolvedValue({
      asOfDate: new Date("2026-01-31T00:00:00.000Z"),
      payload: {
        country: [{ country: "US", weight: 0.6 }],
        sector: [{ sector: "Information Technology", weight: 0.25 }]
      },
      sourceMeta: { parsingMode: "PRODUCT_PAGE" }
    });

    await ensureIsharesExposureSnapshots({ userId: "user_1" });
    await ensureIsharesExposureSnapshots({ userId: "user_1" });

    expect(mocks.snapshotUpsert).toHaveBeenCalledTimes(2);
    for (const call of mocks.snapshotUpsert.mock.calls) {
      expect(call[0].where.instrumentId_source).toEqual({
        instrumentId: "inst_1",
        source: "ISHARES"
      });
    }
  });

  it("retries a failed snapshot after its short retry TTL", async () => {
    mocks.instrumentFindMany.mockResolvedValue([
      {
        id: "inst_1",
        isin: "IE00TEST0001",
        name: "iShares Core MSCI World UCITS ETF",
        displayName: "iShares Core MSCI World UCITS ETF",
        issuer: "iShares",
        securityType: "ETF",
        securityType2: "ETF",
        marketSector: "Funds",
        listings: [{ eodhdCode: "SWDA.AS", isPrimary: true }],
        exposureSnapshots: [
          {
            source: "ISHARES",
              status: "FAILED",
              expiresAt: new Date("2026-02-22T00:00:00.000Z"),
            updatedAt: new Date("2025-12-01T00:00:00.000Z"),
            sourceMeta: null
          }
        ]
      }
    ]);
    mocks.fetchExposure.mockResolvedValue({
      asOfDate: new Date("2026-01-31T00:00:00.000Z"),
      payload: {
        country: [{ country: "US", weight: 0.6 }],
        sector: [{ sector: "Information Technology", weight: 0.25 }]
      },
      sourceMeta: { parsingMode: "PRODUCT_PAGE" }
    });

    const result = await ensureIsharesExposureSnapshots({ userId: "user_1" });

    expect(result.attempted).toBe(1);
    expect(result.skippedFresh).toBe(0);
    expect(mocks.fetchExposure).toHaveBeenCalledTimes(1);
  });

  it.each(["404 Not Found", "429 Too Many Requests"])(
    "persists FAILED snapshot with short retry ttl on provider failure (%s)",
    async (message) => {
      mocks.instrumentFindMany.mockResolvedValue([
        {
          id: "inst_1",
          isin: "IE00TEST0001",
          name: "iShares Core MSCI World UCITS ETF",
          displayName: "iShares Core MSCI World UCITS ETF",
          issuer: "iShares",
          securityType: "ETF",
          securityType2: "ETF",
          marketSector: "Funds",
          listings: [{ eodhdCode: "SWDA.AS", isPrimary: true }],
          exposureSnapshots: []
        }
      ]);
      mocks.fetchExposure.mockRejectedValue(new Error(message));

      const result = await ensureIsharesExposureSnapshots({ userId: "user_1" });

      expect(result.failed).toBe(1);
      expect(mocks.snapshotUpsert).toHaveBeenCalledTimes(1);
      const upsertPayload = mocks.snapshotUpsert.mock.calls[0][0];
      expect(upsertPayload.update.status).toBe("FAILED");
      expect(upsertPayload.update.errorMessage).toContain(message.split(" ")[0]);
      expect(upsertPayload.update.expiresAt.toISOString()).toBe("2026-02-24T12:00:00.000Z");
    }
  );
});
