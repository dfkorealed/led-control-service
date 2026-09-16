import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  MAP_SNAPSHOT_ERROR_RETRY_INTERVAL_MS,
  MONITORING_REFRESH_INTERVAL_MS,
  useDashboard,
  useFloorFixtures,
  useFloorMapSnapshot
} from "./queries";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("./client", () => ({ apiGet }));

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useFloorFixtures", () => {
  it("binds fixture requests to the selected site URL while retaining pagination parameters", async () => {
    apiGet.mockResolvedValue({ items: [], nextCursor: null });
    const client = createQueryClient();

    renderHook(() => useFloorFixtures("floor-1", "site-2"), { wrapper: wrapperFor(client) });

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith("/sites/site-2/floors/floor-1/fixtures?limit=200");
    });
  });

  it("refreshes monitoring fixture snapshots every 10 minutes with bounded retries and focus refetch", async () => {
    apiGet.mockResolvedValue({ items: [], nextCursor: null, generatedAt: "2026-09-12T00:00:00.000Z" });
    const client = createQueryClient();

    renderHook(() => useFloorFixtures("floor-1", "site-2"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(client.getQueryCache().find({ queryKey: ["floor-fixtures", "site-2", "floor-1"] })).toBeDefined());
    const options = client.getQueryCache().find({ queryKey: ["floor-fixtures", "site-2", "floor-1"] })?.options as
      | { refetchInterval?: unknown; staleTime?: unknown; refetchOnWindowFocus?: unknown; retry?: unknown }
      | undefined;

    expect(options?.refetchInterval).toBe(600_000);
    expect(options?.staleTime).toBe(600_000);
    expect(options?.refetchOnWindowFocus).toBe(true);
    expect(options?.retry).toBe(2);
  });
});

describe("useFloorMapSnapshot", () => {
  it("uses the normal refresh interval until a map failure needs faster recovery", async () => {
    apiGet.mockResolvedValue({
      floorId: "floor-1",
      revision: 3,
      width: 1200,
      height: 800,
      floorPlan: null,
      objects: []
    });
    const client = createQueryClient();

    renderHook(() => useFloorMapSnapshot("floor-1", "site-2"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/sites/site-2/floors/floor-1/map-snapshot"));
    const options = client.getQueryCache().find({ queryKey: ["floor-map", "site-2", "floor-1"] })?.options as
      | { refetchInterval?: unknown; staleTime?: unknown; refetchOnWindowFocus?: unknown }
      | undefined;
    const refetchInterval = options?.refetchInterval as ((query: { state: { error: Error | null } }) => number) | undefined;

    expect(refetchInterval).toBeTypeOf("function");
    expect(refetchInterval?.({ state: { error: null } })).toBe(MONITORING_REFRESH_INTERVAL_MS);
    expect(refetchInterval?.({ state: { error: new Error("map unavailable") } })).toBe(MAP_SNAPSHOT_ERROR_RETRY_INTERVAL_MS);
    expect(options).toMatchObject({ staleTime: 600_000, refetchOnWindowFocus: true, retry: 2 });
  });
});

describe("useDashboard", () => {
  it("refreshes monitoring metadata every 10 minutes with bounded retries and focus refetch", async () => {
    apiGet.mockResolvedValue({
      generatedAt: "2026-09-12T00:00:00.000Z",
      monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200 },
      site: { id: "site-2", name: "현장" }, summary: {}, floors: [], groups: [], gateways: []
    });
    const client = createQueryClient();

    renderHook(() => useDashboard("site-2"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(client.getQueryCache().find({ queryKey: ["dashboard", "site-2"] })).toBeDefined());
    const options = client.getQueryCache().find({ queryKey: ["dashboard", "site-2"] })?.options as
      | { refetchInterval?: unknown; staleTime?: unknown; refetchOnWindowFocus?: unknown; retry?: unknown }
      | undefined;

    expect(options?.refetchInterval).toBe(600_000);
    expect(options?.staleTime).toBe(600_000);
    expect(options?.refetchOnWindowFocus).toBe(true);
    expect(options?.retry).toBe(2);
  });
});
