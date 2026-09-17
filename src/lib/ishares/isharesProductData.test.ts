import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("./isharesClient", () => ({ isharesGetJson: mocks.json }));
import { parseIsharesProductData } from "./isharesProductData";

const container = (names: unknown[], weights: unknown[]) => ({ dataPointsByNameMap: {
  type: { value: names }, fund: { value: weights }, asOf: { value: 20260915 }
} });
const response = { componentsByNameMap: { exposureBreakdowns: { containersByNameMap: {
  geography: { subContainersByNameMap: { countries: container(["Taiwan", "Korea (South)"], [27.49, 19.96]) } },
  sector: container(["Information Technology", "Financials"], [39.56, 19.19])
} } } };

describe("current iShares product feed", () => {
  beforeEach(() => { vi.resetModules(); mocks.json.mockReset(); });
  it("parses published country/sector weights and their as-of date", () => {
    const result = parseIsharesProductData(response);
    expect(result.payload.country[0]).toEqual({ country: "Taiwan", weight: 0.2749 });
    expect(result.payload.sector[0].weight).toBeCloseTo(0.3956);
    expect(result.asOfDate?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });
  it("rejects empty provider data rather than inventing exposure", () => {
    expect(() => parseIsharesProductData({})).toThrow("no exposure");
  });
  it("matches exact ISIN, uses the correct product ID, and reuses the catalog", async () => {
    const { fetchIsharesProductData } = await import("./isharesProductData");
    mocks.json.mockResolvedValueOnce({
      1: { isin: "WRONG", productPageUrl: "/uk/individual/en/products/1/other" },
      264659: { isin: "IE00BKM4GZ66", productPageUrl: "/uk/individual/en/products/264659/em-imi" }
    }).mockResolvedValue(response);
    await fetchIsharesProductData("IE00BKM4GZ66", {});
    expect(mocks.json.mock.calls[1][0]).toContain("portfolioId=264659");
    expect(await fetchIsharesProductData("MISSING", {})).toBeNull();
    expect(mocks.json).toHaveBeenCalledTimes(2);
  });
  it("does not align mismatched label and weight arrays", () => {
    expect(() => parseIsharesProductData({ componentsByNameMap: { exposureBreakdowns: {
      containersByNameMap: { sector: container(["A", "B"], [100]) }
    } } })).toThrow("no exposure");
  });
});
