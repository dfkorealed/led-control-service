import type { MonitoringIncident, MonitoringPolicy } from "../../api/monitoring-incidents";

export const testPolicy: MonitoringPolicy = { id: "site-1", gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180, updatedAt: "2026-09-12T01:00:00.000Z" };
export function incidentFixture(overrides: Partial<MonitoringIncident> = {}): MonitoringIncident {
  return {
    id: "incident-1", siteId: "site-1", type: "fixture_fault", status: "open",
    target: { kind: "fixture", id: "fixture-1", name: "입구 조명", floorId: "floor-1" },
    openedAt: "2026-09-12T00:00:00.000Z", lastObservedAt: "2026-09-12T00:30:00.000Z",
    acknowledgedAt: null, resolvedAt: null, createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T01:00:00.000Z",
    acknowledgedBy: null, assignedTo: null, resolvedBy: null, resolutionKind: null, resolutionNote: null,
    ...overrides
  };
}
