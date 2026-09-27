import {
  energyReportListQuerySchema,
  type EnergyReportListQuery
} from "@led-control/shared/energy-p2-contracts";

export type ReportHistoryFilterState = EnergyReportListQuery;

const optionalKeys = [
  "cursor",
  "query",
  "status",
  "scope",
  "requestedFrom",
  "requestedTo"
] as const;

export function parseReportHistorySearchParams(params: URLSearchParams): ReportHistoryFilterState {
  const candidate: Record<string, string | number> = {
    limit: params.get("limit") ?? 20
  };
  for (const key of optionalKeys) {
    const value = params.get(key);
    if (value !== null) candidate[key] = value;
  }
  return energyReportListQuerySchema.parse(candidate);
}

export function serializeReportHistorySearchParams(state: ReportHistoryFilterState): URLSearchParams {
  const normalized = energyReportListQuerySchema.parse(state);
  const params = new URLSearchParams({ limit: String(normalized.limit) });
  for (const key of optionalKeys) {
    const value = normalized[key];
    if (value !== undefined) params.set(key, value);
  }
  return params;
}
