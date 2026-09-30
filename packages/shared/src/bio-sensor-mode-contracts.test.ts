import { describe, expect, it } from "vitest";
import { bioSensorModeCommandSchema, bioSensorModeResultSchema } from "./bio-sensor-mode-contracts";

const identity = { version: 2, commandId: "10000000-0000-4000-8000-000000000001", siteId: "10000000-0000-4000-8000-000000000002",
  gatewayId: "10000000-0000-4000-8000-000000000003", fixtureId: "10000000-0000-4000-8000-000000000004",
  nodeId: "10000000-0000-4000-8000-000000000005", meshAddress: "0x0001", assignmentVersion: 1, deviceIdentityHash: "a".repeat(64) };
const command = { ...identity, operation: "ensure_sensor", requestedAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-09-30T00:00:30.000Z" };
const result = { ...identity, operation: "ensure_sensor", eventId: "10000000-0000-4000-8000-000000000006", sequence: 1,
  occurredAt: "2026-09-30T00:00:02.000Z", status: "verified", modeVerified: true, observedMode: "sensor", evidence: "mode_get" };
describe("BIO sensor mode operation contracts", () => {
  it("admits an explicit bounded operation and fresh mode GET result", () => {
    expect(bioSensorModeCommandSchema.parse(command)).toEqual(command);
    expect(bioSensorModeResultSchema.parse(result)).toEqual(result);
  });
  it.each([{ evidence: "mqtt_ack" }, { observedMode: "force-on" }, { modeVerified: false }, { brightness: 100 }])("rejects non-GET or contradictory verification %j", (change) => {
    expect(bioSensorModeResultSchema.safeParse({ ...result, ...change }).success).toBe(false);
  });
  it("requires requery to be read-only and to have a distinct identity", () => {
    expect(bioSensorModeCommandSchema.safeParse({ ...command, requeryOfCommandId: identity.commandId }).success).toBe(false);
    expect(bioSensorModeCommandSchema.safeParse({ ...command, expiresAt: "2026-09-30T00:05:00.000Z" }).success).toBe(false);
  });
});
