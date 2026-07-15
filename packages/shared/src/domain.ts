export type FixtureStatus = "online" | "offline" | "fault";
export type CommandStatus = "pending" | "acknowledged" | "failed";

export type ProvisioningNodeStatus = "discovered" | "identifying" | "provisioning" | "provisioned" | "failed";
export type ProvisioningSessionStatus = "active" | "completed" | "failed" | "cancelled";

export interface ProvisioningScanStartPayload {
  sessionId: string;
  siteId: string;
  gatewayId: string;
  floorId: string;
  requestedBy: string;
  requestedAt: string;
}

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

export interface UnprovisionedDeviceFoundPayload {
  sessionId: string;
  deviceUuid: string;
  serialNumber: string;
  rssi: number;
  oobCapability: "none" | "static-oob" | "output-oob" | "input-oob";
  firmwareVersion: string;
  discoveredAt: string;
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
