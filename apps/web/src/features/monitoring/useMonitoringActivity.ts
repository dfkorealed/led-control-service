import { useEffect, useRef } from "react";
import { isDetailRetained, useDetailRetentionClock } from "../../api/detail-retention";
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
  const query = useQuery({
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
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    retry: false
  });
  const now = useDetailRetentionClock(query.data?.items.map((item) => item.recordedAt) ?? []);
  const expired = query.data?.items.some((item) => !isDetailRetained(item.recordedAt, now));
  const expirationRead = useRef(false);
  useEffect(() => {
    if (!expired) { expirationRead.current = false; return; }
    if (!expirationRead.current) { expirationRead.current = true; void query.refetch(); }
  }, [expired, query.refetch]);
  const data = !query.error && !query.isFetching && !query.isPaused ? query.data : undefined;
  return { ...query, data: data ? { ...data, items: data.items.filter((item) => isDetailRetained(item.recordedAt, now)) } : undefined };
}
