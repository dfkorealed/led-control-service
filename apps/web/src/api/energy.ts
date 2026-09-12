import {
  energyComparisonResponseSchema,
  type EnergyComparisonPreset
} from "@led-control/shared/energy-contracts";
import {
  type EnergySeriesResponse,
  type EnergySummary
} from "@led-control/shared";
import {
  energyRankingResponseSchema,
  type EnergyRankingDimension,
  type EnergyRankingMetric,
  type EnergyRankingSort
} from "@led-control/shared/energy-analytics-contracts";
import {
  energyHeatmapResponseSchema,
  energyReportDownloadResponseSchema,
  energyReportJobSchema,
  energyReportListResponseSchema,
  energyReportRequestSchema,
  energyReportTargetsResponseSchema,
  type EnergyHeatmapMetric,
  type EnergyReportJob,
  type EnergyReportRequest,
  type EnergyScope
} from "@led-control/shared/energy-p2-contracts";
import { useQuery } from "@tanstack/react-query";
import { apiGet, apiPost } from "./client";

const API_BASE_URL = "/api";
const REPORT_POLL_INTERVAL_MS = 3_000;

export function useEnergySummary(siteId?: string) {
  return useQuery({
    queryKey: ["energy-summary", siteId],
    queryFn: () => apiGet<EnergySummary>(`/energy/sites/${encodeURIComponent(siteId!)}/summary`),
    enabled: Boolean(siteId),
    retry: 1
  });
}

interface EnergySeriesQuery {
  siteId?: string;
  granularity: "day" | "month";
  from: string;
  to: string;
  enabled: boolean;
}

export function useEnergySeries({ siteId, granularity, from, to, enabled }: EnergySeriesQuery) {
  return useQuery({
    queryKey: ["energy-series", siteId, granularity, from, to],
    queryFn: () => {
      const params = new URLSearchParams({ granularity, from, to });
      return apiGet<EnergySeriesResponse>(`/energy/sites/${encodeURIComponent(siteId!)}/series?${params.toString()}`);
    },
    enabled: enabled && Boolean(siteId && from && to),
    retry: 1
  });
}

export function useEnergyComparison(siteId: string | undefined, preset: EnergyComparisonPreset) {
  return useQuery({
    queryKey: ["energy-comparison", siteId, preset],
    queryFn: async () => energyComparisonResponseSchema.parse(await apiGet<unknown>(
      `/energy/sites/${encodeURIComponent(siteId!)}/comparisons?preset=${preset}`
    )),
    enabled: Boolean(siteId),
    retry: 1
  });
}

export interface EnergyRankingsQuery {
  siteId?: string;
  dimension: EnergyRankingDimension;
  metric: EnergyRankingMetric;
  sort: EnergyRankingSort;
  from: string;
  to: string;
  limit?: number;
}

export function useEnergyRankings(query: EnergyRankingsQuery) {
  const limit = query.limit ?? 10;
  return useQuery({
    queryKey: ["energy-rankings", query.siteId, query.dimension, query.metric, query.sort, query.from, query.to, limit],
    queryFn: async () => {
      const params = new URLSearchParams({
        dimension: query.dimension,
        metric: query.metric,
        sort: query.sort,
        from: query.from,
        to: query.to,
        limit: String(limit)
      });
      return energyRankingResponseSchema.parse(await apiGet<unknown>(
        `/energy/sites/${encodeURIComponent(query.siteId!)}/rankings?${params.toString()}`
      ));
    },
    enabled: Boolean(query.siteId && query.from && query.to),
    retry: 1
  });
}

export interface EnergyHeatmapQuery {
  siteId?: string;
  scope: EnergyScope;
  identityId?: string;
  metric: EnergyHeatmapMetric;
  from?: string;
  to?: string;
  enabled?: boolean;
}

export function useEnergyHeatmap(query: EnergyHeatmapQuery) {
  return useQuery({
    queryKey: ["energy-heatmap", query.siteId, query.scope, query.identityId, query.metric, query.from, query.to],
    queryFn: async () => {
      const params = new URLSearchParams({
        scope: query.scope,
        identityId: query.identityId!,
        metric: query.metric,
        from: query.from!,
        to: query.to!
      });
      return energyHeatmapResponseSchema.parse(await apiGet<unknown>(
        `/energy/sites/${encodeURIComponent(query.siteId!)}/heatmap?${params.toString()}`
      ));
    },
    enabled: query.enabled !== false && Boolean(query.siteId && query.identityId && query.from && query.to),
    retry: 1
  });
}

export function useEnergyReports(siteId?: string) {
  return useQuery({
    queryKey: ["energy-reports", siteId],
    queryFn: async () => energyReportListResponseSchema.parse(await apiGet<unknown>(
      `/energy/sites/${encodeURIComponent(siteId!)}/reports`
    )),
    enabled: Boolean(siteId),
    retry: 1,
    refetchInterval: (query) => query.state.data?.reports.some(isActiveReport)
      ? REPORT_POLL_INTERVAL_MS
      : false
  });
}

export function useEnergyReportTargets(siteId?: string) {
  return useQuery({
    queryKey: ["energy-report-targets", siteId],
    queryFn: async () => energyReportTargetsResponseSchema.parse(await apiGet<unknown>(
      `/energy/sites/${encodeURIComponent(siteId!)}/report-targets`
    )),
    enabled: Boolean(siteId),
    retry: 1,
    staleTime: 0
  });
}

export async function createEnergyReport(siteId: string, request: EnergyReportRequest) {
  const validRequest = energyReportRequestSchema.parse(request);
  return energyReportJobSchema.parse(await apiPost<unknown>(
    `/energy/sites/${encodeURIComponent(siteId)}/reports`, validRequest
  ));
}

export async function downloadEnergyReport(siteId: string, reportId: string) {
  // The endpoint creates a short-lived URL on demand; callers must not cache it.
  return energyReportDownloadResponseSchema.parse(await apiGet<unknown>(
    `/energy/sites/${encodeURIComponent(siteId)}/reports/${encodeURIComponent(reportId)}/download`
  ));
}

export async function downloadEnergyCsv(siteId: string, request: Omit<EnergyReportRequest, "format">) {
  const validRequest = energyReportRequestSchema.parse({ ...request, format: "xlsx" });
  const parameters = new URLSearchParams({
    from: validRequest.from,
    to: validRequest.to,
    scope: validRequest.scope,
    identityId: validRequest.identityId
  });
  const response = await fetch(
    `${API_BASE_URL}/energy/sites/${encodeURIComponent(siteId)}/exports/csv?${parameters.toString()}`,
    { credentials: "include" }
  );
  if (!response.ok) throw new Error(`CSV export failed with ${response.status}`);

  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = "energy-export.csv";
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(blobUrl);
  }
}

function isActiveReport(report: EnergyReportJob) {
  return report.status === "queued" || report.status === "processing";
}
