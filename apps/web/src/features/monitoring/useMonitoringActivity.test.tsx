import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitoringActivityQueryKey, useMonitoringActivity } from "./useMonitoringActivity";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../../api/client", () => ({ apiGet }));

const response = {
  generatedAt: "2026-09-25T00:00:00.000Z",
  retainedFrom: "2026-06-25T00:00:00.000Z",
  items: [{ id: "00000000-0000-4000-8000-000000000001", kind: "fixture_online", recordedAt: "2026-09-25T00:00:00.000Z", displayName: "B-04" }],
  nextCursor: "page-two"
};

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useMonitoringActivity", () => {
  afterEach(() => { apiGet.mockReset(); });

  it("keeps retained items stable on an unrelated consumer render", async () => {
    apiGet.mockResolvedValue(response);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(() => useMonitoringActivity({ principal: "user-1", siteId: "site-1", floorId: "floor-1" }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    const previous = result.current.data?.items;
    rerender();
    expect(result.current.data?.items).toBe(previous);
  });

  it("scopes a paired inclusive local-date period and page size in the request and cache", async () => {
    apiGet.mockResolvedValue(response);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const scope = { principal: "user-1", siteId: "site-1", floorId: "floor-1", limit: 1000, fromDate: "2026-09-01", toDate: "2026-09-25" };
    const { result } = renderHook(() => useMonitoringActivity(scope), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    expect(apiGet).toHaveBeenCalledWith("/sites/site-1/floors/floor-1/monitoring-activity?limit=1000&fromDate=2026-09-01&toDate=2026-09-25", expect.any(Object));
    expect(monitoringActivityQueryKey(scope)).not.toEqual(monitoringActivityQueryKey({ ...scope, toDate: "2026-09-24" }));
  });

  it("ignores a late prior period response after the current period succeeds", async () => {
    let resolveOld!: (value: unknown) => void;
    apiGet.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce({ ...response, items: [{ ...response.items[0], displayName: "current period" }] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(({ toDate }) => useMonitoringActivity({ principal: "user-1", siteId: "site-1", floorId: "floor-1", limit: 50, fromDate: "2026-09-01", toDate }), { initialProps: { toDate: "2026-09-24" }, wrapper: wrapperFor(client) });
    rerender({ toDate: "2026-09-25" });
    await waitFor(() => expect(result.current.data?.items[0]?.displayName).toBe("current period"));
    await act(async () => resolveOld(response));
    expect(result.current.data?.items[0]?.displayName).toBe("current period");
  });

  it("keeps principal, site, floor, limit and cursor in a scoped key and URL", async () => {
    apiGet.mockResolvedValue(response);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const scope = { principal: "user-1:org-1", siteId: "site/1", floorId: "floor/2", limit: 5, cursor: "opaque+/=" };
    const { result } = renderHook(() => useMonitoringActivity(scope), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    expect(monitoringActivityQueryKey(scope)).toEqual(["monitoring-activity", "user-1:org-1", "site/1", "floor/2", 5, "opaque+/=", "", ""]);
    expect(apiGet).toHaveBeenCalledWith("/sites/site%2F1/floors/floor%2F2/monitoring-activity?limit=5&cursor=opaque%2B%2F%3D", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.current.data?.retainedFrom).toBe(response.retainedFrom);
  });

  it("does not fetch without every authorization scope part", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useMonitoringActivity({ principal: null, siteId: "site-1", floorId: "floor-1" }), { wrapper: wrapperFor(client) });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("rejects malformed responses instead of manufacturing an empty history", async () => {
    apiGet.mockResolvedValue({ ...response, retainedFrom: undefined });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMonitoringActivity({ principal: "user-1", siteId: "site-1", floorId: "floor-1" }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("hides the last successful page on a same-scope refresh failure", async () => {
    apiGet.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("temporary activity outage"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const scope = { principal: "user-1", siteId: "site-1", floorId: "floor-1" };
    const { result } = renderHook(() => {
      const query = useMonitoringActivity(scope);
      return { data: query.data, isRefetchError: query.isRefetchError, refetch: query.refetch };
    }, { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.isRefetchError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("does not expose a previous principal or floor page when the new scope fails", async () => {
    apiGet.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("new scope unavailable"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ principal, floorId }) => useMonitoringActivity({ principal, siteId: "site-1", floorId }),
      { initialProps: { principal: "user-1", floorId: "floor-1" }, wrapper: wrapperFor(client) }
    );
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    rerender({ principal: "user-2", floorId: "floor-2" });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(apiGet).toHaveBeenCalledWith("/sites/site-1/floors/floor-2/monitoring-activity?limit=5", expect.any(Object));
  });
});
