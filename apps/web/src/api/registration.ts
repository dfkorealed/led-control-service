import { apiGet, apiPost } from "./client";

export interface DiscoveredRegistrationNode {
  id: string;
  sessionId: string;
  deviceUuid: string;
  serialNumber: string;
  rssi: number;
  oobCapability: string;
  firmwareVersion: string;
  status: "discovered" | "identifying" | "provisioning" | "provisioned" | "failed";
  identifyState: string;
  meshAddress: string | null;
  errorMessage: string | null;
  discoveredAt: string;
}

export interface RegistrationSession {
  id: string;
  siteId: string;
  floorId: string;
  gatewayId: string;
  requestedBy: string;
  status: "active" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  discoveredNodes: DiscoveredRegistrationNode[];
}

export function createRegistrationSession(siteId: string, floorId: string) {
  return apiPost<RegistrationSession>("/registration-sessions", { siteId, floorId });
}

export function getRegistrationSession(sessionId: string) {
  return apiGet<RegistrationSession>(`/registration-sessions/${sessionId}`);
}

export function identifyRegistrationNode(sessionId: string, nodeId: string) {
  return apiPost<DiscoveredRegistrationNode>(`/registration-sessions/${sessionId}/nodes/${nodeId}/identify`, {});
}

export function registerRegistrationNode(sessionId: string, nodeId: string, fixtureName: string, x: number, y: number) {
  return apiPost<{ fixture: { id: string; name: string }; discoveredNode: DiscoveredRegistrationNode }>(
    `/registration-sessions/${sessionId}/nodes/${nodeId}/register`,
    { fixtureName, x, y }
  );
}

export function completeRegistrationSession(sessionId: string) {
  return apiPost<RegistrationSession>(`/registration-sessions/${sessionId}/complete`, {});
}
