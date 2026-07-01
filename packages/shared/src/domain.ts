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
