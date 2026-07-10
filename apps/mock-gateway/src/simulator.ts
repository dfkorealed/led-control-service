import { DimmingCommandPayload, FixtureState, UnprovisionedDeviceFoundPayload } from "@led-control/shared";

export function applyDimmingCommand(
  states: FixtureState[],
  command: DimmingCommandPayload,
  groupFixtureIdsByGroupId: Record<string, string[]> = {}
): FixtureState[] {
  const now = new Date().toISOString();
  const groupFixtureIds = command.targetFixtureIds ?? groupFixtureIdsByGroupId[command.targetId] ?? [];

  return states.map((state) => {
    const matchesTarget =
      (command.targetType === "fixture" && state.fixtureId === command.targetId) ||
      (command.targetType === "group" && groupFixtureIds.includes(state.fixtureId));
    if (!matchesTarget) return state;

    return {
      ...state,
      brightness: command.brightness,
      powerOn: command.brightness > 0,
      lastSeenAt: now
    };
  });
}

export function createInitialStates(fixtureIds: string[]): FixtureState[] {
  const now = new Date().toISOString();
  return fixtureIds.map((fixtureId, index) => ({
    fixtureId,
    brightness: 60,
    powerOn: true,
    status: "online",
    rssi: -58 - index,
    hopCount: 1 + (index % 3),
    commandSuccessRate: 0.98,
    lastSeenAt: now
  }));
}

export function parseGroupFixtureMap(raw: string): Record<string, string[]> {
  if (!raw.trim()) return {};

  return raw.split(",").reduce<Record<string, string[]>>((map, groupEntry) => {
    const [groupId, fixtureList = ""] = groupEntry.split("=");
    const fixtureIds = fixtureList
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);

    if (groupId?.trim() && fixtureIds.length > 0) {
      map[groupId.trim()] = fixtureIds;
    }
    return map;
  }, {});
}

interface CreateMockDiscoveredNodesInput {
  sessionId: string;
  floorName: string;
  count?: number;
}

export function createMockDiscoveredNodes(input: CreateMockDiscoveredNodesInput): UnprovisionedDeviceFoundPayload[] {
  const floorCode = input.floorName.toLowerCase().replace(/[^a-z0-9]/g, "") || "floor";
  const serialFloorCode = input.floorName.toUpperCase().replace(/[^A-Z0-9]/g, "") || "FLOOR";
  const count = input.count ?? 4;
  const discoveredAt = new Date("2026-07-01T00:00:01.000Z").toISOString();

  return Array.from({ length: count }, (_, index) => {
    const sequence = String(index + 1).padStart(3, "0");
    return {
      sessionId: input.sessionId,
      deviceUuid: `esp32h2-${floorCode}-${sequence}`,
      serialNumber: `LC-${serialFloorCode}-${sequence}`,
      rssi: -54 - index * 3,
      oobCapability: "static-oob",
      firmwareVersion: "mock-node-0.1.0",
      discoveredAt
    };
  });
}
