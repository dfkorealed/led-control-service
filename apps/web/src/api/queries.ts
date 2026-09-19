import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  type FixtureGroupMetadata,
  type FloorMapSnapshot
} from "@led-control/shared";
import { floorImportRegionListResponseSchema } from "@led-control/shared/cad-import-contracts";
import { apiGet, apiPost } from "./client";

export const MONITORING_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
export const MAP_SNAPSHOT_ERROR_RETRY_INTERVAL_MS = 30 * 1_000;

export const monitoringQueryPolicy = {
  staleTime: MONITORING_REFRESH_INTERVAL_MS,
  refetchInterval: MONITORING_REFRESH_INTERVAL_MS,
  refetchOnWindowFocus: true,
  retry: 2,
  retryDelay: 0
} as const;

export async function listFloorImportRegions(
  floorId: string,
  jobId: string,
  options: { signal?: AbortSignal } = {}
) {
  return floorImportRegionListResponseSchema.parse(
    await apiGet<unknown>(floorImportRegionPath(floorId, jobId), options)
  );
}

export async function selectFloorImportRegion(floorId: string, jobId: string, regionId: string) {
  return floorImportRegionListResponseSchema.parse(
    await apiPost<unknown>(`${floorImportRegionPath(floorId, jobId)}/select`, { regionId })
  );
}

function floorImportRegionPath(floorId: string, jobId: string) {
  return `/floors/${encodeURIComponent(floorId)}/import-jobs/${encodeURIComponent(jobId)}/regions`;
}

export interface SiteCapabilities {
  read: boolean;
  control: boolean;
  manage: boolean;
  commission: boolean;
}

export interface Dashboard {
  generatedAt: string;
  monitoringPolicy: {
    gatewayOfflineAfterSeconds: number;
    fixtureStaleAfterSeconds: number;
  };
  capabilities?: SiteCapabilities;
  site: {
    id: string;
    name: string;
    customerName: string;
    installationStatus: "pending" | "installed";
    address: string | null;
    tariffKwhRate: number | null;
    timeZone: string;
  };
  summary: {
    totalFixtures: number;
    onlineFixtures: number;
    faultFixtures: number;
    averageBrightness: number;
  };
  floors: Array<{
    id: string;
    name: string;
    level: number;
    floorPlan: { imageUrl: string; width: number; height: number; version: number } | null;
    meshControlGroups: Array<{
      gatewayId: string;
      status: "configuring" | "ready" | "failed" | "retiring" | "retired";
      version: number;
      error: string | null;
    }>;
    fixtures: Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      size?: number;
      placementStatus?: "unplaced" | "placed";
      positionVerifiedAt?: string | null;
      ratedWatt: number;
      brightness: number;
      // BIO configured brightness는 센서 모드의 설정값이며 실제 LED 출력 brightness가 아니다.
      // 실제 출력은 fixture-state read-back만 반영한다.
      bioControlMode?: "sensor" | "force-off" | "force-on" | null;
      bioConfiguredBrightness?: number | null;
      bioRawHighBrightness?: number | null;
      status: "online" | "offline" | "fault";
      statusReason?: "reported" | "mesh_publication" | "startup_resync" | "fixture_stale" | "gateway_offline" | "command_failed" | "provisioning_waiting_state" | null;
      health: { faultCodes: number[]; observedAt: string } | null;
      rssi: number | null;
      hopCount: number | null;
      commandSuccessRate: number | null;
      lastSeenAt: string | null;
      gateway: { id: string; name: string; connectionStatus: "online" | "offline" } | null;
      vehicleSensorCapabilityStatus?: "unknown" | "supported" | "unsupported";
      vehicleSensorCapabilityVerifiedAt?: string | null;
      controllable: boolean;
      controlBlockReason: "fixture_unmapped" | "gateway_offline" | "fixture_fault" | "fixture_offline" | null;
    }>;
  }>;
  groups: Array<FixtureGroupMetadata & { fixtureIds: string[] }>;
  gateways: Array<{
    id: string;
    name: string;
    serialNumber: string;
    firmwareVersion: string;
    lastHeartbeatAt: string | null;
    connectionStatus: "online" | "offline";
  }>;
}

export interface SiteSummary {
  id: string;
  name: string;
  customerName?: string;
}

export type DashboardFloor = Dashboard["floors"][number];
export type DashboardFixture = DashboardFloor["fixtures"][number];
export type DashboardGroup = Dashboard["groups"][number];

function dashboardPath(siteId?: string, includeFixtures = false) {
  const path = siteId ? `/sites/${encodeURIComponent(siteId)}/dashboard` : "/sites/default/dashboard";
  return includeFixtures ? `${path}?includeFixtures=true` : path;
}

export function useSites() {
  return useQuery({
    queryKey: ["sites"],
    queryFn: () => apiGet<SiteSummary[]>("/sites")
  });
}

export function useDashboard(siteId?: string) {
  return useQuery({
    queryKey: ["dashboard", siteId ?? "default"],
    queryFn: () => apiGet<Dashboard>(dashboardPath(siteId)),
    ...monitoringQueryPolicy
  });
}

export function useControlDashboard(siteId?: string) {
  return useQuery({
    queryKey: ["dashboard", siteId ?? "default", "with-fixtures"],
    queryFn: () => apiGet<Dashboard>(dashboardPath(siteId, true)),
    refetchInterval: 3000
  });
}

export type FixtureSnapshot = Dashboard["floors"][number]["fixtures"][number];

export interface FloorFixturePage {
  items: FixtureSnapshot[];
  nextCursor: string | null;
  generatedAt: string;
}

export function useFloorFixtures(floorId: string | undefined, siteId?: string) {
  return useInfiniteQuery({
    queryKey: ["floor-fixtures", siteId ?? "default", floorId],
    queryFn: ({ pageParam }) => {
      if (!floorId || !siteId) throw new Error("siteId and floorId are required to load fixtures");
      const search = new URLSearchParams({ limit: "200" });
      if (pageParam) search.set("cursor", pageParam);
      return apiGet<FloorFixturePage>(
        `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/fixtures?${search.toString()}`
      );
    },
    initialPageParam: "" as string,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(floorId && siteId),
    ...monitoringQueryPolicy
  });
}

export function useFloorMapSnapshot(floorId: string | undefined, siteId?: string) {
  return useQuery({
    queryKey: ["floor-map", siteId ?? "default", floorId],
    queryFn: () => {
      if (!floorId || !siteId) throw new Error("siteId and floorId are required to load a floor map");
      return apiGet<FloorMapSnapshot>(
        `/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/map-snapshot`
      );
    },
    enabled: Boolean(floorId && siteId),
    ...monitoringQueryPolicy,
    // 정상 모니터링 polling은 10분을 유지하되, 저장된 지도가 있는 갱신 실패는 빠르게 복구한다.
    refetchInterval: (query) => query.state.error
      ? MAP_SNAPSHOT_ERROR_RETRY_INTERVAL_MS
      : MONITORING_REFRESH_INTERVAL_MS
  });
}
