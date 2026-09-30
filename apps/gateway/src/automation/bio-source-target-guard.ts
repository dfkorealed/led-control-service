import type { AutomationSnapshot } from "@led-control/shared";

export type BioSourceTargetGuard = (expandedFixtureIds: readonly string[]) => boolean;

export function isActiveBioSourceTarget(snapshot: AutomationSnapshot | null, expandedFixtureIds: readonly string[]): boolean {
  if (snapshot?.schemaVersion !== 2) return false;
  const sources = new Set(snapshot.vehicleEventRules.filter(rule =>
    rule.status === "enabled" && rule.sensorProtocol === "bio-usb-pulse")
    .flatMap(rule => rule.sourceFixtureIds.map(id => id.toLowerCase())));
  return expandedFixtureIds.some(id => sources.has(id.toLowerCase()));
}
