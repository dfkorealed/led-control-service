import { describe, expect, it } from "vitest";
import * as shared from "./index";
import type { z } from "zod";

const id = "20000000-0000-4000-8000-000000000001";
const otherId = "20000000-0000-4000-8000-000000000002";
const digest = `sha256:${"a".repeat(64)}`;
const identity = { schemaVersion: 1, commandId: id, siteId: id, gatewayId: id, fixtureId: id, nodeId: id,
  assignmentVersion: 1, deviceIdentityHash: "b".repeat(64), meshAddress: "0x0001", operation: "query", catalogRevision: 2 };
const command = { ...identity, requestedAt: "2026-10-08T00:00:00.000Z", expiresAt: "2026-10-08T00:02:00.000Z" };
const fingerprint = { deviceType: 1, firmware: { major: 1, minor: 2, revision: 3, build: 4 }, sensorType: 5,
  infraredType: 6, ambientLightType: 7, hardwareType: 8 };
const report = { ...identity, eventId: otherId, commandPayloadHash: digest, fingerprint, profileKey: `${id}@2`,
  connectionGeneration: 1, observedAt: "2026-10-08T00:00:01.000Z", status: "ready", modeVerified: true, linkVerified: true, errorCode: null };
const ack = { schemaVersion: 1, commandId: id, siteId: id, gatewayId: id, fixtureId: id, nodeId: id,
  assignmentVersion: 1, eventId: otherId, reportPayloadHash: digest, status: "applied", occurredAt: "2026-10-08T00:00:02.000Z" };
function schema(name: string): z.ZodTypeAny {
  const value = (shared as Record<string, unknown>)[name]; expect(value, name).toBeDefined(); return value as z.ZodTypeAny;
}
function helper(name: string): (...args: unknown[]) => unknown {
  const value = (shared as Record<string, unknown>)[name]; expect(value, name).toBeTypeOf("function"); return value as (...args: unknown[]) => unknown;
}

describe("BIO sensor preparation public contracts", () => {
  it("exports preparation schemas independently of sensor-mode V2", () => {
    const contracts = shared as Record<string, unknown>;
    for (const name of ["bioSensorPreparationRequestV1Schema", "bioSensorPreparationCommandV1Schema", "bioSensorPreparationReportV1Schema", "bioSensorPreparationAckV1Schema"]) {
      expect(contracts[name], name).toBeDefined();
    }
  });
  it("accepts only explicit read or ensure requests with a retry identity", () => {
    const contract = schema("bioSensorPreparationRequestV1Schema");
    for (const operation of ["query", "ensure_sensor"]) {
      expect(contract.safeParse({ siteId: id, fixtureId: id, clientRequestId: id, operation }).success).toBe(true);
    }
    expect(contract.safeParse({ siteId: id, fixtureId: id, operation: "query" }).success).toBe(false);
    expect(contract.safeParse({ siteId: id, fixtureId: id, clientRequestId: id, operation: "set_brightness" }).success).toBe(false);
    expect(contract.safeParse({ siteId: id, fixtureId: id, clientRequestId: id, operation: "query", ready: true }).success).toBe(false);
  });
  it("requires bounded lifetime, exact binding, and no embedded command hash", () => {
    const contract = schema("bioSensorPreparationCommandV1Schema");
    expect(contract.parse(command)).toEqual(command);
    for (const expiresAt of ["2026-10-08T00:00:00.000Z", "2026-10-07T23:59:59.000Z", "2026-10-08T00:02:00.001Z"]) {
      expect(contract.safeParse({ ...command, expiresAt }).success).toBe(false);
    }
    for (const change of [{ commandPayloadHash: digest }, { assignmentVersion: 0 }, { catalogRevision: 0 }, { deviceIdentityHash: "x".repeat(64) }, { meshAddress: "0x0000" }, { meshAddress: "0x8000" }]) {
      expect(contract.safeParse({ ...command, ...change }).success).toBe(false);
    }
  });
  it("requires fingerprint, profile and independent mode/link proof for ready", () => {
    const contract = schema("bioSensorPreparationReportV1Schema");
    expect(contract.parse(report)).toEqual(report);
    for (const change of [{ fingerprint: null }, { profileKey: null }, { profileKey: "legacy-profile" }, { modeVerified: false }, { linkVerified: false }, { connectionGeneration: 0 }, { commandPayloadHash: "invalid" }, { sensorType: 1 }]) {
      expect(contract.safeParse({ ...report, ...change }).success).toBe(false);
    }
    for (const field of ["modeVerified", "linkVerified", "fingerprint", "profileKey", "errorCode"]) {
      const missing: Record<string, unknown> = { ...report }; delete missing[field];
      expect(contract.safeParse(missing).success).toBe(false);
    }
    for (const status of ["needs_setup", "unverified", "degraded", "unsupported", "failed"]) {
      expect(contract.safeParse({ ...report, status, fingerprint: null, profileKey: null, modeVerified: false, linkVerified: false, errorCode: "UNVERIFIED" }).success).toBe(true);
    }
  });
  it("matches preparation receipts by report hash and exact operation identity", () => {
    const match = helper("matchesBioSensorPreparationAckV1");
    expect(schema("bioSensorPreparationAckV1Schema").parse(ack)).toEqual(ack);
    for (const status of ["applied", "duplicate", "stale", "rejected"]) expect(match(report, { ...ack, status }, digest)).toBe(true);
    for (const field of ["commandId", "siteId", "gatewayId", "fixtureId", "nodeId"]) expect(match(report, { ...ack, [field]: otherId }, digest)).toBe(false);
    for (const change of [{ eventId: id }, { assignmentVersion: 2 }, { reportPayloadHash: `sha256:${"c".repeat(64)}` }, { ready: true }]) expect(match(report, { ...ack, ...change }, digest)).toBe(false);
    expect(match(report, ack, "invalid")).toBe(false);
    expect(match({ ...report, unexpected: true }, ack, digest)).toBe(false);
  });
  it("binds every report to the exact complete command rather than partial scope", () => {
    const match = helper("matchesBioSensorPreparationReportV1");
    expect(match(command, report, digest)).toBe(true);
    for (const field of ["commandId", "siteId", "gatewayId", "fixtureId", "nodeId"]) {
      expect(match(command, { ...report, [field]: otherId }, digest)).toBe(false);
    }
    for (const change of [{ assignmentVersion: 2 }, { deviceIdentityHash: "a".repeat(64) }, { meshAddress: "0x0002" },
      { operation: "ensure_sensor" }, { catalogRevision: 3 }, { commandPayloadHash: `sha256:${"c".repeat(64)}` }]) {
      expect(match(command, { ...report, ...change }, digest)).toBe(false);
    }
    expect(match(command, report, "invalid")).toBe(false);
    expect(match({ ...command, expiresAt: command.requestedAt }, report, digest)).toBe(false);
  });
  it("uses the shared canonical JSON serializer and dedicated scoped topics", () => {
    expect(helper("bioSensorPreparationCanonicalJson")({ b: 2, a: [1, undefined] })).toBe('{"a":[1,null],"b":2}');
    const topics = (shared as Record<string, unknown>).bioSensorPreparationTopics as Record<string, (...args: string[]) => string>;
    expect(topics).toBeDefined();
    expect(topics.command(id, otherId)).toBe(`sites/${id}/gateways/${otherId}/commands/bio-sensor-preparation`);
    expect(topics.result(id, otherId)).toBe(`sites/${id}/gateways/${otherId}/events/bio-sensor-preparation-result`);
    expect(topics.ack(id, otherId)).toBe(`sites/${id}/gateways/${otherId}/events/bio-sensor-preparation-result-ack`);
  });
});
