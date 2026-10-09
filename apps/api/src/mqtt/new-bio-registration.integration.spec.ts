import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { ProvisioningDeviceTerminalV2 } from "@led-control/shared";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { ProvisioningDeviceTerminalService } from "./provisioning-device-terminal.service";

const enabled = process.env.NEW_BIO_REGISTRATION_TEST === "1";
const now = new Date("2026-10-02T00:00:00Z");
const ids = { org: randomUUID(), user: randomUUID(), site: randomUUID(), floor: randomUUID(),
  gateway: randomUUID(), session: randomUUID(), discovered: randomUUID(), command: randomUUID(), event: randomUUID() };
const bioUuid = "bio:aabbccddeeff";
const scope = { siteId: ids.site, gatewayId: ids.gateway };
const terminal = (deviceUuid = bioUuid): ProvisioningDeviceTerminalV2 => ({
  ...scope, sessionId: ids.session, nodeId: ids.discovered, commandId: ids.command,
  eventId: ids.event, sequence: 1, deviceUuid, meshAddress: "0x0100", status: "completed",
  occurredAt: now.toISOString(), firmwareVersion: "test"
});

(enabled ? describe : describe.skip)("new BIO registration on disposable PostgreSQL", () => {
  jest.setTimeout(60_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let service: ProvisioningDeviceTerminalService;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    // Real registration and group attachment; no MQTT publisher or hardware.
    service = new ProvisioningDeviceTerminalService(db as never, new MeshControlGroupService());
  });
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    // This client can reach only the cluster owned by this test helper.
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    await db.organization.create({ data: { id: ids.org, name: "Disposable BIO registration" } });
    await db.user.create({ data: { id: ids.user, organizationId: ids.org,
      loginId: "disposable-bio", name: "Disposable", passwordHash: "test-only", role: "admin" } });
    await db.site.create({ data: { id: ids.site, organizationId: ids.org, name: "Disposable" } });
    await db.floor.create({ data: { id: ids.floor, siteId: ids.site, name: "Disposable", level: 1 } });
    await db.gateway.create({ data: { id: ids.gateway, siteId: ids.site, name: "Disposable",
      serialNumber: "DISPOSABLE-BIO", firmwareVersion: "test" } });
    await db.provisioningSession.create({ data: { id: ids.session, ...scope, floorId: ids.floor,
      requestedBy: ids.user, scanStatus: "completed" } });
    await setDevice(bioUuid);
  });

  async function setDevice(deviceUuid: string) {
    await db.discoveredMeshNode.upsert({ where: { id: ids.discovered },
      create: { id: ids.discovered, sessionId: ids.session, deviceUuid, serialNumber: "Disposable",
        firmwareVersion: "test", rssi: -60, oobCapability: "none", status: "provisioning",
        identifyState: "idle", meshAddress: "0x0100", pendingFixtureName: "Disposable",
        pendingFixtureX: 1, pendingFixtureY: 2 }, update: { deviceUuid } });
    const payload = { ...scope, sessionId: ids.session, nodeId: ids.discovered, commandId: ids.command,
      deviceUuid, meshAddress: "0x0100", requestedAt: now.toISOString() };
    await db.provisioningDeviceOutbox.upsert({ where: { id: ids.command }, create: {
      id: ids.command, sessionId: ids.session, nodeId: ids.discovered,
      topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/provisioning/provision-device`, payload
    }, update: { payload } });
  }

  it("stores canonical BIO OFF with no identify prerequisite or invented output", async () => {
    await service.ingest(scope, terminal(), now);
    expect(await db.meshNode.findUniqueOrThrow({ where: { deviceUuid: bioUuid } })).toMatchObject({
      vehicleSensorProtocol: "bio_usb_pulse", bioPulseReadiness: "off", bioPulseCapabilityRevision: 0n,
      bioPulseProfileId: null, bioPulseVerifiedAt: null, vehicleSensorCapabilityStatus: "unknown",
      vehicleSensorCapabilityRevision: 0n, vehicleSensorCapabilityVerifiedAt: null,
      vehicleSensorServerBound: false, vehicleVendorEventModelBound: false
    });
    expect(await db.fixture.findUniqueOrThrow({ where: { id: ids.discovered } })).toMatchObject({ brightness: 0, powerOn: null });
    expect(await db.processedGatewayEvent.count()).toBe(1);
    expect(await db.mqttOutbox.count({ where: { applicationAckKey: { not: null } } })).toBe(1);
  });

  it.each(["44464b4c454401010101aabbccddeeff", "bio:AABBCCDDEEFF", "bio:aabbccddee"])(
    "keeps genuine BlueZ/default classification for non-canonical identity %s", async deviceUuid => {
      await setDevice(deviceUuid);
      await service.ingest(scope, terminal(deviceUuid), now);
      expect(await db.meshNode.findUniqueOrThrow({ where: { deviceUuid } })).toMatchObject({
        vehicleSensorProtocol: "bluez_stateful", bioPulseReadiness: "off", bioPulseCapabilityRevision: 0n
      });
    }
  );

  it("preserves legacy BIO registration default classification and online behavior", async () => {
    await service.completeLegacy(scope, { sessionId: ids.session, nodeId: ids.discovered,
      deviceUuid: bioUuid, meshAddress: "0x0100", completedAt: now.toISOString() });
    expect(await db.meshNode.findUniqueOrThrow({ where: { deviceUuid: bioUuid } })).toMatchObject({
      vehicleSensorProtocol: "bluez_stateful", bioPulseReadiness: "off", bioPulseCapabilityRevision: 0n
    });
    expect(await db.fixture.findUniqueOrThrow({ where: { id: ids.discovered } })).toMatchObject({
      status: "online", brightness: 0, powerOn: null
    });
  });

  it.each(["bluez_stateful", "bio_usb_pulse"] as const)("preserves existing %s qualification rather than reclassifying", async protocol => {
    const stored = await db.meshNode.create({ data: { gatewayId: ids.gateway, deviceUuid: bioUuid,
      meshAddress: "0x0100", firmwareVersion: "preserved", vehicleSensorProtocol: protocol,
      ...(protocol === "bio_usb_pulse" ? { bioPulseReadiness: "ready", bioPulseCapabilityRevision: 7n,
        bioPulseProfileId: "synthetic-test-profile", bioPulseVerifiedAt: now } : {
        vehicleSensorCapabilityStatus: "supported", vehicleSensorCapabilityRevision: 7n,
        vehicleSensorCapabilityVerifiedAt: now, vehicleSensorServerBound: true, vehicleVendorEventModelBound: true })
    } });
    await service.ingest(scope, terminal(), now);
    expect(await db.meshNode.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(stored);
  });

  it("preserves later qualification and output during an exact terminal replay", async () => {
    const first = await service.ingest(scope, terminal(), now);
    const stored = await db.meshNode.update({ where: { deviceUuid: bioUuid }, data: {
      bioPulseReadiness: "degraded", bioPulseCapabilityRevision: 3n } });
    const fixture = await db.fixture.update({ where: { id: ids.discovered }, data: { brightness: 65, powerOn: true } });
    expect(await service.ingest(scope, terminal(), new Date(now.getTime() + 1000))).toEqual(first);
    expect(await db.meshNode.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(stored);
    expect(await db.fixture.findUniqueOrThrow({ where: { id: fixture.id } })).toEqual(fixture);
  });

  it("does not classify a BIO node from mismatched completion or confirmed identify alone", async () => {
    await db.discoveredMeshNode.update({ where: { id: ids.discovered }, data: { identifyState: "confirmed" } });
    await expect(service.ingest(scope, { ...terminal(), meshAddress: "0x0101" } as ProvisioningDeviceTerminalV2, now)).rejects.toThrow("identity conflict");
    const base = terminal();
    const failed = { commandId: base.commandId, sessionId: base.sessionId, siteId: base.siteId,
      gatewayId: base.gatewayId, nodeId: base.nodeId, deviceUuid: base.deviceUuid, eventId: base.eventId,
      sequence: base.sequence, occurredAt: base.occurredAt, meshAddress: "0x0100", status: "failed" as const,
      errorCode: "test-only", errorMessage: "registration did not complete" };
    await service.ingest(scope, failed, now);
    expect(await db.meshNode.count()).toBe(0);
    expect(await db.fixture.count()).toBe(0);
  });
});
