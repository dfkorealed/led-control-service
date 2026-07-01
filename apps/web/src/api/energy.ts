import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

interface EnergyEstimate {
  day: { kwh: number; cost: number };
  month: { kwh: number; cost: number };
  year: { kwh: number; cost: number };
}

export function useEnergyEstimate() {
  return useQuery({
    queryKey: ["energy-estimate"],
    queryFn: () => apiGet<EnergyEstimate>("/energy/default/estimate")
  });
}
