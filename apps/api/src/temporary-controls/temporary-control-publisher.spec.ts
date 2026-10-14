import { canonicalPayloadHash } from "../automation/automation-payload-hash";

const command = { schemaVersion: 1, kind: "start", sessionId: "00000000-0000-4000-8000-000000000001", sessionRevision: 1,
  siteId: "00000000-0000-4000-8000-000000000002", gatewayId: "00000000-0000-4000-8000-000000000003", assignmentVersion: 1,
  admissionRevision: 3, sequence: 1, payloadHash: `sha256:${"a".repeat(64)}`, brightness: 70,
  startedAt: "2026-10-14T00:00:00.000Z", endsAt: "2026-10-14T00:01:00.000Z", targets: [] };

describe("temporary delivery envelope", () => {
  it("bounds start by its fixed end and hashes transport separately from original admission", () => {
    const { temporaryDeliveryEnvelope } = require("./temporary-control-publisher");
    const value = temporaryDeliveryEnvelope(command, new Date("2026-10-14T00:00:55Z"), "attempt-a");
    expect(value).toMatchObject({ deliveryWindowMs: 5000, expiresAt: "2026-10-14T00:01:00.000Z", deliveryGeneration: "attempt-a", payloadHash: command.payloadHash });
    const { deliveryPayloadHash, ...body } = value;
    expect(deliveryPayloadHash).toBe(canonicalPayloadHash(body));
    expect(deliveryPayloadHash).not.toBe(command.payloadHash);
    expect(temporaryDeliveryEnvelope(command, new Date("2026-10-14T00:00:58Z"), "attempt-b")).toBeNull();
  });
  it("gives accepted safety release its own fresh window without extending the hold", () => {
    const { temporaryDeliveryEnvelope } = require("./temporary-control-publisher");
    const value = temporaryDeliveryEnvelope({ ...command, kind: "end", sessionRevision: 2 }, new Date("2026-10-14T01:00:00Z"), "recovery");
    expect(value).toMatchObject({ endsAt: command.endsAt, deliveryWindowMs: 10000, expiresAt: "2026-10-14T01:00:10.000Z" });
  });
});
