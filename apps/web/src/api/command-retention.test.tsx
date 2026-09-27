import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detailRetainedFrom, isRetainedByClock, withRetentionClock } from "./detail-retention";
import type { ReactNode } from "react";
import { useCommandStatus, type CommandStatusResponse } from "./commands";

const status: CommandStatusResponse = { get generatedAt() { return new Date().toISOString(); }, get retainedFrom() { return new Date(detailRetainedFrom(Date.now())).toISOString(); }, id: "old", stage: "verified_not_applied", createdAt: "2026-05-31T12:00:00.000Z", brightness: 37, targetFixtureIds: ["private-fixture"], dispatchCount: 1, completedFixtureCount: 1, totalFixtureCount: 1, errorMessage: null, dispatches: [] };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useCommandStatus("old"), { wrapper }) };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); focusManager.setFocused(undefined); onlineManager.setOnline(true); });
describe("retained command authority", () => {
  it("never restores a response that crosses the first exclusion during transit across clamped midnight", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const pending = withRetentionClock(() => new Promise<{ generatedAt: string; retainedFrom: string }>((resolve) =>
      setTimeout(() => resolve({ generatedAt: "2026-05-28T23:59:59.800Z", retainedFrom: "2026-02-28T23:59:59.800Z" }), 1200)));
    await vi.advanceTimersByTimeAsync(1200);
    const response = await pending;
    expect(isRetainedByClock("2026-02-28T23:59:59.900Z", response.retentionClock)).toBe(false);
  });
  it.each([{}, { generatedAt: "invalid", retainedFrom: "2026-06-27T12:00:00Z" },
    { generatedAt: "2026-09-27T12:00:00Z", retainedFrom: "2026-06-26T12:00:00Z" }])("fails closed without a valid DB anchor %j", async (anchor) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...status, generatedAt: undefined, retainedFrom: undefined, ...anchor }) }));
    const { result } = setup();
    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isDetailCurrent()).toBe(false);
  });
  it("preserves legacy OFF-mode old detail under fresh server authority and hides it on error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...status,
      createdAt: "2020-01-01T00:00:00Z", retentionEnabled: false }) }).mockRejectedValue(new TypeError("offline")));
    const { result } = setup();
    await waitFor(() => expect(result.current.data?.brightness).toBe(37));
    expect(result.current.isDetailCurrent()).toBe(true);
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.data).toBeUndefined());
    expect(result.current.isDetailCurrent()).toBe(false);
  });
  it.each([-60_000, 60_000])("expires by server time under browser skew %s including response transit", async (skew) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const server = Date.parse("2026-09-27T11:59:59.000Z");
    vi.setSystemTime(server + skew);
    const fetch = vi.fn().mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({
      ok: true, json: async () => ({ ...status, createdAt: "2026-06-27T12:00:00.000Z",
        generatedAt: new Date(server).toISOString(), retainedFrom: "2026-06-27T11:59:59.000Z" })
    }), 400))).mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const { result } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(401); });
    expect(result.current.data?.brightness).toBe(37);
    const authority = result.current.isDetailCurrent;
    expect(authority()).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(authority()).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });
  it("rejects a stale action synchronously when its query is invalidated or removed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-30T00:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => status }).mockImplementation(() => new Promise(() => undefined)));
    const { client, result } = setup();
    await waitFor(() => expect(result.current.data).toBeDefined());
    const authority = result.current.isDetailCurrent;
    expect(authority()).toBe(true);
    void client.invalidateQueries({ queryKey: ["command-status", "old"] });
    expect(authority()).toBe(false);
    client.removeQueries({ queryKey: ["command-status", "old"] });
    expect(authority()).toBe(false);
  });
  it.each([401, 403, 404, 410, 500])("hides cached detail while refetching and after HTTP %s", async (code) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-31T11:59:50Z"));
    let rejectRead: (response: unknown) => void = () => undefined;
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => status }).mockImplementation(() => new Promise((resolve) => { rejectRead = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const { client, result } = setup();
    await waitFor(() => expect(result.current.data?.brightness).toBe(37));
    let pending!: Promise<void>;
    act(() => { pending = client.invalidateQueries({ queryKey: ["command-status", "old"] }); });
    await waitFor(() => expect(result.current.data).toBeUndefined());
    await act(async () => { rejectRead({ ok: false, status: code, headers: { get: () => "application/json" }, json: async () => ({ code: code === 410 ? "command_expired" : "unavailable" }) }); await pending; });
    expect(result.current.data).toBeUndefined();
  });
  it.each([
    ["2026-05-31T12:00:00.000Z", "2026-08-31T12:00:00.000Z"],
    ["2026-02-28T23:00:00.000Z", "2026-05-28T23:00:00.000Z"],
    ["2026-02-28T23:00:00.000Z", "2026-05-29T23:00:00.000Z"],
    ["2026-02-28T23:00:00.000Z", "2026-05-30T23:00:00.000Z"],
    ["2024-02-29T23:30:00.000Z", "2024-05-29T23:30:00.000Z"],
    ["2024-02-29T23:30:00.000Z", "2024-05-30T23:30:00.000Z"],
    ["2024-02-29T23:30:00.000Z", "2024-05-31T23:30:00.000Z"],
    ["2026-02-28T23:59:59.999Z", "2026-05-31T23:59:59.999Z"],
    ["2025-11-30T23:00:00.000Z", "2026-02-28T23:59:59.999Z"]
  ])("hides settled %s one millisecond beyond cutoff %s and revalidates", async (createdAt, boundary) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); vi.setSystemTime(new Date(Date.parse(boundary) - 1));
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...status, createdAt }) }); vi.stubGlobal("fetch", fetch);
    const { result } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.brightness).toBe(37);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data).toBeUndefined();
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });
  it("fails closed for timestamp-less detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...status, createdAt: undefined }) }).mockRejectedValue(new TypeError("offline")));
    const { result } = setup();
    await waitFor(() => expect(result.current.isFetched).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isDetailCurrent()).toBe(false);
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.data).toBeUndefined());
    expect(result.current.isDetailCurrent()).toBe(false);
  });
  it.each(["focus", "native-focus", "reconnect"])("revalidates settled detail on %s even under inherited infinite staleTime", async (event) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-30T00:00:00Z"));
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => status }).mockRejectedValue(new TypeError("offline")); vi.stubGlobal("fetch", fetch);
    const { result, client } = setup(); client.setDefaultOptions({ queries: { staleTime: Infinity } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => { if (event === "native-focus") window.dispatchEvent(new Event("focus"));
      else if (event === "focus") { focusManager.setFocused(false); focusManager.setFocused(true); } else { onlineManager.setOnline(false); onlineManager.setOnline(true); } });
    await waitFor(() => expect(result.current.data).toBeUndefined());
  });
});
