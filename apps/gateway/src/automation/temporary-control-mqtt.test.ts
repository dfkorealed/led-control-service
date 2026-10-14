import { expect, it } from "vitest";
import { mqttTopics, type StartTemporaryControlCommand } from "@led-control/shared";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import { parseTemporaryControlDelivery } from "./temporary-control-mqtt";

const scope = { siteId: "00000000-0000-4000-8000-000000000003", gatewayId: "00000000-0000-4000-8000-000000000004" };
const payload = { schemaVersion: 1 as const, kind: "start" as const, sessionId: "00000000-0000-4000-8000-000000000002",
  sessionRevision: 1 as const, ...scope, assignmentVersion: 1, admissionRevision: 7, sequence: 9, brightness: 80,
  startedAt: "2026-10-14T00:00:00.000Z", endsAt: "2026-10-14T00:01:00.000Z",
  targets: [{ fixtureId: "00000000-0000-4000-8000-000000000001", meshNodeId: "00000000-0000-4000-8000-000000000001",
    nativeUuid: "001122334455", logicalAddress: "0x0001", applyGeneration: "1", releaseGeneration: "2" }] };
const command: StartTemporaryControlCommand = { ...payload, payloadHash: bioEnvelopeHash(payload) };
const envelope = () => {
  const body = { ...command, deliveryGeneration: "00000000-0000-4000-8000-000000000005", deliveryGeneratedAt: payload.startedAt,
    deliveryWindowMs: 10_000, expiresAt: "2026-10-14T00:00:10.000Z" };
  return { ...body, deliveryPayloadHash: bioEnvelopeHash(body) };
};
async function parser() {
  return parseTemporaryControlDelivery;
}
it("independently validates immutable command and UUID delivery hash/window", async () => {
  const parse = await parser();
  expect(parse(envelope(), { ...command }, new Date("2026-10-14T00:00:01Z"))).toEqual(command);
  const altered = envelope(); altered.brightness = 10;
  const { deliveryPayloadHash: _hash, ...body } = altered;
  expect(() => parse({ ...body, deliveryPayloadHash: bioEnvelopeHash(body) }, command, new Date(payload.startedAt))).toThrow();
});
it.each(["scope", "assignment", "expired", "future", "window", "hash", "unknown"])("rejects %s delivery without intake", async reason => {
  const parse = await parser(); const body: any = envelope(); let now = new Date(payload.startedAt);
  if (reason === "scope") body.gatewayId = body.siteId;
  if (reason === "assignment") body.assignmentVersion = 2;
  if (reason === "expired") now = new Date(body.expiresAt);
  if (reason === "future") now = new Date("2026-10-13T23:59:59Z");
  if (reason === "window") body.deliveryWindowMs = 60_000;
  if (reason === "hash") body.deliveryPayloadHash = bioEnvelopeHash({});
  if (reason === "unknown") body.unrecognized = true;
  expect(() => parse(body, command, now)).toThrow();
  expect(mqttTopics.temporaryControlCommand(scope.siteId, scope.gatewayId)).toContain("/temporary-control/command");
});
