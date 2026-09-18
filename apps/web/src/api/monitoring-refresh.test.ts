import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMonitoringRefresh, startMonitoringRefresh, waitForMonitoringRefresh } from "./monitoring-refresh";

const started = { id: "refresh-1", status: "pending", totalFixtures: 2, terminalStatusUrl: "https://untrusted.invalid/refresh" };
const completed = { id: "refresh-1", status: "completed", totalFixtures: 2, onlineFixtures: 1, offlineFixtures: 1, unverifiedFixtures: 0, completedAt: "2026-09-15T08:00:05.000Z" };
const input = { siteId: "site-1", floorId: "floor-1", clientRequestId: "request-1" };
const fetchMock = vi.fn();
beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const respond = (body: unknown) => Response.json(body);

describe("monitoring refresh client", () => {
  it("posts only the request identity and polls the scoped URL every 500ms", async () => {
    fetchMock.mockResolvedValueOnce(respond(started)).mockResolvedValueOnce(respond({ ...completed, status: "pending", completedAt: null }))
      .mockResolvedValueOnce(respond(completed));
    const result = waitForMonitoringRefresh(input);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toMatchObject(["/api/sites/site-1/floors/floor-1/monitoring-refreshes", { method: "POST", body: '{"clientRequestId":"request-1"}' }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sites/site-1/monitoring-refreshes/refresh-1");
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual(completed);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads detailed counts immediately when POST reuses a terminal request", async () => {
    fetchMock.mockResolvedValueOnce(respond({ ...started, status: "completed" })).mockResolvedValueOnce(respond(completed));
    await expect(waitForMonitoringRefresh(input)).resolves.toEqual(completed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { ...started, status: "running" }, { ...started, id: "" }, { ...started, totalFixtures: -1 }, { ...started, totalFixtures: 1.5 }])("rejects malformed POST data: %j", async (body) => {
    fetchMock.mockResolvedValue(respond(body));
    await expect(startMonitoringRefresh("site-1", "floor-1", "request-1")).rejects.toThrow();
  });

  it.each([null, {}, { ...completed, status: "done" }, { ...completed, totalFixtures: -1 }, { ...completed, onlineFixtures: -1 }, { ...completed, offlineFixtures: "1" }, { ...completed, unverifiedFixtures: 0.5 }, { ...completed, onlineFixtures: undefined }, { ...completed, completedAt: "invalid" }, { ...completed, id: "other-refresh" }])("rejects malformed GET data: %j", async (body) => {
    fetchMock.mockResolvedValue(respond(body));
    await expect(getMonitoringRefresh("site-1", "refresh-1")).rejects.toThrow();
  });

  it.each(["pending", "completed", "partial", "failed", "expired"])("accepts documented status %s and strips internal fields", async (status) => {
    fetchMock.mockResolvedValue(respond({ ...completed, status, rawError: "secret" }));
    await expect(getMonitoringRefresh("site-1", "refresh-1")).resolves.toEqual({ ...completed, status });
  });

  it("aborts the polling delay without another network request", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(respond(started));
    const result = waitForMonitoringRefresh({ ...input, signal: controller.signal });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["POST", "GET"])("aborts an in-flight %s request", async (method) => {
    const controller = new AbortController();
    if (method === "GET") fetchMock.mockResolvedValueOnce(respond(started));
    fetchMock.mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const result = waitForMonitoringRefresh({ ...input, signal: controller.signal });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(500);
    const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    controller.abort();
    await rejection;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled POST to 30 seconds", async () => {
    fetchMock.mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }));
    const result = waitForMonitoringRefresh(input);
    const rejection = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [29_999, "completed"],
    [31_000, "partial"],
    [31_000, "expired"]
  ])("allows a terminal result after %dms of server processing (%s), separately from POST latency", async (terminalAfter, status) => {
    const createdAt = Date.now() + 4_000;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(respond(started)), 4_000)));
    fetchMock.mockImplementation(() => Promise.resolve(respond(Date.now() - createdAt >= terminalAfter
      ? { ...completed, status }
      : { ...completed, status: "pending", completedAt: null })));
    const outcome = waitForMonitoringRefresh(input).then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(4_000 + Math.ceil(terminalAfter / 500) * 500);
    await expect(outcome).resolves.toEqual({ value: { ...completed, status } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pending", "stalled GET"])("bounds %s to 35 seconds after POST succeeds", async (mode) => {
    fetchMock.mockResolvedValueOnce(respond(started));
    fetchMock.mockImplementation((_path, init) => mode === "pending"
      ? Promise.resolve(respond({ ...completed, status: "pending", completedAt: null }))
      : new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); }));
    let settled = false;
    const outcome = waitForMonitoringRefresh(input).then(() => { settled = true; }, (error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({ name: "TimeoutError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, null, "2026-09-15T08:00:05.000Z"])("accepts optional completedAt %s and normalizes absent timestamps to null", async (completedAt) => {
    fetchMock.mockResolvedValue(respond({ ...completed, completedAt }));
    await expect(getMonitoringRefresh("site-1", "refresh-1")).resolves.toEqual({ ...completed, completedAt: completedAt ?? null });
  });
});
