import {
  energyComparisonResponseSchema,
  type EnergyComparisonPreset
} from "@led-control/shared/energy-contracts";
import {
  type EnergySeriesResponse,
  type EnergySummary
} from "@led-control/shared";
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
