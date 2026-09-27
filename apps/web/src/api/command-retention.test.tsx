import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useCommandStatus, type CommandStatusResponse } from "./commands";

const status: CommandStatusResponse = { id: "old", stage: "verified_not_applied", createdAt: "2026-05-31T12:00:00.000Z", brightness: 37, targetFixtureIds: ["private-fixture"], dispatchCount: 1, completedFixtureCount: 1, totalFixtureCount: 1, errorMessage: null, dispatches: [] };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useCommandStatus("old"), { wrapper }) };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); focusManager.setFocused(undefined); onlineManager.setOnline(true); });
describe("retained command authority", () => {
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
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
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
  it("hides a settled command one millisecond beyond the calendar cutoff and revalidates", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-31T11:59:59.999Z"));
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => status }); vi.stubGlobal("fetch", fetch);
    const { result } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.brightness).toBe(37);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data).toBeUndefined();
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
  });
  it.each(["focus", "reconnect"])("revalidates settled detail on %s even under inherited infinite staleTime", async (event) => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-30T00:00:00Z"));
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => status }).mockRejectedValue(new TypeError("offline")); vi.stubGlobal("fetch", fetch);
    const { result, client } = setup(); client.setDefaultOptions({ queries: { staleTime: Infinity } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => { if (event === "focus") { focusManager.setFocused(false); focusManager.setFocused(true); } else { onlineManager.setOnline(false); onlineManager.setOnline(true); } });
    await waitFor(() => expect(result.current.data).toBeUndefined());
  });
});
