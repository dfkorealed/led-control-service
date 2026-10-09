import { describe, expect, it } from "vitest";
import * as shared from "./index";
import type { z } from "zod";

const siteId = "10000000-0000-4000-8000-000000000001";
const gatewayId = "10000000-0000-4000-8000-000000000002";
const eventId = "10000000-0000-4000-8000-000000000003";
const profileId = "10000000-0000-4000-8000-000000000004";
const digest = `sha256:${"a".repeat(64)}`;
const fingerprint = { deviceType: 1, firmware: { major: 2, minor: 3, revision: 4, build: 513 },
  sensorType: 5, infraredType: 6, ambientLightType: 7, hardwareType: 8 };
const profile = { profileId, revision: 1, status: "approved", fingerprint,
  bodyHexes: ["0101000000000000"], linkPolicy: { kind: "mode-get", probeIntervalMs: 1000, maxAgeMs: 5000 },
  evidenceDigest: digest, reuseScope: "Verified hardware variant" };
const catalog = { schemaVersion: 1, siteId, gatewayId, eventId, assignmentVersion: 2, catalogRevision: 3,
  issuedAt: "2026-10-08T00:00:00.000Z", profiles: [profile],
  executionPolicy: { enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null } };
const ack = { schemaVersion: 1, siteId, gatewayId, eventId, assignmentVersion: 2, catalogRevision: 3,
  deliveryPayloadHash: digest, status: "applied", occurredAt: "2026-10-08T00:00:01.000Z" };
function schema(name: string): z.ZodTypeAny {
  const value = (shared as Record<string, unknown>)[name];
  expect(value, name).toBeDefined();
  return value as z.ZodTypeAny;
}
function helper(name: string): (...args: unknown[]) => unknown {
  const value = (shared as Record<string, unknown>)[name];
  expect(value, name).toBeTypeOf("function");
  return value as (...args: unknown[]) => unknown;
}

describe("BIO sensor catalog public contracts", () => {
  it("exports the separate fingerprint, profile and catalog schemas", () => {
    const contracts = shared as Record<string, unknown>;
    for (const name of ["bioSensorFingerprintV1Schema", "bioSensorProfileV1Schema", "bioSensorCatalogV1Schema", "bioSensorCatalogAckV1Schema"]) {
      expect(contracts[name], name).toBeDefined();
    }
  });
  it("validates every discovery byte and the 16-bit firmware build", () => {
    const contract = schema("bioSensorFingerprintV1Schema");
    expect(contract.parse(fingerprint)).toEqual(fingerprint);
    for (const field of ["deviceType", "sensorType", "infraredType", "ambientLightType", "hardwareType"]) {
      for (const value of [-1, 256, 1.5]) expect(contract.safeParse({ ...fingerprint, [field]: value }).success).toBe(false);
    }
    for (const field of ["major", "minor", "revision"]) {
      expect(contract.safeParse({ ...fingerprint, firmware: { ...fingerprint.firmware, [field]: 256 } }).success).toBe(false);
    }
    for (const build of [-1, 65536, 1.5]) expect(contract.safeParse({ ...fingerprint, firmware: { ...fingerprint.firmware, build } }).success).toBe(false);
    expect(contract.safeParse({ ...fingerprint, firmware: { major: 0, minor: 255, revision: 0, build: 65535 } }).success).toBe(true);
    expect(contract.safeParse({ ...fingerprint, modelName: "guessed" }).success).toBe(false);
    expect(contract.safeParse({ ...fingerprint, firmware: { ...fingerprint.firmware, extra: 1 } }).success).toBe(false);
  });
  it("requires exact unique eight-byte bodies and approval evidence", () => {
    const contract = schema("bioSensorProfileV1Schema");
    expect(contract.parse(profile)).toEqual(profile);
    for (const bodyHexes of [[], ["05"], ["010100000000000000"], ["AA01000000000000"], ["0101000000000000", "0101000000000000"]]) {
      expect(contract.safeParse({ ...profile, bodyHexes }).success).toBe(false);
    }
    for (const field of ["evidenceDigest", "reuseScope", "fingerprint", "linkPolicy"]) {
      const invalid: Record<string, unknown> = { ...profile }; delete invalid[field];
      expect(contract.safeParse(invalid).success).toBe(false);
    }
    for (const change of [{ revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { evidenceDigest: "a".repeat(64) }, { reuseScope: " " }, { nativeUuid: "bio:test" }]) {
      expect(contract.safeParse({ ...profile, ...change }).success).toBe(false);
    }
    expect(contract.safeParse({ ...profile, linkPolicy: { kind: "mode-get", probeIntervalMs: 5000, maxAgeMs: 1000 } }).success).toBe(false);
    expect(contract.safeParse({ ...profile, linkPolicy: { kind: "mode-get", probeIntervalMs: 0, maxAgeMs: 1000 } }).success).toBe(false);
    expect(contract.safeParse({ ...profile, status: "revoked" }).success).toBe(true);
  });
  it("keeps empty catalogs disabled and rejects ambiguous profile IDs", () => {
    const contract = schema("bioSensorCatalogV1Schema");
    expect(contract.parse(catalog)).toEqual(catalog);
    const { executionPolicy: _policy, ...empty } = { ...catalog, profiles: [] };
    expect(contract.parse(empty).executionPolicy).toEqual({ enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null });
    expect(contract.safeParse({ ...catalog, profiles: [profile, { ...profile, revision: 2 }] }).success).toBe(false);
    expect(contract.safeParse({ ...catalog, assignmentVersion: 0 }).success).toBe(false);
    expect(contract.safeParse({ ...catalog, catalogRevision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(contract.safeParse({ ...catalog, approved: true }).success).toBe(false);
    expect(contract.safeParse({ ...catalog, executionPolicy: { ...catalog.executionPolicy, enabled: true } }).success).toBe(false);
    const enabled = { enabled: true, ownerUserId: profileId, maximumResponseSeconds: 60, escalationAction: "Contact operator" };
    expect(contract.safeParse({ ...catalog, executionPolicy: enabled }).success).toBe(true);
    for (const change of [{ ownerUserId: null }, { maximumResponseSeconds: 0 }, { escalationAction: " " }]) {
      expect(contract.safeParse({ ...catalog, executionPolicy: { ...enabled, ...change } }).success).toBe(false);
    }
  });
  it("binds catalog receipts to full-envelope hash and exact current scope", () => {
    const match = helper("matchesBioSensorCatalogAckV1");
    expect(schema("bioSensorCatalogAckV1Schema").parse(ack)).toEqual(ack);
    for (const status of ["applied", "duplicate", "stale", "rejected"]) expect(match(catalog, { ...ack, status }, digest)).toBe(true);
    for (const change of [{ siteId: profileId }, { gatewayId: profileId }, { eventId: profileId }, { assignmentVersion: 3 }, { catalogRevision: 4 }, { deliveryPayloadHash: `sha256:${"b".repeat(64)}` }, { unexpected: true }]) {
      expect(match(catalog, { ...ack, ...change }, digest)).toBe(false);
    }
    expect(match(catalog, ack, "invalid")).toBe(false);
    expect(match({ ...catalog, unexpected: true }, ack, digest)).toBe(false);
  });
  it("canonicalizes discovery identity independently of object field order", () => {
    const expected = '{"deviceType":1,"firmware":{"major":2,"minor":3,"revision":4,"build":513},"sensorType":5,"infraredType":6,"ambientLightType":7,"hardwareType":8}';
    const reordered = { hardwareType: 8, ambientLightType: 7, infraredType: 6, sensorType: 5,
      firmware: { build: 513, revision: 4, minor: 3, major: 2 }, deviceType: 1 };
    for (const name of ["canonicalBioSensorFingerprint", "bioSensorFingerprint"]) {
      expect(helper(name)(fingerprint)).toBe(expected);
      expect(helper(name)(reordered)).toBe(expected);
      expect(() => helper(name)({ ...fingerprint, sensorType: 256 })).toThrow();
    }
    expect(helper("bioFirmwareFingerprint")(fingerprint)).toBe("2.3.4.513");
    expect(helper("bioProfileKey")(profile)).toBe("10000000-0000-4000-8000-000000000004@1");
    expect(helper("bioProfileKey")({ ...profile, revision: 2 })).toBe("10000000-0000-4000-8000-000000000004@2");
  });
  it("reuses canonical JSON wire semantics for complete catalog hashing", () => {
    expect(helper("bioSensorCatalogCanonicalJson")({ z: 2, a: { y: 1, b: 0 }, omitted: undefined })).toBe('{"a":{"b":0,"y":1},"z":2}');
    const topics = (shared as Record<string, unknown>).bioSensorCatalogTopics as Record<string, (...args: string[]) => string>;
    expect(topics).toBeDefined();
    expect(topics.command(siteId, gatewayId)).toBe(`sites/${siteId}/gateways/${gatewayId}/commands/bio-sensor-catalog`);
    expect(topics.ack(siteId, gatewayId)).toBe(`sites/${siteId}/gateways/${gatewayId}/events/bio-sensor-catalog-ack`);
  });
});
