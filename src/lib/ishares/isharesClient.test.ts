import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("iShares HTTP retry policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
    vi.stubEnv("ISHARES_MIN_DELAY_MS", "1");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([400, 403, 404])("does not retry permanent HTTP %s errors", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Unavailable", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const { isharesRequest } = await import("./isharesClient");
    await expect(isharesRequest("https://www.ishares.com/test")).rejects.toThrow(`(${status})`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([429, 503])("still retries transient HTTP %s errors", async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Try later", { status }))
      .mockResolvedValueOnce(new Response("OK"));
    vi.stubGlobal("fetch", fetchMock);
    const { isharesRequest } = await import("./isharesClient");
    const result = isharesRequest("https://www.ishares.com/test");
    await vi.runAllTimersAsync();
    expect((await result).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
