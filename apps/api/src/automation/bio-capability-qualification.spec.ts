import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";
import { gatewayEventWatermarkMock } from "../../test/support/gateway-event-watermark.mock";
import type { MeshNode, Prisma } from "@prisma/client";
import type { BioSensorBlockedReason, BioSensorPreparationView } from "./bio-sensor-eligibility";

const siteId = "00000000-0000-4000-8000-000000000001";
const gatewayId = "00000000-0000-4000-8000-000000000002";
const meshNodeId = "00000000-0000-4000-8000-000000000003";
const eventId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-30T00:00:00Z");
const scope = { siteId, gatewayId, requireActiveClaim: true as const };
function report(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 2, eventId, siteId, gatewayId, meshNodeId, capabilityRevision: 2,
    sensorProtocol: "bio-usb-pulse", readiness: "ready", verifiedFingerprintId: "synthetic-profile",
    sensorModeVerifiedAt: now.toISOString(), verifiedAt: now.toISOString(), ...overrides };
}
type CapabilityNode = Pick<MeshNode, "id" | "vehicleSensorProtocol" | "vehicleSensorCapabilityStatus" |
  "vehicleSensorCapabilityVerifiedAt" | "vehicleSensorCapabilityRevision" | "vehicleSensorServerBound" |
  "vehicleVendorEventModelBound" | "bioPulseReadiness" | "bioPulseCapabilityRevision" | "bioPulseProfileId" |
  "bioPulseVerifiedAt" | "bioPulseSensorModeVerifiedAt"> & { fixtureId: string };
function context(nodeOverrides: Partial<CapabilityNode> = {}, blockedReasons: BioSensorBlockedReason[] = []) {
  const node: CapabilityNode = { id: meshNodeId, fixtureId: meshNodeId, vehicleSensorProtocol: "bio_usb_pulse",
    vehicleSensorCapabilityStatus: "unknown", vehicleSensorCapabilityVerifiedAt: null,
    vehicleSensorCapabilityRevision: 0n, vehicleSensorServerBound: false, vehicleVendorEventModelBound: false,
    bioPulseReadiness: "off", bioPulseCapabilityRevision: 0n, bioPulseProfileId: null, bioPulseVerifiedAt: null,
    bioPulseSensorModeVerifiedAt: null,
    ...nodeOverrides };
  const eligibility: BioSensorPreparationView & { fixtureId: string } = { fixtureId: meshNodeId,
    preparationCandidate: true, status: "ready", commandId: "synthetic-preparation",
    profileKey: "synthetic-profile", observedAt: now.toISOString(), blockedReasons };
  const calls: string[] = [];
  const tx = {
    // Node ownership and current SQL eligibility are separate evidence. Never
    // let an unrelated query fabricate a ready result from the advertised node.
    $queryRaw: jest.fn(async (query: Prisma.Sql) => {
      if (query.sql.includes('FROM "MeshNode" AS node')) return [node];
      if (query.sql.includes('bio_sensor_blocked_reasons(') && query.sql.includes('FROM "Fixture" fixture')) return [eligibility];
      throw new Error("unexpected BIO qualification fixture SQL");
    }), ...gatewayEventWatermarkMock(),
    meshNode: { update: jest.fn(async ({ data }) => { calls.push("metadata"); Object.assign(node, data); return node; }) },
    processedGatewayEvent: { findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({})) },
    vehicleEventRule: { findMany: jest.fn(async () => [{ id: eventId }]),
      updateMany: jest.fn(async () => { calls.push("disable"); return { count: 1 }; }) },
    mqttOutbox: { create: jest.fn() }
  };
  const service = new VehicleSensorCapabilityService({ $transaction: (fn: any) => fn(tx) } as never,
    { lockMutation: async () => {}, incrementDesiredRevision: async () => { calls.push("snapshot"); } } as never,
    { now: () => now } as never);
  return { service, node, tx, calls };
}

describe("internal BIO capability qualification", () => {
  it("stores BIO readiness with separate revision and never invents V1 evidence or an ACK", async () => {
    const { service, node, tx } = context();
    await expect(service.applyBioReport(report(), scope)).resolves.toEqual({ status: "applied", errorCode: null });
    expect(node).toMatchObject({ bioPulseReadiness: "ready", bioPulseCapabilityRevision: 2n,
      bioPulseProfileId: "synthetic-profile", bioPulseVerifiedAt: now, bioPulseSensorModeVerifiedAt: now,
      vehicleSensorCapabilityStatus: "unknown", vehicleSensorCapabilityRevision: 0n,
      vehicleSensorServerBound: false, vehicleVendorEventModelBound: false });
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });

  it.each(["profile_unverified", "mode_unverified"] as const)(
    "does not promote an advertised ready node when current SQL reports %s", async blockedReason => {
      const { service, node, tx } = context({}, [blockedReason]);
      await expect(service.applyBioReport(report(), scope)).resolves.toEqual({
        status: "rejected", errorCode: "bio_current_evidence_unverified"
      });
      expect(node).toMatchObject({ bioPulseReadiness: "off", bioPulseCapabilityRevision: 0n,
        bioPulseProfileId: null, bioPulseVerifiedAt: null, bioPulseSensorModeVerifiedAt: null });
      expect(tx.meshNode.update).not.toHaveBeenCalled();
      expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
    }
  );

  it.each(["off", "shadow", "degraded"])("disables affected rules before %s metadata is persisted", async readiness => {
    const { service, calls, node } = context({ bioPulseReadiness: "ready", bioPulseCapabilityRevision: 1n,
      bioPulseProfileId: "synthetic-profile", bioPulseVerifiedAt: now });
    await service.applyBioReport(report({ readiness }), scope);
    expect(calls).toEqual(["disable", "snapshot", "metadata"]);
    expect(node.bioPulseReadiness).toBe(readiness);
  });

  it.each([1, 2])("does not promote ready from revision %s when current degraded revision is 2", async capabilityRevision => {
    const { service, node, tx } = context({ bioPulseReadiness: "degraded", bioPulseCapabilityRevision: 2n });
    expect((await service.applyBioReport(report({ capabilityRevision }), scope)).status).not.toBe("applied");
    expect(node.bioPulseReadiness).toBe("degraded");
    expect(tx.meshNode.update).not.toHaveBeenCalled();
  });

  it("treats equal matching revision as duplicate without touching readiness", async () => {
    const { service, tx } = context({ bioPulseReadiness: "ready", bioPulseCapabilityRevision: 2n,
      bioPulseProfileId: "synthetic-profile", bioPulseVerifiedAt: now, bioPulseSensorModeVerifiedAt: now });
    await expect(service.applyBioReport(report(), scope)).resolves.toEqual({ status: "duplicate", errorCode: null });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
  });

  it("rejects BIO claims about a server-owned BlueZ node", async () => {
    const { service, tx } = context({ vehicleSensorProtocol: "bluez_stateful" });
    await expect(service.applyBioReport(report(), scope)).rejects.toMatchObject({ status: 400 });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
  });

  it.each([undefined, { ...scope, requireActiveClaim: false }, { ...scope, siteId: meshNodeId }])(
    "requires authenticated matching scope %s", async invalidScope => {
      const { service, tx } = context();
      await expect(service.applyBioReport(report(), invalidScope as never)).rejects.toMatchObject({ status: 400 });
      expect(tx.meshNode.update).not.toHaveBeenCalled();
    });

  it("rejects V1 support claims for BIO nodes before writing model flags", async () => {
    const { service, tx } = context();
    await expect(service.applyReport({ schemaVersion: 1, eventId, siteId, gatewayId, meshNodeId,
      capabilityRevision: 1, status: "supported", verifiedAt: now.toISOString(),
      sensorServerBound: true, vendorVehicleEventModelBound: true }, scope)).rejects.toMatchObject({ status: 400 });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
  });

  it("disables existing rules if a fresh ready report changes the verified profile", async () => {
    const { service, calls } = context({ bioPulseReadiness: "ready", bioPulseCapabilityRevision: 1n,
      bioPulseProfileId: "old-profile", bioPulseVerifiedAt: now });
    await service.applyBioReport(report(), scope);
    expect(calls).toEqual(["disable", "snapshot", "metadata"]);
  });

  it("does not promote readiness when a retained event ID conflicts", async () => {
    const { service, tx, node } = context();
    tx.processedGatewayEvent.findUnique.mockResolvedValueOnce({ eventId, gatewayId, meshNodeId,
      sequence: 2n, eventType: "bio_pulse_capability", payloadHash: "sha256:different" } as never);
    await expect(service.applyBioReport(report(), scope)).resolves.toEqual({ status: "rejected", errorCode: "capability_event_conflict" });
    expect(node.bioPulseReadiness).toBe("off");
  });

  it("uses the durable watermark after raw ledger retention", async () => {
    const { service, tx, node } = context();
    tx.gatewayEventWatermark.findUnique.mockResolvedValueOnce({ lastSequence: 3n,
      lastEventId: eventId, lastPayloadHash: "sha256:retained", lastOccurredAt: now });
    await expect(service.applyBioReport(report(), scope)).resolves.toEqual({ status: "stale", errorCode: null });
    expect(node.bioPulseReadiness).toBe("off");
  });

  it.each([{ verifiedFingerprintId: null }, { sensorModeVerifiedAt: null }, { capabilityRevision: 0 }])(
    "rejects malformed ready evidence %s", async overrides => {
      const { service, tx } = context();
      await expect(service.applyBioReport(report(overrides), scope)).rejects.toMatchObject({ status: 400 });
      expect(tx.meshNode.update).not.toHaveBeenCalled();
    });
});
