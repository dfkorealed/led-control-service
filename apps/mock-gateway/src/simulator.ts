import { DimmingCommandPayload, FixtureState } from "@led-control/shared";

export function applyDimmingCommand(states: FixtureState[], command: DimmingCommandPayload): FixtureState[] {
  const now = new Date().toISOString();

  return states.map((state) => {
    const matchesTarget = command.targetType === "fixture" && state.fixtureId === command.targetId;
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
