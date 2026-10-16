import type { AutomationSnapshot } from "@led-control/shared";
import type { PersistedAutomationStateV10 } from "../automation/automation-state-store";

export function automationRegistrationRemovalBlocker(fixtureId: string, snapshot: AutomationSnapshot | null,
  state: PersistedAutomationStateV10): string | null {
  // Disabled saved rules still own their references; removal never edits rules.
  if (snapshot?.schedules.some(row => row.fixtureIds.includes(fixtureId))) return "SCHEDULE_REFERENCED";
  if (snapshot?.vehicleEventRules.some(row => row.sourceFixtureIds.includes(fixtureId) || row.targetFixtureIds.includes(fixtureId))) return "EVENT_REFERENCED";
  if (state.fixtureLeases[fixtureId]?.sessionId) return "RESTORATION_REQUIRED";
  if (Object.values(state.temporarySessions).some(session => {
    const target = session.targets[fixtureId];
    return target && !["restored", "rejected", "cancelled"].includes(session.state) && !target.releaseAcknowledged;
  })) return "RESTORATION_REQUIRED";
  if (state.pendingManualControls[fixtureId]) return "CONTROL_IN_PROGRESS";
  const transition = state.transitionsByFixture[fixtureId];
  if (transition?.phase === "pending" || transition?.status === "timed_out") return "CONTROL_UNCERTAIN";
  if (state.unverifiedDesiredByFixture[fixtureId] !== undefined) return "CONTROL_UNCERTAIN";
  if (Object.values(state.activeOccurrences).some(row => fixtureId in row.preBrightness)
    || Object.values(state.vehicleRules).some(row => row.activeSourceFixtureIds.includes(fixtureId) || row.targetFixtureIds.includes(fixtureId))) return "RESTORATION_REQUIRED";
  if (Object.values(state.bioActivationsByRule).some(row => !row.completed
    && (row.binding.sourceFixtureId === fixtureId || row.targetFixtureIds.includes(fixtureId)))) return "RESTORATION_REQUIRED";
  const bio = state.bioTargetsByFixture[fixtureId];
  if (bio && bio.restoreResult?.status !== "succeeded") return "RESTORATION_REQUIRED";
  return null;
}

/** Only exact identity fields, never substring matches in serialized payloads. */
export function referencesRegistration(value: unknown, fixtureId: string, nodeId = fixtureId): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => referencesRegistration(item, fixtureId, nodeId));
  const row = value as Record<string, unknown>;
  if (row.fixtureId === fixtureId || row.nodeId === nodeId) return true;
  for (const key of ["fixtureIds", "targetFixtureIds", "sourceFixtureIds"]) {
    if (Array.isArray(row[key]) && row[key].includes(fixtureId)) return true;
  }
  return Object.values(row).some(item => referencesRegistration(item, fixtureId, nodeId));
}

export function resultIsUncertain(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(resultIsUncertain);
  const row = value as Record<string, unknown>;
  return row.status === "timed_out" || row.status === "unknown" || row.status === "outcome_unknown" || row.status === "unverified"
    || row.outcome === "outcome_unknown" || row.outcome === "unknown"
    || Object.values(row).some(resultIsUncertain);
}

export function snapshotFixtureIds(snapshot: AutomationSnapshot): string[] {
  return [...new Set([...snapshot.schedules.flatMap(row => row.fixtureIds),
    ...snapshot.vehicleEventRules.flatMap(row => [...row.sourceFixtureIds, ...row.targetFixtureIds])])];
}
