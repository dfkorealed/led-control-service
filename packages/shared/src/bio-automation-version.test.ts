import { expect, it } from "vitest";
import * as contracts from "./index";
const c = contracts as unknown as Record<string, (value: unknown) => boolean>;
const id = "00000000-0000-4000-8000-000000000001";
const v2 = { schemaVersion: 2, requestId: id, siteId: id, gatewayId: id, requestedAt: "2026-10-14T00:00:00.000Z", assignmentVersion: 1, declarationRevision: 1, maxSnapshotVersion: 2 };
const v3 = { ...v2, schemaVersion: 3, maxSnapshotVersion: 3, temporaryControlVersion: 1, bioConfigurationReadback: true, durableFixtureLease: true };
it("known_v3_only_and_no_legacy_ttl_fallback", () => {
  expect(c.supportsTemporaryBioControl?.(v2) ?? false).toBe(false);
  expect(c.supportsTemporaryBioControl?.(v3) ?? false).toBe(true);
  expect(c.supportsBioAutomation?.(v2) ?? false).toBe(true);
  expect(c.supportsBioAutomation?.(v3) ?? false).toBe(true);
  for (const patch of [{ schemaVersion: 4 }, { temporaryControlVersion: 2 }, { bioConfigurationReadback: false }, { durableFixtureLease: false }, { durableFixtureLease: undefined }]) expect(c.supportsTemporaryBioControl?.({ ...v3, ...patch }) ?? false).toBe(false);
  expect(c.supportsBioAutomation?.({ ...v2, maxSnapshotVersion: 1 }) ?? false).toBe(false);
});
it("matches V3 receipts to exact acknowledged revision hash and envelope identity", () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const delivery = { schemaVersion: 3, acknowledgementId: id, siteId: id, gatewayId: id,
    acknowledgement: { schemaVersion: 3, gatewayId: id, revision: 3, payloadHash: hash, status: "applied", errorCode: null, appliedAt: v2.requestedAt } };
  const receipt = { ...delivery, ingestedAt: v2.requestedAt };
  const matcher = (contracts as unknown as Record<string, (...args: unknown[]) => boolean>).matchesAutomationConfigAppliedReceiptV3;
  expect(matcher?.(delivery, receipt) ?? false).toBe(true);
  const other = "00000000-0000-4000-8000-000000000002";
  for (const patch of [{ acknowledgementId: other }, { siteId: other }, { schemaVersion: 2 },
    { acknowledgement: { ...delivery.acknowledgement, revision: 2 } },
    { acknowledgement: { ...delivery.acknowledgement, payloadHash: `sha256:${"b".repeat(64)}` } }]) {
    expect(matcher?.(delivery, { ...receipt, ...patch }) ?? false).toBe(false);
  }
});
