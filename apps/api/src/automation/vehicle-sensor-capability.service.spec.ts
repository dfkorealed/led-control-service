import { BadRequestException } from "@nestjs/common";
import type { VehicleSensorCapabilityReportV1 } from "@led-control/shared";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
const NODE_ID = "00000000-0000-4000-8000-000000000003";
const FIXTURE_ID = "00000000-0000-4000-8000-000000000004";
const RULE_A_ID = "00000000-0000-4000-8000-000000000005";
const RULE_B_ID = "00000000-0000-4000-8000-000000000006";
const VERIFIED_AT = "2026-08-30T00:00:00.000Z";

function report(overrides: Partial<VehicleSensorCapabilityReportV1> = {}): VehicleSensorCapabilityReportV1 {
  return {
    schemaVersion: 1,
    eventId: "00000000-0000-4000-8000-000000000007",
    siteId: SITE_ID,
    gatewayId: GATEWAY_ID,
    meshNodeId: NODE_ID,
    status: "supported",
    verifiedAt: VERIFIED_AT,
    sensorServerBound: true,
    vendorVehicleEventModelBound: true,
    ...overrides
  };
}

function scopeRow(status: "unknown" | "supported" | "unsupported", verifiedAt: Date | null) {
  return {
    id: NODE_ID,
    vehicleSensorCapabilityStatus: status,
    vehicleSensorCapabilityVerifiedAt: verifiedAt,
    fixtureId: FIXTURE_ID
  };
}

describe("VehicleSensorCapabilityService", () => {
  it("rejects a malformed report before opening a transaction", async () => {
    const prisma = { $transaction: jest.fn() };
    const service = new VehicleSensorCapabilityService(prisma as never, {} as never);

    await expect(service.applyReport({ ...report(), sensorServerBound: false }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("acquires the automation lock before rejecting a forged scope without identifiers", async () => {
    const calls: string[] = [];
    const tx = {
      $queryRaw: jest.fn().mockImplementation(() => {
        calls.push("scope");
        return Promise.resolve([]);
      }),
      meshNode: { update: jest.fn() },
      vehicleEventRule: { findMany: jest.fn(), updateMany: jest.fn() }
    };
    const automationSnapshot = {
      lockMutation: jest.fn().mockImplementation(() => {
        calls.push("lock");
        return Promise.resolve();
      })
    };
    const service = new VehicleSensorCapabilityService(
      { $transaction: jest.fn((callback) => callback(tx)) } as never,
      automationSnapshot as never
    );

    const forged = report({ siteId: "00000000-0000-4000-8000-000000000099" });
    const error: unknown = await service.applyReport(forged).catch((caught: unknown) => caught);

    expect(calls).toEqual(["lock", "scope"]);
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse();
    expect(JSON.stringify(response)).not.toContain(forged.siteId);
    expect(JSON.stringify(response)).not.toContain(NODE_ID);
    expect(tx.meshNode.update).not.toHaveBeenCalled();
  });

  it("updates supported metadata without creating an automation revision", async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([scopeRow("unknown", null)]),
      meshNode: { update: jest.fn().mockResolvedValue({}) },
      vehicleEventRule: { findMany: jest.fn(), updateMany: jest.fn() }
    };
    const automationSnapshot = {
      lockMutation: jest.fn().mockResolvedValue(undefined),
      incrementDesiredRevision: jest.fn()
    };
    const service = new VehicleSensorCapabilityService(
      { $transaction: jest.fn((callback) => callback(tx)) } as never,
      automationSnapshot as never
    );

    await expect(service.applyReport(report())).resolves.toEqual({
      changed: true,
      disabledRuleCount: 0,
      desiredRevision: null
    });
    expect(tx.meshNode.update).toHaveBeenCalledWith({
      where: { id: NODE_ID },
      data: {
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: new Date(VERIFIED_AT)
      }
    });
    expect(tx.vehicleEventRule.findMany).not.toHaveBeenCalled();
    expect(automationSnapshot.incrementDesiredRevision).not.toHaveBeenCalled();
  });

  it("disables every enabled source rule, snapshots once, then stores unsupported metadata", async () => {
    const calls: string[] = [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([scopeRow("supported", new Date(VERIFIED_AT))]),
      meshNode: {
        update: jest.fn().mockImplementation(() => {
          calls.push("metadata");
          return Promise.resolve({});
        })
      },
      vehicleEventRule: {
        findMany: jest.fn().mockResolvedValue([{ id: RULE_B_ID }, { id: RULE_A_ID }]),
        updateMany: jest.fn().mockImplementation(() => {
          calls.push("disable");
          return Promise.resolve({ count: 2 });
        })
      }
    };
    const automationSnapshot = {
      lockMutation: jest.fn().mockResolvedValue(undefined),
      incrementDesiredRevision: jest.fn().mockImplementation(() => {
        calls.push("snapshot");
        return Promise.resolve({ desiredRevision: 9, appliedRevision: 4, syncStatus: "PENDING" });
      })
    };
    const service = new VehicleSensorCapabilityService(
      { $transaction: jest.fn((callback) => callback(tx)) } as never,
      automationSnapshot as never
    );

    await expect(service.applyReport(report({
      status: "unsupported",
      sensorServerBound: false
    }))).resolves.toEqual({ changed: true, disabledRuleCount: 2, desiredRevision: 9 });
    expect(tx.vehicleEventRule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [RULE_A_ID, RULE_B_ID] }, status: "enabled" },
      data: { status: "disabled" }
    });
    expect(automationSnapshot.incrementDesiredRevision).toHaveBeenCalledTimes(1);
    expect(automationSnapshot.incrementDesiredRevision).toHaveBeenCalledWith(tx, GATEWAY_ID);
    expect(calls).toEqual(["disable", "snapshot", "metadata"]);
  });

  it("does not rewrite metadata or revision for a repeated current report", async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([scopeRow("unsupported", new Date(VERIFIED_AT))]),
      meshNode: { update: jest.fn() },
      vehicleEventRule: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() }
    };
    const automationSnapshot = {
      lockMutation: jest.fn().mockResolvedValue(undefined),
      incrementDesiredRevision: jest.fn()
    };
    const service = new VehicleSensorCapabilityService(
      { $transaction: jest.fn((callback) => callback(tx)) } as never,
      automationSnapshot as never
    );

    await expect(service.applyReport(report({
      status: "unsupported",
      sensorServerBound: false
    }))).resolves.toEqual({ changed: false, disabledRuleCount: 0, desiredRevision: null });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
    expect(tx.vehicleEventRule.updateMany).not.toHaveBeenCalled();
    expect(automationSnapshot.incrementDesiredRevision).not.toHaveBeenCalled();
  });
});
