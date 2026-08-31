import { describe, expect, it } from "vitest";
import {
  automationActionV1Schema,
  automationConfigAppliedDeliveryV1Schema,
  automationConfigAppliedReceiptV1Schema,
  automationConfigAppliedV1Schema,
  automationCurrentConfigRequestV1Schema,
  automationExecutionEventV1Schema,
  automationExecutionIngestedAckV1Schema,
  automationSnapshotV1Schema,
  manualOverrideWindowSchema,
  vehicleSensorCapabilityIngestedAckV1Schema,
  vehicleSensorCapabilityReportV1Schema
} from "./automation-contracts";
import {
  BLUETOOTH_COMPANY_ID_CONFIG,
  parseOwnedBluetoothCompanyId
} from "./vehicle-sensor-protocol";

const siteId = "00000000-0000-4000-8000-000000000003";
const gatewayId = "00000000-0000-4000-8000-000000000004";
const fixtureId = "33333333-3333-4333-8333-333333333333";
const fixtureId2 = "33333333-3333-4333-8333-333333333334";
const scheduleId = "44444444-4444-4444-8444-444444444444";
const vehicleRuleId = "55555555-5555-4555-8555-555555555555";
const eventId = "66666666-6666-4666-8666-666666666666";
const requestId = "77777777-7777-4777-8777-777777777777";
const acknowledgementId = "88888888-8888-4888-8888-888888888888";
const occurredAt = "2026-08-29T00:00:00.000Z";
const payloadHash = `sha256:${"a".repeat(64)}`;

const snapshot = {
  schemaVersion: 1 as const,
  siteId,
  gatewayId,
  revision: 3,
  timeZone: "Asia/Seoul",
  schedules: [{
    id: scheduleId,
    name: "Weekday opening",
    status: "enabled" as const,
    activeFrom: "2026-08-01T00:00:00.000Z",
    activeUntil: "2026-08-31T23:59:59.999Z",
    localStartTime: "08:00",
    localEndTime: "18:00",
    recurrence: {
      kind: "weekly" as const,
      weeklyDays: [1, 5],
      monthlyDay: null,
      yearlyMonth: null,
      yearlyDay: null
    },
    action: { dimmingEnabled: true, brightnessPercent: 60 },
    fixtureIds: [fixtureId]
  }],
  vehicleEventRules: [{
    id: vehicleRuleId,
    name: "Vehicle entrance",
    status: "enabled" as const,
    sourceFixtureIds: [fixtureId],
    targetFixtureIds: [fixtureId2],
    action: { dimmingEnabled: false, brightnessPercent: 100 },
    holdSeconds: 60
  }],
  generatedAt: occurredAt,
  payloadHash
};

describe("automation shared contracts", () => {
  it("requires one deployment-owned Bluetooth Company Identifier for Gateway and firmware builds", () => {
    expect(BLUETOOTH_COMPANY_ID_CONFIG).toEqual({
      gatewayEnvironment: "GATEWAY_BLUETOOTH_COMPANY_ID",
      firmwareSdkConfig: "CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID"
    });
    expect(parseOwnedBluetoothCompanyId("0x1234")).toBe(0x1234);
    expect(parseOwnedBluetoothCompanyId("4660")).toBe(0x1234);
    for (const rejected of [undefined, "", "0", "0x02e5", "65535", "0x10000", "12.5", "garbage"]) {
      expect(() => parseOwnedBluetoothCompanyId(rejected)).toThrow("owned_bluetooth_company_id_required");
    }
  });
  it("accepts disabled dimming with any valid brightness percentage", () => {
    expect(automationActionV1Schema.parse({ dimmingEnabled: false, brightnessPercent: 37 })).toEqual({
      dimmingEnabled: false,
      brightnessPercent: 37
    });
  });

  it("strictly validates a complete automation snapshot", () => {
    expect(automationSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(() => automationSnapshotV1Schema.parse({ ...snapshot, extra: true })).toThrow();
  });

  it.each([
    ["non-integer brightness", { action: { dimmingEnabled: true, brightnessPercent: 60.5 } }],
    ["out-of-range brightness", { action: { dimmingEnabled: true, brightnessPercent: 101 } }],
    ["empty vehicle source fixtures", { sourceFixtureIds: [] }],
    ["invalid hold duration", { holdSeconds: 4 }]
  ])("rejects a snapshot with %s", (_case, vehicleRulePatch) => {
    const vehicleEventRule = { ...snapshot.vehicleEventRules[0], ...vehicleRulePatch };
    expect(automationSnapshotV1Schema.safeParse({ ...snapshot, vehicleEventRules: [vehicleEventRule] }).success).toBe(false);
  });

  it("rejects a snapshot with duplicate schedule fixtures", () => {
    const schedule = { ...snapshot.schedules[0], fixtureIds: [fixtureId, fixtureId] };
    expect(automationSnapshotV1Schema.safeParse({ ...snapshot, schedules: [schedule] }).success).toBe(false);
  });

  it("rejects a schedule whose local start and end times are equal", () => {
    const schedule = {
      ...snapshot.schedules[0],
      localStartTime: "08:00",
      localEndTime: "08:00"
    };

    expect(automationSnapshotV1Schema.safeParse({ ...snapshot, schedules: [schedule] }).success).toBe(false);
  });

  it("requires valid, unique ISO weekdays for weekly recurrence", () => {
    const recurrence = { ...snapshot.schedules[0].recurrence, weeklyDays: [1, 1] };
    const schedule = { ...snapshot.schedules[0], recurrence };
    expect(automationSnapshotV1Schema.safeParse({ ...snapshot, schedules: [schedule] }).success).toBe(false);
    expect(automationSnapshotV1Schema.safeParse({
      ...snapshot,
      schedules: [{ ...schedule, recurrence: { ...recurrence, weeklyDays: [0] } }]
    }).success).toBe(false);
  });

  it("requires a recurrence shape that matches its kind", () => {
    const recurrence = { ...snapshot.schedules[0].recurrence, kind: "daily" as const };
    const schedule = { ...snapshot.schedules[0], recurrence };
    expect(automationSnapshotV1Schema.safeParse({ ...snapshot, schedules: [schedule] }).success).toBe(false);
  });

  it("strictly validates config application, execution, and ingestion acknowledgement payloads", () => {
    const applied = {
      schemaVersion: 1 as const,
      gatewayId,
      revision: 3,
      payloadHash,
      status: "applied" as const,
      errorCode: null,
      appliedAt: occurredAt
    };
    const execution = {
      schemaVersion: 1 as const,
      eventId,
      sequence: 9,
      gatewayId,
      revision: 3,
      ruleId: vehicleRuleId,
      occurrenceKey: null,
      kind: "event_started" as const,
      occurredAt,
      payload: { activeSourceFixtureIds: [fixtureId] }
    };
    const actionResult = {
      ...execution,
      sequence: 10,
      kind: "action_result" as const,
      payload: {
        sourceType: "vehicle_event_rule" as const,
        sourceId: vehicleRuleId,
        results: [{
          fixtureId: fixtureId2,
          status: "succeeded" as const,
          brightnessPercent: 100,
          faultCode: null,
          errorCode: null,
          occurredAt
        }]
      }
    };
    const acknowledgement = {
      schemaVersion: 1 as const,
      gatewayId,
      eventId,
      sequence: 9,
      reportPayloadHash: payloadHash,
      ingestedAt: occurredAt
    };

    expect(automationConfigAppliedV1Schema.parse(applied)).toEqual(applied);
    expect(automationExecutionEventV1Schema.parse(execution)).toEqual(execution);
    expect(automationExecutionEventV1Schema.parse(actionResult)).toEqual(actionResult);
    expect(automationExecutionIngestedAckV1Schema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(() => automationConfigAppliedV1Schema.parse({ ...applied, errorCode: "" })).toThrow();
    expect(() => automationExecutionEventV1Schema.parse({ ...execution, sequence: -1, extra: true })).toThrow();
    expect(() => automationExecutionEventV1Schema.parse({
      ...actionResult,
      ruleId: scheduleId
    })).toThrow();
    expect(() => automationExecutionEventV1Schema.parse({
      ...actionResult,
      payload: { ...actionResult.payload, results: [] }
    })).toThrow();
    expect(() => automationExecutionEventV1Schema.parse({
      ...actionResult,
      payload: {
        ...actionResult.payload,
        results: [actionResult.payload.results[0], actionResult.payload.results[0]]
      }
    })).toThrow();
    expect(() => automationExecutionIngestedAckV1Schema.parse({
      ...acknowledgement,
      reportPayloadHash: `sha256:${"A".repeat(64)}`
    })).toThrow();
    expect(() => automationExecutionIngestedAckV1Schema.parse({ ...acknowledgement, extra: true })).toThrow();
  });

  it("round-trips current-config requests and exact config-applied delivery receipts", () => {
    const request = {
      schemaVersion: 1 as const,
      requestId,
      siteId,
      gatewayId,
      requestedAt: occurredAt
    };
    const acknowledgement = automationConfigAppliedV1Schema.parse({
      schemaVersion: 1,
      gatewayId,
      revision: 3,
      payloadHash,
      status: "applied",
      errorCode: null,
      appliedAt: occurredAt
    });
    const delivery = {
      schemaVersion: 1 as const,
      acknowledgementId,
      siteId,
      gatewayId,
      acknowledgement
    };
    const receipt = {
      ...delivery,
      ingestedAt: "2026-08-29T00:00:01.000Z"
    };

    expect(automationCurrentConfigRequestV1Schema.parse(request)).toEqual(request);
    expect(automationConfigAppliedDeliveryV1Schema.parse(delivery)).toEqual(delivery);
    expect(automationConfigAppliedReceiptV1Schema.parse(receipt)).toEqual(receipt);
  });

  it("rejects malformed or cross-scope convergence payloads", () => {
    const acknowledgement = automationConfigAppliedV1Schema.parse({
      schemaVersion: 1,
      gatewayId,
      revision: 3,
      payloadHash,
      status: "applied",
      errorCode: null,
      appliedAt: occurredAt
    });
    const delivery = {
      schemaVersion: 1 as const,
      acknowledgementId,
      siteId,
      gatewayId,
      acknowledgement
    };

    expect(automationCurrentConfigRequestV1Schema.safeParse({
      schemaVersion: 1,
      requestId,
      siteId,
      gatewayId,
      requestedAt: occurredAt,
      extra: true
    }).success).toBe(false);
    expect(automationConfigAppliedDeliveryV1Schema.safeParse({
      ...delivery,
      gatewayId: "00000000-0000-4000-8000-000000000099"
    }).success).toBe(false);
    expect(automationConfigAppliedReceiptV1Schema.safeParse({
      ...delivery,
      ingestedAt: occurredAt,
      siteId: "not-a-site-id"
    }).success).toBe(false);
  });

  it("validates a nonempty manual override window", () => {
    const override = {
      fixtureIds: [fixtureId],
      brightnessPercent: 40,
      startedAt: occurredAt,
      overrideUntil: "2026-08-29T01:00:00.000Z"
    };

    expect(manualOverrideWindowSchema.parse(override)).toEqual(override);
    expect(() => manualOverrideWindowSchema.parse({ ...override, fixtureIds: [fixtureId, fixtureId] })).toThrow();
    expect(() => manualOverrideWindowSchema.parse({ ...override, overrideUntil: "not-an-instant" })).toThrow();
  });

  it("strictly validates supported and unsupported vehicle sensor capability reports", () => {
    const report = {
      schemaVersion: 1 as const,
      eventId,
      siteId,
      gatewayId,
      meshNodeId: fixtureId,
      capabilityRevision: 7,
      status: "supported" as const,
      verifiedAt: occurredAt,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    };

    expect(vehicleSensorCapabilityReportV1Schema.parse(report)).toEqual(report);
    expect(vehicleSensorCapabilityReportV1Schema.parse({
      ...report,
      status: "unsupported",
      sensorServerBound: false
    })).toMatchObject({ status: "unsupported", sensorServerBound: false });
    expect(() => vehicleSensorCapabilityReportV1Schema.parse({ ...report, sensorServerBound: false })).toThrow();
    expect(() => vehicleSensorCapabilityReportV1Schema.parse({ ...report, status: "unsupported" })).toThrow();
    expect(() => vehicleSensorCapabilityReportV1Schema.parse({ ...report, status: "unknown" })).toThrow();
    expect(() => vehicleSensorCapabilityReportV1Schema.parse({ ...report, capabilityRevision: 0 })).toThrow();
    expect(() => vehicleSensorCapabilityReportV1Schema.parse({ ...report, capabilityRevision: 1.5 })).toThrow();
    expect(() => vehicleSensorCapabilityReportV1Schema.parse({
      ...report,
      capabilityRevision: Number.MAX_SAFE_INTEGER + 1
    })).toThrow();
    expect(() => vehicleSensorCapabilityReportV1Schema.parse({ ...report, extra: true })).toThrow();
  });

  it("strictly validates vehicle sensor capability ingested acknowledgements", () => {
    const acknowledgement = {
      schemaVersion: 1 as const,
      eventId,
      gatewayId,
      meshNodeId: fixtureId,
      capabilityRevision: 7,
      reportPayloadHash: payloadHash,
      status: "applied" as const,
      errorCode: null,
      ingestedAt: occurredAt
    };

    for (const status of ["applied", "stale", "duplicate"] as const) {
      expect(vehicleSensorCapabilityIngestedAckV1Schema.parse({
        ...acknowledgement,
        status
      })).toMatchObject({ status, errorCode: null });
    }
    expect(vehicleSensorCapabilityIngestedAckV1Schema.parse({
      ...acknowledgement,
      status: "rejected",
      errorCode: "capability_event_conflict"
    })).toMatchObject({ status: "rejected", errorCode: "capability_event_conflict" });
    expect(() => vehicleSensorCapabilityIngestedAckV1Schema.parse({
      ...acknowledgement,
      capabilityRevision: 0
    })).toThrow();
    expect(() => vehicleSensorCapabilityIngestedAckV1Schema.parse({
      ...acknowledgement,
      status: "rejected",
      errorCode: ""
    })).toThrow();
    expect(() => vehicleSensorCapabilityIngestedAckV1Schema.parse({
      ...acknowledgement,
      reportPayloadHash: undefined
    })).toThrow();
    for (const reportPayloadHash of [
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
      "sha256:not-hex"
    ]) {
      expect(() => vehicleSensorCapabilityIngestedAckV1Schema.parse({
        ...acknowledgement,
        reportPayloadHash
      })).toThrow();
    }
    expect(() => vehicleSensorCapabilityIngestedAckV1Schema.parse({
      ...acknowledgement,
      extra: true
    })).toThrow();
  });
});
