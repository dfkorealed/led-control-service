import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { ProvisioningDeviceTerminalService } from "../mqtt/provisioning-device-terminal.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { BioClassificationReconciliationService } from "./bio-classification-reconciliation.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";

const enabled = process.env.BIO_CLASSIFICATION_RECONCILIATION_TEST === "1";
const now = new Date("2026-10-02T00:00:00Z");
const ids = { org: randomUUID(), user: randomUUID(), site: randomUUID(), floor: randomUUID(),
  gateway: randomUUID(), inventory: randomUUID(), certificate: randomUUID(), session: randomUUID(),
  fixtures: [randomUUID(), randomUUID()], commands: [randomUUID(), randomUUID()] };
const uuids = ["bio:aabbccddeeff", "bio:aabbccddee00"];
const scope = { siteId: ids.site, gatewayId: ids.gateway };
const body = () => ({ ...scope, expectedAssignmentVersion: 2, fixtureIds: ids.fixtures, requestId: randomUUID() });
const user: AuthenticatedUser = { id: ids.user, organizationId: ids.org, organizationType: "customer",
  loginId: "disposable-bio-repair", name: "Disposable", role: "admin", status: "active", mustChangePassword: false };

(enabled ? describe : describe.skip)("existing BIO classification on disposable PostgreSQL", () => {
  jest.setTimeout(60_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  function service(client: any = db) {
    return new BioClassificationReconciliationService(client, new SiteAccessService(client),
      new AuditService(client), { now: () => now });
  }
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    expect(cluster.deploy(url).status).toBe(0);
    cluster.sql(url, `ALTER DATABASE "${new URL(url).pathname.slice(1)}" SET TimeZone TO 'Asia/Seoul'`);
    db = new PrismaClient({ datasourceUrl: url });
  });
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    // Only this helper's private database, never an ambient DATABASE_URL.
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    // AuditLog intentionally has no Organization FK; clear only our private DB.
    await db.auditLog.deleteMany();
    await db.organization.create({ data: { id: ids.org, name: "Disposable repair" } });
    await db.user.create({ data: { id: ids.user, organizationId: ids.org, loginId: user.loginId,
      name: user.name, role: "admin", passwordHash: "test-only" } });
    await db.site.create({ data: { id: ids.site, organizationId: ids.org, adminUserId: ids.user, name: "Disposable" } });
    await db.floor.create({ data: { id: ids.floor, siteId: ids.site, name: "Disposable", level: 1 } });
    await db.gateway.create({ data: { id: ids.gateway, siteId: ids.site, name: "Disposable", serialNumber: "BIO-REPAIR-TEST",
      firmwareVersion: "test", claimedAt: now, assignmentVersion: 2 } });
    await db.gatewayInventory.create({ data: { id: ids.inventory, serialNumber: "BIO-REPAIR-TEST", claimedGatewayId: ids.gateway, claimedAt: now } });
    await db.gatewayCertificate.create({ data: { id: ids.certificate, inventoryId: ids.inventory, gatewayId: ids.gateway,
      purpose: "mqtt", certificateSerial: "test-only", fingerprint: "test-only-bio-repair", issuer: "test-only",
      status: "active", notBefore: new Date(now.getTime() - 60_000), notAfter: new Date(now.getTime() + 60_000) } });
    await db.provisioningSession.create({ data: { id: ids.session, ...scope, floorId: ids.floor, requestedBy: ids.user } });
    const terminal = new ProvisioningDeviceTerminalService(db as never, new MeshControlGroupService());
    for (let i = 0; i < 2; i++) {
      const address = `0x010${i}`;
      await db.discoveredMeshNode.create({ data: { id: ids.fixtures[i], sessionId: ids.session, deviceUuid: uuids[i],
        serialNumber: "Disposable", rssi: -60, firmwareVersion: "test", oobCapability: "none", status: "provisioning",
        meshAddress: address, pendingFixtureName: `Light ${i}`, pendingFixtureX: i, pendingFixtureY: 2 } });
      await db.provisioningDeviceOutbox.create({ data: { id: ids.commands[i], sessionId: ids.session, nodeId: ids.fixtures[i],
        topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/provisioning/provision-device`, payload: {
          ...scope, commandId: ids.commands[i], sessionId: ids.session, nodeId: ids.fixtures[i], deviceUuid: uuids[i],
          meshAddress: address, requestedAt: now.toISOString() } } });
      await terminal.completeLegacy(scope, { sessionId: ids.session, nodeId: ids.fixtures[i], deviceUuid: uuids[i],
        meshAddress: address, completedAt: now.toISOString() });
      await db.fixture.update({ where: { id: ids.fixtures[i] }, data: { brightness: 35 + i, powerOn: true } });
    }
  });
  async function preserved() {
    return { fixtures: await db.fixture.findMany({ orderBy: { id: "asc" } }),
      groups: await db.meshControlGroup.findMany({ orderBy: { id: "asc" } }),
      memberships: await db.meshControlGroupMember.findMany({ orderBy: { groupId: "asc" } }),
      discovered: await db.discoveredMeshNode.findMany({ orderBy: { id: "asc" } }),
      commands: await db.provisioningDeviceOutbox.findMany({ orderBy: { id: "asc" } }),
      ledger: await db.processedGatewayEvent.findMany({ orderBy: { eventId: "asc" } }) };
  }
  it("atomically repairs A/B protocol only, preserves existing graph/output and audits legacy completion", async () => {
    const before = await preserved();
    const beforeNodes = await db.meshNode.findMany({ orderBy: { id: "asc" } });
    const input = body();
    expect(await service().reconcile(user, input)).toEqual({ changedFixtureIds: ids.fixtures, unchangedFixtureIds: [] });
    expect(await preserved()).toEqual(before);
    for (const node of await db.meshNode.findMany()) expect(node).toMatchObject({ vehicleSensorProtocol: "bio_usb_pulse",
      bioPulseReadiness: "off", bioPulseCapabilityRevision: 0n, bioPulseProfileId: null, bioPulseVerifiedAt: null,
      vehicleSensorCapabilityStatus: "unknown", vehicleSensorCapabilityRevision: 0n });
    const unchangedNodeFields = (rows: typeof beforeNodes) => rows.map(({ vehicleSensorProtocol: _protocol, updatedAt: _updated, ...fields }) => fields);
    expect(unchangedNodeFields(await db.meshNode.findMany({ orderBy: { id: "asc" } }))).toEqual(unchangedNodeFields(beforeNodes));
    const audits = await db.auditLog.findMany();
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toMatchObject({ actorId: ids.user, siteId: ids.site, outcome: "changed" });
      expect(audit.metadata).toMatchObject({ requestId: input.requestId, evidenceKind: "legacy_completed_graph_command" });
      expect(JSON.stringify(audit)).not.toContain("bio:aabb");
    }
    expect(await service().reconcile(user, input)).toEqual({ changedFixtureIds: [], unchangedFixtureIds: ids.fixtures });
    expect(await db.auditLog.count()).toBe(2);
  });
  it.each(["ready", "degraded"] as const)("preserves existing BIO %s qualification without auditing a change", async readiness => {
    for (const deviceUuid of uuids) await db.meshNode.update({ where: { deviceUuid }, data: {
      vehicleSensorProtocol: "bio_usb_pulse", bioPulseReadiness: readiness, bioPulseCapabilityRevision: 5n,
      bioPulseProfileId: "synthetic-profile", bioPulseVerifiedAt: now } });
    const nodes = await db.meshNode.findMany({ orderBy: { id: "asc" } });
    expect(await service().reconcile(user, body())).toEqual({ changedFixtureIds: [], unchangedFixtureIds: ids.fixtures });
    expect(await db.meshNode.findMany({ orderBy: { id: "asc" } })).toEqual(nodes);
    expect(await db.auditLog.count()).toBe(0);
  });
  it.each(["supported", "command", "missing-command", "identify-only", "address", "non-canonical", "ledger", "watermark"])(
    "rolls back every selected row for second-row %s conflict", async failure => {
      if (failure === "supported") await db.meshNode.update({ where: { deviceUuid: uuids[1] }, data: {
        vehicleSensorCapabilityStatus: "supported", vehicleSensorCapabilityRevision: 1n,
        vehicleSensorCapabilityVerifiedAt: now, vehicleSensorServerBound: true, vehicleVendorEventModelBound: true } });
      if (failure === "command") await db.provisioningDeviceOutbox.update({ where: { id: ids.commands[1] }, data: { payload: { invalid: true } } });
      if (failure === "missing-command") await db.provisioningDeviceOutbox.delete({ where: { id: ids.commands[1] } });
      if (failure === "identify-only") await db.discoveredMeshNode.update({ where: { id: ids.fixtures[1] }, data: { status: "discovered", identifyState: "confirmed" } });
      if (failure === "address") await db.meshNode.update({ where: { deviceUuid: uuids[1] }, data: { meshAddress: "0x0123" } });
      if (failure === "non-canonical") await db.meshNode.update({ where: { deviceUuid: uuids[1] }, data: { deviceUuid: "44464b4c454401010101aabbccddeeff" } });
      const node = await db.meshNode.findFirstOrThrow({ where: { fixture: { id: ids.fixtures[1] } } });
      if (failure === "ledger") await db.processedGatewayEvent.create({ data: { eventId: randomUUID(), gatewayId: ids.gateway,
        meshNodeId: node.id, eventType: "vehicle_sensor_capability", scopeKey: node.id, sequence: 1n, occurredAt: now } });
      if (failure === "watermark") await db.gatewayEventWatermark.create({ data: { gatewayId: ids.gateway,
        eventType: "bio_pulse_capability", scopeKey: node.id, lastSequence: 1n, lastEventId: randomUUID(),
        lastPayloadHash: `sha256:${"a".repeat(64)}`, lastOccurredAt: now } });
      const before = await db.meshNode.findMany({ orderBy: { id: "asc" } });
      await expect(service().reconcile(user, body())).rejects.toThrow();
      expect(await db.meshNode.findMany({ orderBy: { id: "asc" } })).toEqual(before);
      expect(await db.auditLog.count()).toBe(0);
    }
  );

  async function addV2Receipt(index: number) {
    const nodeId = ids.fixtures[index], address = `0x010${index}`;
    const terminal = new ProvisioningDeviceTerminalService(db as never, new MeshControlGroupService());
    await terminal.ingest(scope, { ...scope, commandId: ids.commands[index], sessionId: ids.session,
      nodeId, deviceUuid: uuids[index], meshAddress: address, eventId: randomUUID(), sequence: index + 1,
      occurredAt: now.toISOString(), status: "completed" }, now);
    return db.mqttOutbox.findUniqueOrThrow({ where: {
      applicationAckKey: `provisioning-device-terminal:${ids.gateway}:${ids.commands[index]}` } });
  }
  it("uses a validated V2 receipt with the completed graph while preserving historical rows", async () => {
    await addV2Receipt(0);
    const before = await preserved();
    await service().reconcile(user, body());
    expect(await preserved()).toEqual(before);
    expect((await db.auditLog.findFirstOrThrow({ where: { metadata: { path: ["fixtureId"], equals: ids.fixtures[0] } } })).metadata)
      .toMatchObject({ evidenceKind: "v2_completed_graph_command_receipt" });
  });
  it.each(["ack-identity", "ack-hash", "missing-ledger", "ledger-sequence", "wrong-command-scope"])(
    "rejects inconsistent second-row V2 %s evidence and rolls back A", async failure => {
      const receipt = await addV2Receipt(1);
      const payload = receipt.payload as { eventId: string };
      if (failure === "ack-identity") {
        const changed = { ...(receipt.payload as object), deviceUuid: uuids[0] };
        await db.mqttOutbox.update({ where: { id: receipt.id }, data: { payload: changed, payloadHash: canonicalPayloadHash(changed) } });
      }
      if (failure === "ack-hash") await db.mqttOutbox.update({ where: { id: receipt.id }, data: { payloadHash: `sha256:${"f".repeat(64)}` } });
      if (failure === "missing-ledger") await db.processedGatewayEvent.delete({ where: { eventId: payload.eventId } });
      if (failure === "ledger-sequence") await db.processedGatewayEvent.update({ where: { eventId: payload.eventId }, data: { sequence: 99n } });
      if (failure === "wrong-command-scope") {
        const command = await db.provisioningDeviceOutbox.findUniqueOrThrow({ where: { id: ids.commands[1] } });
        await db.provisioningDeviceOutbox.update({ where: { id: command.id }, data: {
          payload: { ...(command.payload as object), gatewayId: randomUUID() } } });
      }
      await expect(service().reconcile(user, body())).rejects.toThrow();
      expect(await db.meshNode.count({ where: { vehicleSensorProtocol: "bluez_stateful" } })).toBe(2);
      expect(await db.auditLog.count()).toBe(0);
    }
  );
  it.each(["source", "target"])("does not repair a fixture belonging to an enabled event %s", async membership => {
    await db.meshNode.update({ where: { deviceUuid: uuids[0] }, data: { vehicleSensorCapabilityStatus: "supported",
      vehicleSensorCapabilityRevision: 1n, vehicleSensorCapabilityVerifiedAt: now,
      vehicleSensorServerBound: true, vehicleVendorEventModelBound: true } });
    // Membership existence is a deferred production CHECK. Build the rule and
    // its children atomically, exactly like the actual rule creation service.
    const rule = await db.$transaction(async tx => {
      const created = await tx.vehicleEventRule.create({ data: { ...scope, name: "Disposable enabled rule", status: "disabled",
        dimmingEnabled: true, brightnessPercent: 80, createdById: ids.user, updatedById: ids.user } });
      await tx.vehicleEventSource.create({ data: { ...scope, ruleId: created.id, fixtureId: ids.fixtures[0] } });
      await tx.vehicleEventTarget.create({ data: { ...scope, ruleId: created.id, fixtureId: ids.fixtures[1] } });
      return tx.vehicleEventRule.update({ where: { id: created.id }, data: { status: "enabled" } });
    });
    const fixtureId = ids.fixtures[membership === "source" ? 0 : 1];
    await expect(service().reconcile(user, { ...body(), fixtureIds: [fixtureId] })).rejects.toThrow();
    expect(await db.meshNode.count({ where: { vehicleSensorProtocol: "bluez_stateful" } })).toBe(2);
    expect((await db.vehicleEventRule.findUniqueOrThrow({ where: { id: rule.id } })).status).toBe("enabled");
    expect(await db.auditLog.count()).toBe(0);
  });
  it("rejects mixed floors and foreign or non-admin requests without any transition", async () => {
    await expect(service().reconcile({ ...user, role: "viewer" }, body())).rejects.toThrow();
    await expect(service().reconcile(user, { ...body(), siteId: randomUUID() })).rejects.toThrow();
    const floor = await db.floor.create({ data: { siteId: ids.site, name: "Other", level: 2 } });
    await db.fixture.update({ where: { id: ids.fixtures[1] }, data: { floorId: floor.id } });
    await expect(service().reconcile(user, body())).rejects.toThrow("one floor");
    expect(await db.meshNode.count({ where: { vehicleSensorProtocol: "bluez_stateful" } })).toBe(2);
    expect(await db.auditLog.count()).toBe(0);
  });
  it.each(["expired", "future", "revoked", "inventory-disabled", "inventory-unclaimed", "certificate-owner", "unclaimed", "assignment", "admin-disabled"])(
    "rejects current %s authority, including an exact retry", async failure => {
      const input = body();
      await service().reconcile(user, input);
      if (failure === "expired") await db.gatewayCertificate.update({ where: { id: ids.certificate }, data: { notAfter: now } });
      if (failure === "future") await db.gatewayCertificate.update({ where: { id: ids.certificate }, data: { notBefore: new Date(now.getTime() + 1) } });
      if (failure === "revoked") await db.gatewayCertificate.update({ where: { id: ids.certificate }, data: { status: "revoked", revokedAt: now } });
      if (failure === "inventory-disabled") await db.gatewayInventory.update({ where: { id: ids.inventory }, data: { disabledAt: now } });
      if (failure === "inventory-unclaimed") await db.gatewayInventory.update({ where: { id: ids.inventory }, data: { claimedAt: null } });
      if (failure === "certificate-owner") await db.gatewayCertificate.update({ where: { id: ids.certificate }, data: { gatewayId: null } });
      if (failure === "unclaimed") await db.gateway.update({ where: { id: ids.gateway }, data: { claimedAt: null } });
      if (failure === "assignment") await db.gateway.update({ where: { id: ids.gateway }, data: { assignmentVersion: 3 } });
      if (failure === "admin-disabled") {
        // Existing DB guards prohibit disabling an assigned admin. Respect the
        // normal retirement order rather than bypassing a production constraint.
        await db.site.update({ where: { id: ids.site }, data: { adminUserId: null } });
        await db.user.update({ where: { id: ids.user }, data: { status: "disabled" } });
      }
      await expect(service().reconcile(user, input)).rejects.toThrow();
      expect(await db.auditLog.count()).toBe(2);
    }
  );
  it("rolls back both protocol changes if atomic audit insertion fails", async () => {
    const failed = db.$extends({ query: { auditLog: { create: async () => { throw new Error("audit unavailable"); } } } });
    await expect(service(failed).reconcile(user, body())).rejects.toThrow("audit unavailable");
    expect(await db.meshNode.count({ where: { vehicleSensorProtocol: "bluez_stateful" } })).toBe(2);
    expect(await db.auditLog.count()).toBe(0);
  });
});
