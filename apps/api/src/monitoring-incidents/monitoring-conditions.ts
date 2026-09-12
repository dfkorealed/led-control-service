import type { MonitoringIncidentType } from "@prisma/client";
import { toFixtureHealthSnapshot, fixtureStatusWithHealth } from "../fixtures/fixture-health";

export interface MonitoringPolicy {
  gatewayOfflineAfterSeconds: number;
  fixtureStaleAfterSeconds: number;
}
export const DEFAULT_MONITORING_POLICY: MonitoringPolicy = {
  gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180
};

export function isMonitoringGatewayOnline(
  lastHeartbeatAt: Date | null | undefined, policy: MonitoringPolicy, now: Date
) {
  return lastHeartbeatAt != null &&
    lastHeartbeatAt.getTime() >= now.getTime() - policy.gatewayOfflineAfterSeconds * 1000;
}
export interface MonitoringConditionTarget {
  gateway?: { lastHeartbeatAt: Date | null } | null;
  fixture?: {
    lastSeenAt: Date | null;
    statusReason: string | null;
    healthFaultCodes: unknown;
    healthLastSeenAt: Date | null;
  } | null;
}

// Shared by operator resolution and the freshness reconciler. Transport health
// uses server receive time; mesh event timestamps must never extend freshness.
export function isMonitoringConditionActive(
  type: MonitoringIncidentType, target: MonitoringConditionTarget, policy: MonitoringPolicy, now: Date
) {
  const gatewayOffline = target.gateway != null && !isMonitoringGatewayOnline(target.gateway.lastHeartbeatAt, policy, now);
  if (type === "gateway_offline") return gatewayOffline;
  const fixture = target.fixture;
  if (!fixture) return false;
  if (type === "fixture_stale") {
    // Provisioning has never observed state. A gateway outage is tracked once at
    // the gateway, instead of duplicating a fixture-stale incident for each node.
    return fixture.statusReason !== "provisioning_waiting_state" && target.gateway != null && !gatewayOffline && (
      fixture.lastSeenAt === null || fixture.lastSeenAt.getTime() < now.getTime() - policy.fixtureStaleAfterSeconds * 1000
    );
  }
  if (type === "fixture_fault") {
    return fixtureStatusWithHealth("online", toFixtureHealthSnapshot(fixture.healthFaultCodes, fixture.healthLastSeenAt)) === "fault";
  }
  return fixture.statusReason === "command_failed";
}
