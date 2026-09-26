import {
  energyComparisonResponseSchema,
  type EnergyComparisonPreset
} from "@led-control/shared/energy-contracts";
import { energyRangeComparisonQuerySchema, energyRangeComparisonResponseSchema } from "@led-control/shared/energy-range-contracts";
import { energyObservedMeanResponseSchema } from "@led-control/shared/energy-observed-mean-contracts";
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
  energyReportListQuerySchema,
  energyReportListResponseSchema,
  energyReportRequestSchema,
  energyReportTargetsResponseSchema,
  type EnergyHeatmapMetric,
  type EnergyReportJob,
  type EnergyReportListQuery,
  type EnergyReportRequest,
  type EnergyScope
} from "@led-control/shared/energy-p2-contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ApiError, apiGet, apiPost } from "./client";

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

export function useEnergyComparison(siteId: string | undefined, preset: EnergyComparisonPreset, enabled = true) {
  return useQuery({
    queryKey: ["energy-comparison", siteId, preset],
    queryFn: async () => energyComparisonResponseSchema.parse(await apiGet<unknown>(
      `/energy/sites/${encodeURIComponent(siteId!)}/comparisons?preset=${preset}`
    )),
    enabled: enabled && Boolean(siteId),
    retry: 1
  });
}

export function useEnergyRangeComparison(siteId: string | undefined, from: string, to: string, enabled = true) {
  const validRange = energyRangeComparisonQuerySchema.safeParse({ from, to }).success;
  return useQuery({
    queryKey: ["energy-comparison-range", siteId, from, to],
    queryFn: async () => {
      const response = energyRangeComparisonResponseSchema.parse(await apiGet<unknown>(
        `/energy/sites/${encodeURIComponent(siteId!)}/comparisons/range?${new URLSearchParams({ from, to })}`
      ));
      // A schema-valid response can still belong to another request. Never cache it under this site's range key.
      if (response.siteId !== siteId || response.selection.from !== from || response.selection.to !== to) {
        throw new Error("Custom energy comparison response does not match the requested site and range");
      }
      return response;
    },
    enabled: enabled && Boolean(siteId) && validRange,
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
  enabled?: boolean;
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
    enabled: query.enabled !== false && Boolean(query.siteId) &&
      energyRangeComparisonQuerySchema.safeParse({ from: query.from, to: query.to }).success,
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

export function useEnergyObservedMeanHeatmap(query: EnergyHeatmapQuery) {
  const validRange = energyRangeComparisonQuerySchema.safeParse({ from: query.from, to: query.to }).success;
  return useQuery({
    queryKey: ["energy-heatmap-observed-mean", query.siteId, query.scope, query.identityId, query.metric, query.from, query.to],
    queryFn: async () => energyObservedMeanResponseSchema.parse(await apiGet<unknown>(
      `/energy/sites/${encodeURIComponent(query.siteId!)}/heatmap/observed-mean?${new URLSearchParams({
        scope: query.scope, identityId: query.identityId!, metric: query.metric, from: query.from!, to: query.to!
      })}`
    )),
    enabled: query.enabled !== false && Boolean(query.siteId && query.identityId) && validRange,
    retry: 1
  });
}

export function useEnergyReports(siteId: string | undefined, query: EnergyReportListQuery = { limit: 20 }) {
  const normalized = energyReportListQuerySchema.parse(query);
  return useQuery({
    queryKey: ["energy-reports", siteId, normalized],
    queryFn: async () => energyReportListResponseSchema.parse(await apiGet<unknown>(
      `/energy/sites/${encodeURIComponent(siteId!)}/reports?${reportListSearchParams(normalized).toString()}`
    )),
    enabled: Boolean(siteId),
    placeholderData: keepPreviousData,
    retry: 1,
    refetchInterval: (query) => query.state.data?.reports.some(isActiveReport)
      ? REPORT_POLL_INTERVAL_MS
      : false
  });
}

function reportListSearchParams(query: EnergyReportListQuery) {
  const params = new URLSearchParams({ limit: String(query.limit) });
  for (const key of ["cursor", "query", "status", "format", "scope", "requestedFrom", "requestedTo"] as const) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
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
  if (!response.ok) {
    throw new ApiError(
      `GET energy CSV export failed with ${response.status}`,
      response.status,
      await readResponseErrorBody(response)
    );
  }

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

export type EnergyReportRequestAction = "create" | "regenerate" | "download" | "csv";

const reportActionLabels: Record<EnergyReportRequestAction, { label: string; object: string; subject: string }> = {
  create: { label: "보고서 요청", object: "보고서 요청을", subject: "보고서 요청이" },
  regenerate: { label: "보고서 다시 생성", object: "보고서 다시 생성을", subject: "보고서 다시 생성이" },
  download: { label: "보고서 다운로드", object: "보고서 다운로드를", subject: "보고서 다운로드가" },
  csv: { label: "CSV 내보내기", object: "CSV 내보내기를", subject: "CSV 내보내기가" }
};

/** Maps transport and HTTP failures without exposing raw API/storage details. */
export function energyReportRequestErrorMessage(error: unknown, action: EnergyReportRequestAction): string {
  const actionLabel = reportActionLabels[action];
  if (error instanceof TypeError) {
    return `네트워크 연결을 확인한 뒤 ${actionLabel.object} 다시 시도해 주세요.`;
  }
  if (!(error instanceof ApiError)) {
    return `${actionLabel.object} 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.`;
  }
  if (error.status === 400 || error.status === 422) {
    return `${actionLabel.label} 입력을 확인해 주세요. 기간·대상·지원 문자를 수정한 뒤 다시 시도해 주세요.`;
  }
  if (error.status === 404) {
    if (action === "download") return "보고서 파일이 없거나 만료되었습니다. 다시 생성해 주세요.";
    if (action === "regenerate") return "다시 생성할 보고서의 대상 또는 이력을 찾을 수 없습니다. 새 조건으로 요청해 주세요.";
    if (action === "csv") return "CSV 대상 또는 이력을 찾을 수 없습니다. 대상을 다시 선택해 주세요.";
    return "보고서 요청 대상 또는 이력을 찾을 수 없습니다. 대상을 다시 선택해 주세요.";
  }
  if (error.status === 409) {
    return `${actionLabel.subject} 현재 상태와 충돌했습니다. 삭제 또는 동일 요청 처리가 끝난 뒤 다시 시도해 주세요.`;
  }
  if (error.status >= 500) {
    return `서버에서 ${actionLabel.object} 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.`;
  }
  return `${actionLabel.object} 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.`;
}

async function readResponseErrorBody(response: Response): Promise<unknown> {
  try {
    return (response.headers.get("Content-Type") ?? "").includes("json")
      ? await response.json()
      : await response.text();
  } catch {
    return null;
  }
}

function isActiveReport(report: EnergyReportJob) {
  return report.status === "queued" || report.status === "processing";
}
