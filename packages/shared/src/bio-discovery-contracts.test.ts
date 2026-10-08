import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as shared from "./index";

const id = "10000000-0000-4000-8000-000000000001";
const legacy = { sessionId: id, scanCorrelationId: id, scanAttempt: 1, siteId: id, gatewayId: id,
  eventId: id, sequence: 1, occurredAt: "2026-10-08T00:00:00.000Z", deviceUuid: "bio:001122334455",
  serialNumber: "BIO-1", rssi: -45, oobCapability: "none", firmwareVersion: "2.3.4.513" };
const fingerprint = { deviceType: 1, firmware: { major: 2, minor: 3, revision: 4, build: 513 },
  sensorType: 5, infraredType: 6, ambientLightType: 7, hardwareType: 8 };
function schema(): z.ZodTypeAny {
  const value = (shared as Record<string, unknown>).bioProvisioningScanFoundV2Schema;
  expect(value).toBeDefined();
  return value as z.ZodTypeAny;
}

describe("typed BIO discovery scan contract", () => {
  it("preserves the complete legacy attribution with an explicit version and fingerprint", () => {
    const event = { ...legacy, schemaVersion: 2, fingerprint };
    expect(schema().parse(event)).toEqual(event);
  });
  it("requires a nullable observation without synthesizing from firmware text", () => {
    expect(schema().parse({ ...legacy, schemaVersion: 2, fingerprint: null }).fingerprint).toBeNull();
    expect(schema().safeParse({ ...legacy, schemaVersion: 2 }).success).toBe(false);
    expect(schema().safeParse(legacy).success).toBe(false);
  });
  it("rejects unsupported versions and extra readiness, profile or nested fields", () => {
    for (const schemaVersion of [1, 3, "2"]) expect(schema().safeParse({ ...legacy, schemaVersion, fingerprint }).success).toBe(false);
    for (const extra of [{ ready: true }, { profileId: id }, { classification: "BIO" }]) {
      expect(schema().safeParse({ ...legacy, schemaVersion: 2, fingerprint, ...extra }).success).toBe(false);
    }
    expect(schema().safeParse({ ...legacy, schemaVersion: 2, fingerprint: { ...fingerprint, extra: true } }).success).toBe(false);
  });
  it("reuses strict byte and firmware build bounds", () => {
    for (const field of ["deviceType", "sensorType", "infraredType", "ambientLightType", "hardwareType"]) {
      for (const value of [-1, 256, 1.5]) expect(schema().safeParse({ ...legacy, schemaVersion: 2,
        fingerprint: { ...fingerprint, [field]: value } }).success).toBe(false);
    }
    for (const value of [-1, 65536, 1.5]) expect(schema().safeParse({ ...legacy, schemaVersion: 2,
      fingerprint: { ...fingerprint, firmware: { ...fingerprint.firmware, build: value } } }).success).toBe(false);
  });
  it("retains the original strict scan contract", () => {
    expect(shared.provisioningScanFoundSchema.parse(legacy)).toEqual(legacy);
    expect(shared.provisioningScanFoundSchema.safeParse({ ...legacy, schemaVersion: 2, fingerprint }).success).toBe(false);
  });
  it("exports the separate gateway scoped discovery topic", () => {
    const topics = (shared as Record<string, unknown>).bioDiscoveryTopics as { scanFoundV2: (site: string, gateway: string) => string };
    expect(topics).toBeDefined();
    expect(topics.scanFoundV2(id, id)).toBe(`sites/${id}/gateways/${id}/events/provisioning/scan-found-v2`);
  });
});
