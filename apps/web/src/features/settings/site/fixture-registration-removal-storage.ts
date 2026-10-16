import { fixtureRegistrationRemovalRequestSchema } from "@led-control/shared/fixture-registration-removal-contracts";
import type { FixtureRemovalScope } from "../../../api/fixture-registration-removals";

export interface StoredFixtureRemoval extends FixtureRemovalScope {
  principal: string;
  clientRequestId: string;
  expectedUpdatedAt: string;
  fixtureName: string;
  serialNumber: string | null;
  operationId?: string;
}

function prefix(principal: string, siteId: string) {
  return `led-control.fixture-removal.v1:${encodeURIComponent(principal)}:${encodeURIComponent(siteId)}:`;
}
export function removalStorageKey(record: StoredFixtureRemoval) {
  return `${prefix(record.principal, record.siteId)}${encodeURIComponent(record.floorId)}:${encodeURIComponent(record.fixtureId)}`;
}

export function saveFixtureRemoval(record: StoredFixtureRemoval) {
  const key = removalStorageKey(record);
  const serialized = JSON.stringify(record);
  sessionStorage.setItem(key, serialized);
  if (sessionStorage.getItem(key) !== serialized) throw new Error("Removal recovery storage unavailable");
}

export function loadFixtureRemovals(principal: string, siteId: string): StoredFixtureRemoval[] {
  const records: StoredFixtureRemoval[] = [];
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index);
    if (!key?.startsWith(prefix(principal, siteId))) continue;
    const record = JSON.parse(sessionStorage.getItem(key)!);
    const request = fixtureRegistrationRemovalRequestSchema.parse({ clientRequestId: record.clientRequestId, expectedUpdatedAt: record.expectedUpdatedAt });
    if (record.principal !== principal || record.siteId !== siteId || typeof record.floorId !== "string" || !record.floorId
      || typeof record.fixtureId !== "string" || !record.fixtureId || typeof record.fixtureName !== "string"
      || !(record.serialNumber === null || typeof record.serialNumber === "string")
      || !(record.operationId === undefined || fixtureRegistrationRemovalRequestSchema.shape.clientRequestId.safeParse(record.operationId).success)
      || removalStorageKey(record) !== key) throw new Error("Invalid removal recovery identity");
    records.push({ principal, siteId, floorId: record.floorId, fixtureId: record.fixtureId, fixtureName: record.fixtureName,
      serialNumber: record.serialNumber, ...request, ...(record.operationId ? { operationId: record.operationId } : {}) });
  }
  return records;
}

export function forgetFixtureRemoval(record: StoredFixtureRemoval) {
  sessionStorage.removeItem(removalStorageKey(record));
}
