import type { PersistedManualAutomationSuppressionState } from "./automation-state-store";

export interface VehicleLightingCandidate {
  sourceId: string;
  startedAt: string;
  brightness: number;
}

export interface ScheduleLightingCandidate {
  sourceId: string;
  occurrenceKey: string;
  brightness: number;
}

export type ResolvedLightingSource = "manual_override" | "vehicle_event_rule" | "schedule" | "current" | "default";

export interface ResolvedLightingState {
  sourceType: ResolvedLightingSource;
  sourceId: string | null;
  occurrenceKey: string | null;
  brightness: number;
}

export interface LightingCandidates {
  events: VehicleLightingCandidate[];
  schedules: ScheduleLightingCandidate[];
  suppression?: Pick<PersistedManualAutomationSuppressionState, "schedules" | "vehicleEvents">;
  current: number | null;
  defaultBrightness?: number;
}

export function resolveDesiredState(candidates: LightingCandidates): ResolvedLightingState {
  const event = candidates.events.filter((candidate) => !candidates.suppression?.vehicleEvents.some((item) =>
    item.ruleId === candidate.sourceId && item.startedAt === candidate.startedAt
  )).sort((left, right) =>
    right.brightness - left.brightness || left.sourceId.localeCompare(right.sourceId)
  )[0];
  if (event) return resolved("vehicle_event_rule", event.sourceId, null, event.brightness);

  const schedule = candidates.schedules.find((candidate) => !candidates.suppression?.schedules.some((item) =>
    item.scheduleId === candidate.sourceId && item.occurrenceKey === candidate.occurrenceKey
  ));
  if (schedule) {
    return resolved(
      "schedule",
      schedule.sourceId,
      schedule.occurrenceKey,
      schedule.brightness
    );
  }

  if (candidates.current !== null) return resolved("current", null, null, candidates.current);
  return resolved("default", null, null, candidates.defaultBrightness ?? 0);
}

function resolved(
  sourceType: ResolvedLightingSource,
  sourceId: string | null,
  occurrenceKey: string | null,
  brightness: number
): ResolvedLightingState {
  validateBrightness(brightness);
  return { sourceType, sourceId, occurrenceKey, brightness };
}

function validateBrightness(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("brightness must be an integer from 0 to 100");
}
