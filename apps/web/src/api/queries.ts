import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

export interface Dashboard {
  site: { id: string; name: string };
  summary: {
    totalFixtures: number;
    onlineFixtures: number;
    faultFixtures: number;
    averageBrightness: number;
  };
  floors: Array<{
    id: string;
    name: string;
    level: number;
    floorPlan: { imageUrl: string; width: number; height: number; version: number } | null;
    fixtures: Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      ratedWatt: number;
      brightness: number;
    status: "online" | "offline" | "fault";
    statusReason?: "reported" | "fixture_stale" | "gateway_offline" | "command_failed" | null;
      rssi: number | null;
      hopCount: number | null;
      commandSuccessRate: number | null;
      lastSeenAt: string | null;
    }>;
  }>;
  groups: Array<{ id: string; name: string; fixtureIds: string[] }>;
  gateways: Array<{
    id: string;
    name: string;
    serialNumber: string;
    firmwareVersion: string;
    lastHeartbeatAt: string | null;
    connectionStatus: "online" | "offline";
  }>;
}

export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiGet<Dashboard>("/sites/default/dashboard"),
    refetchInterval: 3000
  });
}
