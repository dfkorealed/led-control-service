import { describe, expect, it } from "vitest";
import { automationExecutionEventV1Schema } from "./automation-contracts";
import { bioPulseExecutionEventV2Schema } from "./bio-pulse-telemetry-contracts";

const id = "00000000-0000-4000-8000-000000000001";
const event = { schemaVersion: 2, eventId: id, sequence: 1, gatewayId: id, revision: 4, ruleId: id,
  occurrenceKey: `${id}:2026-09-30T00:00:00.000Z`, occurredAt: "2026-09-30T00:00:00.000Z", kind: "action_result",
  payload: { sensorProtocol: "bio-usb-pulse", verification: "configuration_readback", phase: "restore",
    results: [{ fixtureId: id, status: "succeeded", configuration: { configuredHighBrightnessPercent: 30, bioMode: "sensor" } }] } };

describe("strict BIO V2 telemetry, independent of V1 execution", () => {
  it("accepts configuration read-back evidence only as V2", () => {
    expect(bioPulseExecutionEventV2Schema.safeParse(event).success).toBe(true);
    expect(automationExecutionEventV1Schema.safeParse(event).success).toBe(false);
    expect(automationExecutionEventV1Schema.safeParse({ ...event, schemaVersion: 1 }).success).toBe(false);
  });
  it.each([
    { ...event, rawBody: "aabb" },
    { ...event, payload: { ...event.payload, nativeUuid: "001122334455" } },
    { ...event, payload: { ...event.payload, results: [{ ...event.payload.results[0], brightnessPercent: 30 }] } },
    { ...event, payload: { ...event.payload, results: [{ ...event.payload.results[0], configuration: null }] } },
    { ...event, payload: { ...event.payload, results: [...event.payload.results, ...event.payload.results] } },
    { ...event, payload: { ...event.payload, verification: "optical" } },
    { ...event, schemaVersion: 1 }
  ])("rejects malformed or nonredacted evidence %j", value => {
    expect(bioPulseExecutionEventV2Schema.safeParse(value).success).toBe(false);
  });
  it("requires a reason-bound health observation and rejects arbitrary reason text", () => {
    const health = { ...event, kind: "event_extended", payload: { sensorProtocol: "bio-usb-pulse", reason: "bio_source_degraded",
      health: "degraded", healthReason: "usb_disconnected", targetFixtureIds: [id], restorationPending: true } };
    expect(bioPulseExecutionEventV2Schema.safeParse(health).success).toBe(true);
    expect(bioPulseExecutionEventV2Schema.safeParse({ ...health, payload: { ...health.payload, healthReason: "native 001122334455" } }).success).toBe(false);
    expect(bioPulseExecutionEventV2Schema.safeParse({ ...health, payload: { ...health.payload, health: "healthy" } }).success).toBe(false);
  });
});
