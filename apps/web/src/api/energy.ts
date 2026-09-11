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
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

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
