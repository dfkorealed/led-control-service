import { describe, expect, it } from "vitest";
import {
  automationActionV1Schema,
  automationConfigAppliedDeliveryV1Schema,
  automationConfigAppliedReceiptV1Schema,
  automationConfigAppliedV1Schema,
  automationConfigAppliedV2Schema,
  automationConfigAppliedDeliveryV2Schema,
  automationConfigAppliedReceiptV2Schema,
  automationCurrentConfigRequestV2Schema,
  automationCurrentConfigRequestV1Schema,
  automationExecutionEventV1Schema,
  automationExecutionIngestedAckV1Schema,
  automationSnapshotV1Schema,
  automationSnapshotV2Schema,
  vehicleEventRuleSnapshotV2Schema,
  vehicleSensorCapabilityIngestedAckV1Schema,
  vehicleSensorCapabilityIngestedAckV2Schema,
  vehicleSensorCapabilityDeliveryV2Schema,
  matchesVehicleSensorCapabilityIngestedAckV2,
  vehicleSensorCapabilityReportV1Schema,
  vehicleSensorCapabilityReportV2Schema
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
  it("requires explicit ordered assignment-bound support independently of snapshot ACK", () => {
    const request = { schemaVersion: 2, requestId, siteId, gatewayId, requestedAt: occurredAt,
      assignmentVersion: 1, declarationRevision: 1, maxSnapshotVersion: 2 };
    expect(automationCurrentConfigRequestV2Schema.safeParse(request).success).toBe(true);
    expect(automationCurrentConfigRequestV2Schema.safeParse({ ...request, maxSnapshotVersion: 1 }).success).toBe(true);
    for (const patch of [{ declarationRevision: 0 }, { declarationRevision: 1.5 },
      { declarationRevision: Number.MAX_SAFE_INTEGER + 1 }, { assignmentVersion: -1 },
      { maxSnapshotVersion: 3 }, { maxSnapshotVersion: undefined }, { readiness: "ready" }]) {
      expect(automationCurrentConfigRequestV2Schema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
    expect(automationCurrentConfigRequestV1Schema.safeParse(request).success).toBe(false);
  });

  it("binds V2 ACK delivery and receipt to the same wire version and Gateway", () => {
    const acknowledgement = { schemaVersion: 2, gatewayId, revision: 3, payloadHash,
      status: "applied", errorCode: null, appliedAt: occurredAt };
    const delivery = { schemaVersion: 2, acknowledgementId, siteId, gatewayId, acknowledgement };
    expect(automationConfigAppliedDeliveryV2Schema.safeParse(delivery).success).toBe(true);
    expect(automationConfigAppliedReceiptV2Schema.safeParse({ ...delivery, ingestedAt: occurredAt }).success).toBe(true);
    expect(automationConfigAppliedDeliveryV1Schema.safeParse(delivery).success).toBe(false);
    for (const patch of [{ schemaVersion: 1 }, { gatewayId: siteId }, { status: "applied", errorCode: "failed" }]) {
      expect(automationConfigAppliedDeliveryV2Schema.safeParse({ ...delivery,
        acknowledgement: { ...acknowledgement, ...patch } }).success).toBe(false);
    }
    expect(automationConfigAppliedReceiptV2Schema.safeParse({ ...delivery, ingestedAt: occurredAt,
      readiness: "ready" }).success).toBe(false);
  });
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

  it("keeps V1 snapshots strict when V2 protocol fields are introduced", () => {
    expect(automationSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    const v2Rule = { ...snapshot.vehicleEventRules[0], sensorProtocol: "bluez-stateful" };
    expect(automationSnapshotV1Schema.safeParse({
      ...snapshot,
      vehicleEventRules: [v2Rule]
    }).success).toBe(false);
  });

  it.each([
    ["bluez-stateful", 5],
    ["bluez-stateful", 1_800],
    ["bio-usb-pulse", 10],
    ["bio-usb-pulse", 60],
    ["bio-usb-pulse", 1_800]
  ] as const)("accepts %s V2 vehicle rule with %s-second hold", (sensorProtocol, holdSeconds) => {
    const rule = { ...snapshot.vehicleEventRules[0], sensorProtocol, holdSeconds };
    expect(vehicleEventRuleSnapshotV2Schema.parse(rule)).toEqual(rule);
    const v2Snapshot = {
      ...snapshot,
      schemaVersion: 2,
      vehicleEventRules: [rule]
    };
    expect(automationSnapshotV2Schema.parse(v2Snapshot)).toEqual(v2Snapshot);
    expect(automationSnapshotV1Schema.safeParse(v2Snapshot).success).toBe(false);
  });

  it.each([
    ["bio-usb-pulse", 9],
    ["bio-usb-pulse", 1_801],
    ["bio-usb-pulse", 10.5],
    ["bluez-stateful", 4],
    ["bluez-stateful", 1_801],
    ["unknown", 60]
  ])("rejects %s V2 vehicle rule with %s-second hold", (sensorProtocol, holdSeconds) => {
    expect(vehicleEventRuleSnapshotV2Schema.safeParse({
      ...snapshot.vehicleEventRules[0],
      sensorProtocol,
      holdSeconds
    }).success).toBe(false);
  });

  it("rejects extra V2 fields at both rule and snapshot boundaries", () => {
    const rule = { ...snapshot.vehicleEventRules[0], sensorProtocol: "bio-usb-pulse" };
    expect(vehicleEventRuleSnapshotV2Schema.safeParse({ ...rule, extra: true }).success).toBe(false);
    expect(automationSnapshotV2Schema.safeParse({
      ...snapshot,
      schemaVersion: 2,
      vehicleEventRules: [rule],
      extra: true
    }).success).toBe(false);
  });

  it("requires a V2 config applied acknowledgement for a V2 snapshot", () => {
    const acknowledgement = {
      schemaVersion: 2,
      gatewayId,
      revision: 3,
      payloadHash,
      status: "applied",
      errorCode: null,
      appliedAt: occurredAt
    };
    expect(automationConfigAppliedV2Schema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(automationConfigAppliedV1Schema.safeParse(acknowledgement).success).toBe(false);
    expect(automationConfigAppliedV2Schema.safeParse({ ...acknowledgement, schemaVersion: 1 }).success).toBe(false);
    expect(automationConfigAppliedV2Schema.safeParse({ ...acknowledgement, extra: true }).success).toBe(false);
  });

  it.each([
    [1, automationConfigAppliedV1Schema],
    [2, automationConfigAppliedV2Schema]
  ] as const)("enforces V%i config ACK error-code semantics", (schemaVersion, schema) => {
    const acknowledgement = {
      schemaVersion,
      gatewayId,
      revision: 3,
      payloadHash,
      status: "applied" as const,
      errorCode: null,
      appliedAt: occurredAt
    };
    expect(schema.parse(acknowledgement)).toEqual(acknowledgement);
    expect(schema.parse({ ...acknowledgement, status: "rejected", errorCode: "snapshot_invalid" }))
      .toMatchObject({ status: "rejected", errorCode: "snapshot_invalid" });

    const appliedWithError = schema.safeParse({ ...acknowledgement, errorCode: "snapshot_invalid" });
    expect(appliedWithError.success).toBe(false);
    if (!appliedWithError.success) {
      expect(appliedWithError.error.issues).toContainEqual(expect.objectContaining({
        path: ["errorCode"],
        message: "applied configuration cannot include an errorCode"
      }));
    }
    const rejectedWithoutError = schema.safeParse({ ...acknowledgement, status: "rejected" });
    expect(rejectedWithoutError.success).toBe(false);
    if (!rejectedWithoutError.success) {
      expect(rejectedWithoutError.error.issues).toContainEqual(expect.objectContaining({
        path: ["errorCode"],
        message: "rejected configuration requires an errorCode"
      }));
    }
    expect(schema.safeParse({ ...acknowledgement, status: "rejected", errorCode: "" }).success).toBe(false);
    expect(schema.safeParse({ ...acknowledgement, extra: true }).success).toBe(false);
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

  it("keeps BIO V2 capability separate from the BlueZ V1 binding report", () => {
    const bioReport = {
      schemaVersion: 2,
      eventId,
      siteId,
      gatewayId,
      meshNodeId: fixtureId,
      capabilityRevision: 7,
      sensorProtocol: "bio-usb-pulse",
      readiness: "off",
      verifiedFingerprintId: null,
      sensorModeVerifiedAt: null,
      verifiedAt: occurredAt
    };
    expect(vehicleSensorCapabilityReportV2Schema.parse(bioReport)).toEqual(bioReport);
    expect(vehicleSensorCapabilityReportV1Schema.safeParse(bioReport).success).toBe(false);
    expect(vehicleSensorCapabilityReportV2Schema.safeParse({
      ...bioReport,
      schemaVersion: 1,
      sensorProtocol: "bluez-stateful"
    }).success).toBe(false);
    expect(vehicleSensorCapabilityReportV2Schema.safeParse({
      ...bioReport,
      sensorServerBound: true
    }).success).toBe(false);
  });

  it("requires an approved fingerprint and sensor-mode verification before BIO readiness is ready", () => {
    const report = {
      schemaVersion: 2,
      eventId,
      siteId,
      gatewayId,
      meshNodeId: fixtureId,
      capabilityRevision: 7,
      sensorProtocol: "bio-usb-pulse",
      readiness: "ready",
      verifiedFingerprintId: "approved-profile-2026-09",
      sensorModeVerifiedAt: occurredAt,
      verifiedAt: occurredAt
    };
    expect(vehicleSensorCapabilityReportV2Schema.parse(report)).toEqual(report);
    expect(vehicleSensorCapabilityReportV2Schema.safeParse({ ...report, verifiedFingerprintId: null }).success).toBe(false);
    expect(vehicleSensorCapabilityReportV2Schema.safeParse({ ...report, sensorModeVerifiedAt: null }).success).toBe(false);
    expect(vehicleSensorCapabilityReportV2Schema.safeParse({ ...report, verifiedFingerprintId: "" }).success).toBe(false);
    expect(vehicleSensorCapabilityReportV2Schema.safeParse({ ...report, readiness: "unknown" }).success).toBe(false);
    expect(vehicleSensorCapabilityReportV2Schema.safeParse({ ...report, extra: true }).success).toBe(false);
    for (const readiness of ["shadow", "degraded", "off"]) {
      expect(vehicleSensorCapabilityReportV2Schema.parse({ ...report, readiness })).toMatchObject({ readiness });
    }
  });

  describe("BIO capability V2 delivery and receipt", () => {
    const delivery = {
      schemaVersion: 2 as const,
      assignmentVersion: 3,
      report: {
        schemaVersion: 2 as const, eventId, siteId, gatewayId, meshNodeId: fixtureId,
        capabilityRevision: 7, sensorProtocol: "bio-usb-pulse" as const,
        readiness: "shadow" as const, verifiedFingerprintId: null,
        sensorModeVerifiedAt: null, verifiedAt: occurredAt
      }
    };
    const receipt = {
      schemaVersion: 2 as const, siteId, gatewayId, assignmentVersion: 3,
      eventId, meshNodeId: fixtureId, capabilityRevision: 7,
      deliveryPayloadHash: payloadHash, status: "applied" as const,
      errorCode: null, ingestedAt: occurredAt
    };

    it("accepts an assignment-bound envelope without promoting shadow evidence", () => {
      expect(vehicleSensorCapabilityDeliveryV2Schema).toBeDefined();
      expect(vehicleSensorCapabilityDeliveryV2Schema.parse(delivery)).toEqual(delivery);
      expect(vehicleSensorCapabilityReportV2Schema.safeParse(delivery).success).toBe(false);
      expect(vehicleSensorCapabilityReportV1Schema.safeParse(delivery).success).toBe(false);
    });

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined])(
      "rejects an invalid delivery assignment %s", assignmentVersion => {
        expect(vehicleSensorCapabilityDeliveryV2Schema.safeParse({ ...delivery, assignmentVersion }).success).toBe(false);
      }
    );

    it("rejects unknown delivery fields and raw sensor material at both nesting levels", () => {
      for (const extra of [{ unknown: true }, { nativeUuid: "001122334455" }, { innerBodyHex: "0101" }]) {
        expect(vehicleSensorCapabilityDeliveryV2Schema.safeParse({ ...delivery, ...extra }).success).toBe(false);
        expect(vehicleSensorCapabilityDeliveryV2Schema.safeParse({
          ...delivery, report: { ...delivery.report, ...extra }
        }).success).toBe(false);
      }
      expect(vehicleSensorCapabilityDeliveryV2Schema.safeParse({ ...delivery, schemaVersion: 1 }).success).toBe(false);
      expect(vehicleSensorCapabilityDeliveryV2Schema.safeParse({
        ...delivery, report: { ...delivery.report, schemaVersion: 1 }
      }).success).toBe(false);
      expect(vehicleSensorCapabilityDeliveryV2Schema.safeParse({
        ...delivery, report: { ...delivery.report, readiness: "ready" }
      }).success).toBe(false);
    });

    it.each(["applied", "duplicate", "stale", "rejected"] as const)(
      "accepts the separate V2 %s receipt without producing a V1 acknowledgement", status => {
        const value = { ...receipt, status, errorCode: status === "rejected" ? "capability_event_conflict" : null };
        expect(vehicleSensorCapabilityIngestedAckV2Schema).toBeDefined();
        expect(vehicleSensorCapabilityIngestedAckV2Schema.parse(value)).toEqual(value);
        expect(vehicleSensorCapabilityIngestedAckV1Schema.safeParse(value).success).toBe(false);
      }
    );

    it("rejects missing receipt identity, unbounded errors and old report-only hashes", () => {
      for (const key of ["siteId", "gatewayId", "assignmentVersion", "eventId", "meshNodeId", "capabilityRevision", "deliveryPayloadHash"]) {
        expect(vehicleSensorCapabilityIngestedAckV2Schema.safeParse({ ...receipt, [key]: undefined }).success).toBe(false);
      }
      for (const patch of [
        { assignmentVersion: 0 }, { capabilityRevision: 0 }, { siteId: "not-a-uuid" },
        { deliveryPayloadHash: `sha256:${"A".repeat(64)}` }, { deliveryPayloadHash: "sha256:invalid" },
        { schemaVersion: 1 }, { status: "unknown" }, { ingestedAt: "invalid" },
        { errorCode: "" }, { errorCode: "x".repeat(129) }, { unexpected: true },
        { reportPayloadHash: payloadHash }, { nativeUuid: "001122334455" }, { innerBodyHex: "0101" }
      ]) {
        expect(vehicleSensorCapabilityIngestedAckV2Schema.safeParse({ ...receipt, ...patch }).success).toBe(false);
      }
      expect(vehicleSensorCapabilityIngestedAckV2Schema.parse({ ...receipt, errorCode: "x".repeat(128) }).errorCode).toHaveLength(128);
    });

    it("matches receipt attribution only, including rejected and shadow receipts", () => {
      expect(matchesVehicleSensorCapabilityIngestedAckV2).toBeDefined();
      expect(matchesVehicleSensorCapabilityIngestedAckV2(delivery, receipt, payloadHash)).toBe(true);
      expect(matchesVehicleSensorCapabilityIngestedAckV2(delivery, {
        ...receipt, status: "rejected", errorCode: "capability_event_conflict"
      }, payloadHash)).toBe(true);
    });

    it("rejects receipt replay across any delivery identity or assignment", () => {
      for (const patch of [
        { siteId: fixtureId2 }, { gatewayId: fixtureId2 }, { eventId: requestId },
        { meshNodeId: fixtureId2 }, { capabilityRevision: 8 }, { assignmentVersion: 4 },
        { deliveryPayloadHash: `sha256:${"b".repeat(64)}` }
      ]) {
        expect(matchesVehicleSensorCapabilityIngestedAckV2(delivery, { ...receipt, ...patch }, payloadHash)).toBe(false);
      }
      expect(matchesVehicleSensorCapabilityIngestedAckV2({ ...delivery, assignmentVersion: 4 }, receipt, payloadHash)).toBe(false);
      for (const expectedHash of ["", "sha256:invalid", `sha256:${"A".repeat(64)}`]) {
        expect(matchesVehicleSensorCapabilityIngestedAckV2(delivery, { ...receipt, deliveryPayloadHash: expectedHash }, expectedHash)).toBe(false);
      }
      expect(matchesVehicleSensorCapabilityIngestedAckV2(delivery, { ...receipt, extra: true }, payloadHash)).toBe(false);
      expect(matchesVehicleSensorCapabilityIngestedAckV2({ ...delivery, extra: true }, receipt, payloadHash)).toBe(false);
      expect(matchesVehicleSensorCapabilityIngestedAckV2(null, null, payloadHash)).toBe(false);
    });
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
