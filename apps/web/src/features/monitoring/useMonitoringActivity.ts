import { useEffect, useRef } from "react";
import { isRetainedByClock, useDetailRetentionClock, withRetentionClock } from "../../api/detail-retention";
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
      return withRetentionClock(async () => monitoringActivityResponseSchema.parse(await apiGet<unknown>(`/sites/${encodeURIComponent(siteId)}/floors/${encodeURIComponent(floorId)}/monitoring-activity?${search}`, { signal })));
    },
    staleTime: 0,
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    retry: false
  });
  useDetailRetentionClock(query.data?.items.map((item) => item.recordedAt) ?? [], query.data?.retentionClock,
    principal && siteId && floorId ? query.refetch : undefined);
  const expired = query.data?.items.some((item) => !isRetainedByClock(item.recordedAt, query.data?.retentionClock));
  const expirationRead = useRef(false);
  useEffect(() => {
    if (!expired) { expirationRead.current = false; return; }
    if (!expirationRead.current) { expirationRead.current = true; void query.refetch(); }
  }, [expired, query.refetch]);
  const data = !query.error && !query.isFetching && !query.isPaused ? query.data : undefined;
  return { ...query, data: data ? { ...data, items: data.items.filter((item) => isRetainedByClock(item.recordedAt, data.retentionClock)) } : undefined };
}
