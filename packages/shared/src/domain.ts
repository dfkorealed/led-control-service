export type FixtureStatus = "online" | "offline" | "fault";
export type CommandStatus = "pending" | "acknowledged" | "failed";

export interface FixtureState {
  fixtureId: string;
  brightness: number;
  powerOn: boolean;
  status: FixtureStatus;
  rssi: number | null;
  hopCount: number | null;
  commandSuccessRate: number | null;
  lastSeenAt: string;
}

export interface DimmingCommandPayload {
  commandId: string;
  siteId: string;
  targetType: "fixture" | "group";
  targetId: string;
  brightness: number;
  requestedBy: string;
  requestedAt: string;
}

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

export interface UnprovisionedDeviceFoundPayload {
  sessionId: string;
  deviceUuid: string;
  serialNumber: string;
  rssi: number;
  oobCapability: "none" | "static-oob" | "output-oob" | "input-oob";
  firmwareVersion: string;
  discoveredAt: string;
}
