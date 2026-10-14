import { getActiveOccurrence } from "@led-control/automation-engine";
import { isDeepStrictEqual } from "node:util";
import type { AutomationSnapshot, TemporaryControlCommand, TemporaryFixtureSnapshot } from "@led-control/shared";
import type { BioConfigurationState } from "../bio/bio-dongle-client";
import type { PersistedAutomationStateV10, PersistedBioNormalConfiguration } from "./automation-state-store";
import { resolveDesiredState } from "./automation-arbiter";
import { parseAutomationSnapshot } from "./automation-config-store";
import { isActiveBioSourceTarget } from "./bio-source-target-guard";

export type BioAutomaticTarget = { configuration: BioConfigurationState; restorationRevision: number;
  restorationPayloadHash: string; sourceIdentity: string | null };

/** Computes current authority only. Historical temporary preState and expired
 * pulse activations are deliberately not automatic candidates. */
export function resolveLatestBioAutomaticTarget(input: { fixtureId: string; snapshot: AutomationSnapshot;
  state: PersistedAutomationStateV10; now: Date; normalAuthority?: PersistedBioNormalConfiguration }): BioAutomaticTarget | { reason: string } {
  const { fixtureId, state, now } = input;
  const snapshot = parseAutomationSnapshot(input.snapshot, input.snapshot);
  if (snapshot.schemaVersion !== 3) return { reason: "temporary_current_v3_required" };
  if (isActiveBioSourceTarget(snapshot, [fixtureId])) return { reason: "bio_source_target_forbidden" };
  if (state.pendingManualControls[fixtureId]) return { reason: "temporary_automatic_authority_conflict" };
  const events = [];
  for (const [ruleId, vehicle] of Object.entries(state.vehicleRules)) {
    const rule = snapshot.vehicleEventRules.find(rule => rule.id === ruleId && rule.status === "enabled" && rule.targetFixtureIds.includes(fixtureId));
    if (!rule || !vehicle.targetFixtureIds.includes(fixtureId)) continue;
    const activation = state.bioActivationsByRule[ruleId];
    if (rule.sensorProtocol === "bio-usb-pulse") {
      if (!activation || activation.completed || activation.releaseReason !== null || activation.retiredFixtureIds.includes(fixtureId)) continue;
      if (activation.health !== "healthy" || activation.snapshotHash !== snapshot.payloadHash ||
        activation.binding.snapshotRevision !== snapshot.revision) return { reason: "bio_source_authority_unverified" };
    }
    if (vehicle.holdUntil !== null && Date.parse(vehicle.holdUntil) <= now.getTime()) continue;
    events.push({ sourceId: ruleId, startedAt: vehicle.startedAt,
      brightness: rule.action.dimmingEnabled ? rule.action.brightnessPercent : 100 });
  }
  const schedules = snapshot.schedules.flatMap(rule => {
    if (!rule.fixtureIds.includes(fixtureId)) return [];
    const occurrence = getActiveOccurrence(rule, now.getTime(), snapshot.timeZone, snapshot.holidayDatasets);
    return occurrence ? [{ sourceId: rule.id, occurrenceKey: occurrence.key,
      brightness: rule.action.dimmingEnabled ? rule.action.brightnessPercent : 100 }] : [];
  });
  const selected = resolveDesiredState({ events, schedules, current: null, suppression: state.manualAutomationSuppressions[fixtureId] });
  const lease = state.fixtureLeases[fixtureId];
  const owner = lease?.sessionId && (state.temporarySessions[lease.sessionId]?.command ?? state.temporaryEndTombstones[lease.sessionId]);
  // After exact server settlement the scheduler supplies its independently
  // scope/assignment-validated proof. It must still be the retained same proof;
  // an active temporary owner can never be bypassed with this ownerless seam.
  const supplied = input.normalAuthority;
  const normal = owner ? currentNormalConfiguration(state, owner, lease!.identity) :
    !lease?.sessionId && supplied && isDeepStrictEqual(supplied, state.bioNormalConfigurations[fixtureId]) && supplied.identity.fixtureId === fixtureId &&
      supplied.siteId === snapshot.siteId && supplied.gatewayId === snapshot.gatewayId &&
      supplied.baselineBrightness === (state.baseBrightnessByFixture[fixtureId] ?? null) ? supplied : undefined;
  if (!normal) return { reason: "normal_configuration_unavailable" };
  return { configuration: selected.sourceType === "default" ? normal.configuration : {
      configuredHighBrightnessPercent: selected.brightness || normal.configuration.configuredHighBrightnessPercent,
      bioMode: selected.brightness ? "force-on" : "force-off" },
    restorationRevision: snapshot.revision, restorationPayloadHash: snapshot.payloadHash,
    sourceIdentity: selected.sourceType === "default" ? null : selected.sourceType === "vehicle_event_rule" ? `${selected.sourceId}:${events.find(event => event.sourceId === selected.sourceId)!.startedAt}`
      : `${selected.sourceId}:${selected.occurrenceKey}` };
}

export function currentNormalConfiguration(state: PersistedAutomationStateV10, command: TemporaryControlCommand, target: TemporaryFixtureSnapshot) {
  const proof = state.bioNormalConfigurations[target.fixtureId];
  return proof && proof.siteId === command.siteId && proof.gatewayId === command.gatewayId && proof.assignmentVersion === command.assignmentVersion &&
    (["fixtureId", "meshNodeId", "nativeUuid", "logicalAddress"] as const).every(key => proof.identity[key] === target[key]) &&
    proof.baselineBrightness === (state.baseBrightnessByFixture[target.fixtureId] ?? null) ? proof : undefined;
}

export function canObserveNormalConfiguration(snapshot: AutomationSnapshot, state: PersistedAutomationStateV10, fixtureId: string, now: Date) {
  if (snapshot.schemaVersion !== 3 || isActiveBioSourceTarget(snapshot, [fixtureId]) || state.pendingManualControls[fixtureId] ||
    state.unverifiedDesiredByFixture[fixtureId] !== undefined) return false;
  const transition = state.transitionsByFixture[fixtureId];
  if (transition && (transition.phase === "pending" || transition.status !== "succeeded")) return false;
  if (Object.values(state.vehicleRules).some(row => row.targetFixtureIds.includes(fixtureId)) ||
    Object.values(state.bioActivationsByRule).some(row => !row.completed && row.targetFixtureIds.includes(fixtureId)) ||
    Object.values(state.activeOccurrences).some(row => Object.hasOwn(row.preBrightness, fixtureId))) return false;
  const target = state.bioTargetsByFixture[fixtureId];
  if (target && target.restoreResult?.status !== "succeeded") return false;
  return !snapshot.schedules.some(rule => rule.fixtureIds.includes(fixtureId) &&
    getActiveOccurrence(rule, now.getTime(), snapshot.timeZone, snapshot.holidayDatasets));
}
