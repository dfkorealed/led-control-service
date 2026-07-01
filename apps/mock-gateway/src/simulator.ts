import { DimmingCommandPayload, FixtureState } from "@led-control/shared";

export function applyDimmingCommand(
  states: FixtureState[],
  command: DimmingCommandPayload,
  groupFixtureIdsByGroupId: Record<string, string[]> = {}
): FixtureState[] {
  const now = new Date().toISOString();
  const groupFixtureIds = groupFixtureIdsByGroupId[command.targetId] ?? [];

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
