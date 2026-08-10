import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

export interface EnergyEstimate {
  day: { kwh: number; cost: number };
  month: { kwh: number; cost: number };
  year: { kwh: number; cost: number };
}

export function useEnergyEstimate(siteId?: string) {
  const path = siteId ? `/energy/sites/${encodeURIComponent(siteId)}/estimate` : "/energy/default/estimate";
  return useQuery({
    queryKey: ["energy-estimate", siteId ?? "default"],
    queryFn: () => apiGet<EnergyEstimate>(path)
  });
}
