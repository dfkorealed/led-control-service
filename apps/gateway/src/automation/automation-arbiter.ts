export interface ManualLightingCandidate {
  sourceId: string;
  brightness: number;
}

export interface VehicleLightingCandidate {
  sourceId: string;
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
  manual: ManualLightingCandidate | null;
  events: VehicleLightingCandidate[];
  schedule: ScheduleLightingCandidate | null;
  current: number | null;
  defaultBrightness?: number;
}

export function resolveDesiredState(candidates: LightingCandidates): ResolvedLightingState {
  if (candidates.manual) {
    return resolved("manual_override", candidates.manual.sourceId, null, candidates.manual.brightness);
  }

  const event = [...candidates.events].sort((left, right) =>
    right.brightness - left.brightness || left.sourceId.localeCompare(right.sourceId)
  )[0];
  if (event) return resolved("vehicle_event_rule", event.sourceId, null, event.brightness);

  if (candidates.schedule) {
    return resolved(
      "schedule",
      candidates.schedule.sourceId,
      candidates.schedule.occurrenceKey,
      candidates.schedule.brightness
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
