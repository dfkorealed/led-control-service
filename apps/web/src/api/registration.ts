import type { RegisterFixtureBatchInput } from "@led-control/shared";
import { apiGet, apiPost } from "./client";

export type { RegisterFixtureBatchInput } from "@led-control/shared";

export interface DiscoveredRegistrationNode {
  id: string;
  sessionId: string;
  deviceUuid: string;
  serialNumber: string;
  rssi: number;
  oobCapability: string;
  firmwareVersion: string;
  status: "discovered" | "identifying" | "provisioning" | "provisioned" | "failed" | "reconcile_required";
  identifyState: string;
  meshAddress: string | null;
  errorMessage: string | null;
  pendingFixtureSize?: number | null;
  scanCorrelationId: string | null;
  scanAttempt: number | null;
  discoveredAt: string;
}

export interface RegisterFixtureBatchResult {
  items: Array<{
    nodeId: string;
    status: "accepted" | "validation_failed";
    fixtureName?: string;
    error?: string;
  }>;
}

export interface RegistrationSession {
  id: string;
  siteId: string;
  floorId: string;
  gatewayId: string;
  requestedBy: string;
  status: "active" | "completed" | "failed" | "cancelled";
  scanStatus: "pending" | "scanning" | "completed" | "failed";
  scanCorrelationId: string | null;
  scanAttempt: number;
  scanStartedAt: string | null;
  scanCompletedAt: string | null;
  scanFailureCode: string | null;
  scanFailureMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  discoveredNodes: DiscoveredRegistrationNode[];
}

export type RegistrationScanRetryResult = Omit<RegistrationSession, "discoveredNodes"> & {
  discoveredNodes?: DiscoveredRegistrationNode[];
};

export function createRegistrationSession(siteId: string, floorId: string, gatewayId: string) {
  return apiPost<RegistrationSession>("/registration-sessions", { siteId, floorId, gatewayId });
}

export function getRegistrationSession(sessionId: string) {
  return apiGet<RegistrationSession>(`/registration-sessions/${sessionId}`);
}

export function registerRegistrationNode(sessionId: string, nodeId: string, fixtureName: string, x: number, y: number) {
  return apiPost<{ fixture: { id: string; name: string } | null; discoveredNode: DiscoveredRegistrationNode }>(
    `/registration-sessions/${sessionId}/nodes/${nodeId}/register`,
    { fixtureName, x, y }
  );
}

export function registerFixtureBatch(sessionId: string, input: RegisterFixtureBatchInput) {
  return apiPost<RegisterFixtureBatchResult>(`/registration-sessions/${sessionId}/nodes/register-batch`, input);
}

export function completeRegistrationSession(sessionId: string) {
  return apiPost<RegistrationSession>(`/registration-sessions/${sessionId}/complete`, {});
}

export function retryRegistrationScan(sessionId: string) {
  return apiPost<RegistrationScanRetryResult>(`/registration-sessions/${sessionId}/scan/retry`, {});
}
