import { infiniteQueryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, apiPatch } from "./client";
import { monitoringQueryPolicy } from "./queries";

export type IncidentType = "gateway_offline" | "fixture_stale" | "fixture_fault" | "command_failed";
export type IncidentStatus = "open" | "acknowledged" | "resolved";
export const incidentTypeLabels: Record<IncidentType, string> = {
  gateway_offline: "게이트웨이 오프라인", fixture_stale: "조명 수신 지연", fixture_fault: "조명 장애", command_failed: "명령 실패"
};
export const incidentStatusLabels: Record<IncidentStatus, string> = { open: "미확인", acknowledged: "확인됨", resolved: "해결됨" };
type IncidentActor = { id: string; name: string; loginId: string };
export interface MonitoringIncident {
  id: string;
  siteId: string;
  type: IncidentType;
  status: IncidentStatus;
  target: { kind: "fixture"; id: string; name: string; floorId: string } | { kind: "gateway"; id: string; name: string };
  openedAt: string;
  lastObservedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  acknowledgedBy: IncidentActor | null;
  assignedTo: IncidentActor | null;
  resolvedBy: IncidentActor | null;
  resolutionKind: "automatic_recovery" | "operator_confirmed" | null;
  resolutionNote: string | null;
}
export interface IncidentPage { incidents: MonitoringIncident[]; activeCount: number; nextCursor: string | null }
export interface IncidentFilters { status?: IncidentStatus | "all"; type?: IncidentType | "all"; limit?: number }
export type IncidentAction = { action: "acknowledge" } | { action: "assign"; userId: string | null } | { action: "resolve"; note: string };
export type IncidentUpdate = IncidentAction & { expectedUpdatedAt: string };
export interface MonitoringPolicy { id: string; gatewayOfflineAfterSeconds: number; fixtureStaleAfterSeconds: number; updatedAt: string }
export type PolicyUpdate = Omit<MonitoringPolicy, "id" | "updatedAt"> & { expectedUpdatedAt: string };

export const monitoringIncidentsQueryKey = (siteId: string) => ["monitoring-incidents", siteId] as const;
export const monitoringPolicyQueryKey = (siteId: string) => ["monitoring-policy", siteId] as const;
const sitePath = (siteId: string) => `/sites/${encodeURIComponent(siteId)}`;

export function monitoringIncidentsOptions(siteId: string, filters: IncidentFilters = {}) {
  const normalized = { status: filters.status ?? "all", type: filters.type ?? "all", limit: filters.limit ?? 20 };
  return infiniteQueryOptions({
    queryKey: [...monitoringIncidentsQueryKey(siteId), normalized],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ status: normalized.status });
      if (normalized.type !== "all") params.set("type", normalized.type);
      params.set("limit", String(normalized.limit));
      if (pageParam) params.set("cursor", pageParam);
      return apiGet<IncidentPage>(`${sitePath(siteId)}/monitoring-incidents?${params}`);
    },
    initialPageParam: "",
    getNextPageParam: (page: IncidentPage) => page.nextCursor ?? undefined,
    enabled: Boolean(siteId),
    ...monitoringQueryPolicy
  });
}
export function useMonitoringIncidents(siteId: string, filters: IncidentFilters = {}) {
  return useInfiniteQuery(monitoringIncidentsOptions(siteId, filters));
}
export function useMonitoringPolicy(siteId: string) {
  return useQuery({ queryKey: monitoringPolicyQueryKey(siteId), queryFn: () => apiGet<MonitoringPolicy>(`${sitePath(siteId)}/monitoring-policy`), enabled: Boolean(siteId), ...monitoringQueryPolicy });
}

export async function saveMonitoringIncident(client: QueryClient, siteId: string, incidentId: string, input: IncidentUpdate) {
  try {
    const result = await apiPatch<MonitoringIncident>(`${sitePath(siteId)}/monitoring-incidents/${encodeURIComponent(incidentId)}`, input);
    await client.invalidateQueries({ queryKey: monitoringIncidentsQueryKey(siteId) });
    return result;
  } catch (error) {
    // A stale row must be refreshed for the operator to review; a write is never replayed automatically.
    if (error instanceof ApiError && error.status === 409) await client.invalidateQueries({ queryKey: monitoringIncidentsQueryKey(siteId) });
    throw error;
  }
}
export function useMonitoringIncidentMutation(siteId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ incidentId, ...input }: IncidentUpdate & { incidentId: string }) => saveMonitoringIncident(client, siteId, incidentId, input), retry: false });
}
export async function saveMonitoringPolicy(client: QueryClient, siteId: string, input: PolicyUpdate) {
  try {
    const result = await apiPatch<MonitoringPolicy>(`${sitePath(siteId)}/monitoring-policy`, input);
    await Promise.all([
      monitoringPolicyQueryKey(siteId), ["dashboard", siteId], ["floor-fixtures", siteId], monitoringIncidentsQueryKey(siteId)
    ].map((queryKey) => client.invalidateQueries({ queryKey })));
    // The default route is an alias, not a tenant key. Match its cached site before invalidating it.
    await client.invalidateQueries({ queryKey: ["dashboard", "default"], predicate: (query) => (query.state.data as { site?: { id?: string } } | undefined)?.site?.id === siteId });
    return result;
  } catch (error) {
    if (getMonitoringErrorCode(error) === "MONITORING_POLICY_CONFLICT") await client.invalidateQueries({ queryKey: monitoringPolicyQueryKey(siteId) });
    throw error;
  }
}
export function useMonitoringPolicyMutation(siteId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (input: PolicyUpdate) => saveMonitoringPolicy(client, siteId, input), retry: false });
}
export function getMonitoringErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return;
  const code = "code" in error.body ? error.body.code : undefined;
  return typeof code === "string" ? code : undefined;
}
export function incidentMutationErrorMessage(error: unknown) {
  switch (getMonitoringErrorCode(error)) {
    case "INCIDENT_CONFLICT": return "다른 사용자가 인시던트를 변경했습니다. 최신 이력을 확인한 뒤 다시 조치하세요.";
    case "INCIDENT_INVALID_STATE": return "인시던트 상태가 변경되어 이 조치를 수행할 수 없습니다. 최신 이력을 확인하세요.";
    case "INCIDENT_STILL_ACTIVE": return "장애가 지속되고 있어 해결할 수 없습니다. 장비 복구 후 다시 확인하세요.";
    case "INCIDENT_TARGET_CHANGED": return "대상 연결이 변경되었습니다. 최신 대상과 이력을 확인한 뒤 다시 조치하세요.";
    default: return "인시던트 조치를 저장하지 못했습니다. 연결과 권한을 확인하고 다시 시도하세요.";
  }
}
