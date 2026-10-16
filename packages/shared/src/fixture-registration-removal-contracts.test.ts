import { describe, expect, it } from "vitest";
import * as shared from "./index";

const api = shared as unknown as Record<string, any>;
const id = "00000000-0000-4000-8000-000000000001";
const hash = `sha256:${"a".repeat(64)}`;
const command = {
  version: 1, operationId: id, siteId: id, gatewayId: id, gatewaySerial: "GW-001",
  assignmentVersion: 1, fixtureId: id, nodeId: id, deviceUuid: "bio:aabbccddeeff",
  meshAddress: "0x0100", originalProvisionCommandId: id, bindingHash: hash,
  requestedAt: "2026-10-16T00:00:00.000Z", expiresAt: "2026-10-16T00:00:30.000Z"
};
const terminal = { ...command, commandHash: hash, eventId: id, occurredAt: command.requestedAt,
  status: "removed", errorCode: null };
const { requestedAt: _requested, expiresAt: _expires, ...identity } = command;
const ack = { ...identity, commandHash: hash, eventId: id, resultHash: hash,
  ingestedAt: command.requestedAt, status: "ingested" };

describe("fixture registration removal contracts", () => {
  it("exports strict HTTP request, preview and operation views", () => {
    expect(api.fixtureRegistrationRemovalRequestSchema).toBeDefined();
    expect(api.fixtureRegistrationRemovalRequestSchema.parse({ clientRequestId: id, expectedUpdatedAt: command.requestedAt }))
      .toEqual({ clientRequestId: id, expectedUpdatedAt: command.requestedAt });
    expect(api.fixtureRegistrationRemovalRequestSchema.safeParse({ clientRequestId: id, expectedUpdatedAt: command.requestedAt, force: true }).success).toBe(false);
    const preview = { fixtureId: id, fixtureName: "Light", serialNumber: null, allowed: false,
      blockedReasons: [{ code: "GATEWAY_UNSUPPORTED", message: "Update required" }] };
    expect(api.fixtureRegistrationRemovalPreviewSchema.parse(preview)).toEqual(preview);
    expect(api.fixtureRegistrationRemovalPreviewSchema.safeParse({ ...preview, allowed: true }).success).toBe(false);
    expect(api.fixtureRegistrationRemovalViewSchema.parse({ operationId: id, siteId: id, floorId: id,
      fixtureId: id, status: "pending", errorCode: null, createdAt: command.requestedAt, completedAt: null }).status).toBe("pending");
  });
  it("accepts an exact BIO binding without physical control fields", () => {
    expect(api.fixtureRegistrationRemovalCommandSchema).toBeDefined();
    expect(api.fixtureRegistrationRemovalCommandSchema.parse(command)).toEqual(command);
  });
  it.each([
    { version: 2 }, { assignmentVersion: 0 }, { assignmentVersion: 1.5 }, { assignmentVersion: Number.MAX_SAFE_INTEGER },
    { operationId: "bad" }, { deviceUuid: "bio:AABBCCDDEEFF" }, { deviceUuid: "native" },
    { meshAddress: "0x0000" }, { meshAddress: "0x8000" }, { bindingHash: "a".repeat(64) },
    { gatewaySerial: " " }, { brightness: 0 }, { expiresAt: command.requestedAt },
    { expiresAt: "2026-10-16T00:00:30.001Z" }
  ])("rejects invalid or unknown command fields %j", patch => {
    expect(api.fixtureRegistrationRemovalCommandSchema).toBeDefined();
    expect(api.fixtureRegistrationRemovalCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
  });
  it("requires an exact command hash and explicit terminal outcome", () => {
    expect(api.fixtureRegistrationRemovalTerminalSchema).toBeDefined();
    expect(api.fixtureRegistrationRemovalTerminalSchema.parse(terminal)).toEqual(terminal);
    for (const patch of [{ commandHash: undefined }, { errorCode: "FAILED" }, { status: "completed" },
      { status: "rejected" }, { occurredAt: "2026-10-15T00:00:00.000Z" }, { extra: true }]) {
      expect(api.fixtureRegistrationRemovalTerminalSchema.safeParse({ ...terminal, ...patch }).success).toBe(false);
    }
    for (const status of ["rejected", "reconcile_required"]) {
      expect(api.fixtureRegistrationRemovalTerminalSchema.parse({ ...terminal, status, errorCode: "BINDING_CHANGED" }).status).toBe(status);
    }
  });
  it("application ACK binds operation/event/command/result and all registration identity", () => {
    expect(api.fixtureRegistrationRemovalAckSchema).toBeDefined();
    expect(api.fixtureRegistrationRemovalAckSchema.parse(ack)).toEqual(ack);
    expect(api.matchesFixtureRegistrationRemovalAck(terminal, ack, hash)).toBe(true);
    for (const patch of [{ operationId: undefined }, { eventId: undefined }, { commandHash: undefined }, { resultHash: undefined }]) {
      expect(api.fixtureRegistrationRemovalAckSchema.safeParse({ ...ack, ...patch }).success).toBe(false);
    }
    for (const key of ["operationId", "eventId", "commandHash", "resultHash", "fixtureId", "nodeId", "bindingHash", "deviceUuid", "originalProvisionCommandId"]) {
      expect(api.matchesFixtureRegistrationRemovalAck(terminal, { ...ack, [key]: "different" }, hash)).toBe(false);
    }
  });
  it("uses canonical sorted JSON and scoped topics", () => {
    expect(api.fixtureRegistrationRemovalCanonicalJson).toBeDefined();
    expect(api.fixtureRegistrationRemovalCanonicalJson({ z: 1, a: { y: 2, b: [3, 1] } }))
      .toBe('{"a":{"b":[3,1],"y":2},"z":1}');
    expect(api.fixtureRegistrationRemovalTopics.command(id, id)).toBe(`sites/${id}/gateways/${id}/commands/registration-removal`);
    expect(api.fixtureRegistrationRemovalTopics.terminal(id, id)).toBe(`sites/${id}/gateways/${id}/events/registration-removal`);
    expect(api.fixtureRegistrationRemovalTopics.ack(id, id)).toBe(`sites/${id}/gateways/${id}/commands/registration-removal-ack`);
    expect(() => api.fixtureRegistrationRemovalTopics.command("+/invalid", id)).toThrow();
  });
  it("pins the old provisioning generation binding independently of each removal request", () => {
    expect(api.fixtureRegistrationRemovalBindingIdentity).toBeDefined();
    const { operationId: _op, requestedAt: _start, expiresAt: _end, bindingHash: _hash, ...binding } = command;
    expect(api.fixtureRegistrationRemovalBindingIdentity(command)).toEqual(binding);
    expect(api.fixtureRegistrationRemovalBindingIdentity({ ...command, operationId: "other", bindingHash: "other", expiresAt: "other" })).toEqual(binding);
  });
  it("heartbeat capability is absent by default and only version 1 is accepted", () => {
    const heartbeat = { siteId: id, gatewayId: id, eventId: id, sequence: 1,
      assignmentVersion: 1, occurredAt: command.requestedAt, gatewaySerial: "GW", firmwareVersion: "1" };
    expect(shared.gatewayHeartbeatV2Schema.parse(heartbeat)).not.toHaveProperty("fixtureRegistrationRemovalVersion");
    expect(shared.gatewayHeartbeatV2Schema.parse({ ...heartbeat, fixtureRegistrationRemovalVersion: 1 }))
      .toHaveProperty("fixtureRegistrationRemovalVersion", 1);
    expect(shared.gatewayHeartbeatV2Schema.safeParse({ ...heartbeat, fixtureRegistrationRemovalVersion: 2 }).success).toBe(false);
  });
});
