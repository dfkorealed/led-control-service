import { describe, expect, it } from "vitest";
import {
  bioRegistrationRevalidationRequestSchema as requestSchema,
  bioRegistrationRevalidationCommandSchema as commandSchema,
  bioRegistrationRevalidationResultSchema as resultSchema,
  bioRegistrationRevalidationAckSchema as ackSchema,
  bioRegistrationRevalidationTopics as topics,
  bioRegistrationRevalidationCanonicalJson as canonicalJson,
  matchesBioRegistrationRevalidationAck as matches
} from "./index";

const identity = {
  version: 2 as const, purpose: "bio_registration_revalidation" as const, operation: "query" as const,
  commandId: "10000000-0000-4000-8000-000000000001", siteId: "10000000-0000-4000-8000-000000000002",
  gatewayId: "10000000-0000-4000-8000-000000000003", fixtureId: "10000000-0000-4000-8000-000000000004",
  nodeId: "10000000-0000-4000-8000-000000000005", assignmentVersion: 1,
  deviceIdentityHash: "a".repeat(64), meshAddress: "0x0001"
};
const validCommand = { ...identity, requestedAt: "2026-10-06T00:00:00.000Z", expiresAt: "2026-10-06T00:00:30.000Z" };
const result = { ...identity, eventId: "10000000-0000-4000-8000-000000000006", sequence: 1,
  occurredAt: "2026-10-06T00:00:01.000Z", status: "observed" as const,
  evidence: "mode_get" as const, observedMode: "sensor" as const };
const hash = `sha256:${"b".repeat(64)}`;
const otherHash = `sha256:${"c".repeat(64)}`;
const ack = { ...identity, eventId: result.eventId, sequence: 1, payloadHash: hash,
  ingestedAt: "2026-10-06T00:00:02.000Z", status: "ingested" as const };
function withTtl(command: typeof validCommand, ms: number) {
  return { ...command, expiresAt: new Date(Date.parse(command.requestedAt) + ms).toISOString() };
}

describe("BIO registration revalidation wire contract", () => {
  it("accepts only the administrator request inputs", () => {
    const request = { siteId: identity.siteId, gatewayId: identity.gatewayId, fixtureId: identity.fixtureId,
      expectedAssignmentVersion: 1, clientRequestId: identity.commandId };
    expect(requestSchema.parse(request)).toEqual(request);
    expect(requestSchema.safeParse({ ...request, actorId: identity.nodeId }).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, expectedAssignmentVersion: 0 }).success).toBe(false);
  });
  it.each(["sensor", "force-on", "force-off"])("accepts observed %s without a capability claim", (observedMode) => {
    expect(resultSchema.parse({ ...result, observedMode })).toEqual({ ...result, observedMode });
  });
  it("enforces a positive TTL of at most 30 seconds", () => {
    expect(commandSchema.safeParse(withTtl(validCommand, 30_000)).success).toBe(true);
    for (const ms of [0, -1, 30_001]) expect(commandSchema.safeParse(withTtl(validCommand, ms)).success).toBe(false);
  });
  it.each([
    { operation: "ensure_sensor" }, { purpose: "bio_sensor_mode" }, { brightness: 50 },
    { modeVerified: true }, { nativeUuid: identity.nodeId }, { unknown: true },
    { meshAddress: "0x0000" }, { meshAddress: "0x8000" }, { deviceIdentityHash: hash }
  ])("rejects foreign command/result fields or identity %j", (override) => {
    expect(commandSchema.safeParse({ ...validCommand, ...override }).success).toBe(false);
    expect(resultSchema.safeParse({ ...result, ...override }).success).toBe(false);
  });
  it("keeps result timestamps and safe sequence distinct from command timestamps", () => {
    expect(resultSchema.safeParse({ ...result, sequence: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    for (const sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(resultSchema.safeParse({ ...result, sequence }).success).toBe(false);
    }
    expect(resultSchema.safeParse({ ...result, requestedAt: validCommand.requestedAt }).success).toBe(false);
    expect(resultSchema.safeParse({ ...result, expiresAt: validCommand.expiresAt }).success).toBe(false);
  });
  it("accepts only the fixed failure errors without observed evidence", () => {
    const { observedMode, evidence, ...envelope } = result;
    for (const status of ["unknown", "timed_out"]) {
      for (const errorCode of ["MODE_GET_UNCONFIRMED", "COMMAND_EXPIRED", "GATEWAY_RESTART", "UNSUPPORTED_ADAPTER", "GATEWAY_SHUTDOWN", "GATEWAY_CLOCK_UNTRUSTED"]) {
        expect(resultSchema.safeParse({ ...envelope, status, errorCode }).success).toBe(true);
      }
    }
    expect(resultSchema.safeParse({ ...envelope, status: "unknown", errorCode: "OTHER" }).success).toBe(false);
    expect(resultSchema.safeParse({ ...result, status: "unknown", errorCode: "MODE_GET_UNCONFIRMED" }).success).toBe(false);
  });
  it("validates strict acceptance ACKs and their prefixed hash", () => {
    for (const status of ["ingested", "duplicate", "stale_checkpoint"]) {
      expect(ackSchema.safeParse({ ...ack, status }).success).toBe(true);
    }
    for (const override of [{ status: "applied" }, { payloadHash: identity.deviceIdentityHash },
      { payloadHash: `sha256:${"A".repeat(64)}` }, { modeVerified: true }, { sequence: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(ackSchema.safeParse({ ...ack, ...override }).success).toBe(false);
    }
    expect(matches(result, ack, hash)).toBe(true);
    expect(matches(result, { ...ack, payloadHash: otherHash }, hash)).toBe(false);
  });
  it.each([
    ["version", 1], ["purpose", "bio_sensor_mode"], ["operation", "ensure_sensor"],
    ["siteId", identity.nodeId], ["gatewayId", identity.nodeId], ["fixtureId", identity.nodeId],
    ["nodeId", identity.fixtureId], ["commandId", identity.nodeId], ["eventId", identity.nodeId],
    ["assignmentVersion", 2], ["deviceIdentityHash", "d".repeat(64)], ["meshAddress", "0x0002"], ["sequence", 2]
  ])("rejects ACK identity mismatch in %s", (field, value) => {
    expect(matches(result, { ...ack, [field as string]: value }, hash)).toBe(false);
  });
  it("uses isolated scoped command/result/ACK topics", () => {
    expect(topics.command("site", "gateway")).toBe("sites/site/gateways/gateway/commands/bio-registration-revalidation");
    expect(topics.result("site", "gateway")).toBe("sites/site/gateways/gateway/events/bio-registration-revalidation-result");
    expect(topics.ack("site", "gateway")).toBe("sites/site/gateways/gateway/acks/bio-registration-revalidation-result");
  });
  it("canonicalizes recursive keys while preserving arrays and payload values", () => {
    const a = { z: [{ b: 2, a: 1 }, 3], a: { z: null, a: "value" } };
    const b = { a: { a: "value", z: null }, z: [{ a: 1, b: 2 }, 3] };
    expect(canonicalJson(a)).toBe('{"a":{"a":"value","z":null},"z":[{"a":1,"b":2},3]}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson({ items: [1, 2] })).not.toBe(canonicalJson({ items: [2, 1] }));
    expect(canonicalJson({ "2": "two", "10": "ten" })).toBe('{"10":"ten","2":"two"}');
  });
});
