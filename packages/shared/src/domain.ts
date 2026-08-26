export type FixtureStatus = "online" | "offline" | "fault";
export type CommandStatus = "pending" | "acknowledged" | "failed";

export type ProvisioningNodeStatus =
  | "discovered"
  | "identifying"
  | "provisioning"
  | "provisioned"
  | "failed"
  | "reconcile_required";
export type ProvisioningSessionStatus = "active" | "completed" | "failed" | "cancelled";

export interface IdentifyDevicePayload {
  sessionId: string;
  siteId: string;
  gatewayId: string;
  nodeId: string;
  deviceUuid: string;
  requestedAt: string;
}

export interface ProvisionDevicePayload {
  sessionId: string;
  siteId: string;
  gatewayId: string;
  nodeId: string;
  deviceUuid: string;
  meshAddress: string;
  requestedAt: string;
}

export interface ProvisioningCompletedPayload {
  sessionId: string;
  nodeId: string;
  deviceUuid: string;
  meshAddress: string;
  firmwareVersion?: string;
  rssi?: number | null;
  hopCount?: number | null;
  completedAt: string;
}

export interface ProvisioningFailedPayload {
  sessionId: string;
  nodeId: string;
  deviceUuid: string;
  errorMessage: string;
  failedAt: string;
}
