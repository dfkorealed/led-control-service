import { useQuery } from "@tanstack/react-query";
import { monitoringActivityResponseSchema } from "@led-control/shared/monitoring-activity-contracts";
import { apiGet } from "../../api/client";

interface MonitoringActivityScope {
  principal: string | null | undefined;
  siteId: string | null | undefined;
  floorId: string | null | undefined;
  cursor?: string;
  limit?: number;
}

export function monitoringActivityQueryKey({ principal, siteId, floorId, cursor = "", limit = 5 }: MonitoringActivityScope) {
  return ["monitoring-activity", principal ?? "", siteId ?? "", floorId ?? "", limit, cursor] as const;
}

export function monitoringActivityScopeKey(principal: string, siteId: string, floorId: string) {
  return ["monitoring-activity", principal, siteId, floorId] as const;
}

export function useMonitoringActivity(scope: MonitoringActivityScope) {
  const { principal, siteId, floorId, cursor = "", limit = 5 } = scope;
  return useQuery({
    queryKey: monitoringActivityQueryKey(scope),
    enabled: Boolean(principal && siteId && floorId),
    queryFn: async ({ signal }) => {
      if (!principal || !siteId || !floorId) throw new Error("Monitoring activity scope is required");
      const search = new URLSearchParams({ limit: String(limit) });
      if (cursor) search.set("cursor", cursor);
      const response = await apiGet<unknown>(`/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/monitoring-activity?${search}`, { signal });
      return monitoringActivityResponseSchema.parse(response);
    },
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false
  });
}
