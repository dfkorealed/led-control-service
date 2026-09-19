import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  listFloorImportRegions,
  MAP_SNAPSHOT_ERROR_RETRY_INTERVAL_MS,
  MONITORING_REFRESH_INTERVAL_MS,
  selectFloorImportRegion,
  useDashboard,
  useFloorFixtures,
  useFloorMapSnapshot
} from "./queries";

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock("./client", () => ({ apiGet, apiPost }));

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("CAD import region API", () => {
  const response = {
    jobId: "00000000-0000-4000-8000-000000000001",
    selectionStatus: "selection_required" as const,
    selectedRegionId: null,
    excludedRegionPrimitiveCount: 7,
    regions: [
      {
        regionId: "region/1",
        bounds: { minX: 0, minY: 0, maxX: 2_000, maxY: 1_000 },
        primitiveCount: 1_200,
        textCount: 20,
        lightCandidateCount: 12,
        area: 2_000_000,
        preview: {
          assetId: "00000000-0000-4000-8000-000000000010",
          width: 640,
          height: 320,
          byteSize: 1_024,
          sha256: "a".repeat(64)
        }
      },
      {
        regionId: "region-2",
        bounds: { minX: 4_000, minY: 0, maxX: 4_500, maxY: 500 },
        primitiveCount: 120,
        textCount: 4,
        lightCandidateCount: 2,
        area: 250_000,
        preview: {
          assetId: "00000000-0000-4000-8000-000000000011",
          width: 320,
          height: 320,
          byteSize: 512,
          sha256: "b".repeat(64)
        }
      }
    ]
  };

  it("uses encoded endpoints and validates region list/select responses", async () => {
    apiGet.mockResolvedValueOnce(response);
    apiPost.mockResolvedValueOnce({
      ...response,
      selectionStatus: "selected",
      selectedRegionId: "region/1"
    });

    await expect(listFloorImportRegions("floor/1", response.jobId)).resolves.toEqual(response);
    await expect(selectFloorImportRegion("floor/1", response.jobId, "region/1")).resolves.toMatchObject({
      selectionStatus: "selected",
      selectedRegionId: "region/1"
    });

    const base = `/floors/floor%2F1/import-jobs/${response.jobId}`;
    expect(apiGet).toHaveBeenCalledWith(`${base}/regions`, {});
    expect(apiPost).toHaveBeenCalledWith(`${base}/regions/select`, { regionId: "region/1" });
  });

  it("rejects a malformed region response before the UI can hydrate it", async () => {
    apiGet.mockResolvedValueOnce({ ...response, regions: [{ ...response.regions[0], primitiveCount: -1 }] });

    await expect(listFloorImportRegions("floor-1", response.jobId)).rejects.toBeDefined();
  });

  it("requires and preserves the CAD analyzer excluded primitive count", async () => {
    apiGet.mockResolvedValueOnce({ ...response, excludedRegionPrimitiveCount: undefined });
    await expect(listFloorImportRegions("floor-1", response.jobId)).rejects.toBeDefined();

    apiGet.mockResolvedValueOnce(response);
    await expect(listFloorImportRegions("floor-1", response.jobId)).resolves.toMatchObject({
      excludedRegionPrimitiveCount: 7
    });
  });

  it("forwards an abort signal for bounded region recovery", async () => {
    const controller = new AbortController();
    apiGet.mockResolvedValueOnce(response);

    await expect(listFloorImportRegions("floor-1", response.jobId, {
      signal: controller.signal
    })).resolves.toEqual(response);

    expect(apiGet).toHaveBeenCalledWith(
      `/floors/floor-1/import-jobs/${response.jobId}/regions`,
      { signal: controller.signal }
    );
  });
});

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
