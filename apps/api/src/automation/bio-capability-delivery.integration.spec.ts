import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { mqttTopics, type VehicleSensorCapabilityDeliveryV2 } from "@led-control/shared";

const enabled = process.env.BIO_CAPABILITY_DELIVERY_TEST === "1";
const migrationName = "20261002110000_bio_capability_node_ledger";
const migrationPath = join(__dirname, "../../prisma/migrations", migrationName, "migration.sql");
const now = new Date("2026-10-02T00:00:00Z");
const ids = { org: randomUUID(), site: randomUUID(), gateway: randomUUID(), inventory: randomUUID(),
  certificate: randomUUID(), node: randomUUID(), second: randomUUID(), bluez: randomUUID() };
const scope = { siteId: ids.site, gatewayId: ids.gateway, requireActiveClaim: true as const };
const report = (node: string = ids.node, revision = 2): VehicleSensorCapabilityDeliveryV2 => ({
  schemaVersion: 2, assignmentVersion: 2, report: {
    schemaVersion: 2, eventId: randomUUID(), siteId: ids.site, gatewayId: ids.gateway, meshNodeId: node,
    capabilityRevision: revision, sensorProtocol: "bio-usb-pulse", readiness: "shadow",
    verifiedFingerprintId: null, sensorModeVerifiedAt: null, verifiedAt: now.toISOString()
  }
});

(enabled ? describe : describe.skip)("BIO authenticated capability delivery on disposable PostgreSQL", () => {
  jest.setTimeout(60_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let service: VehicleSensorCapabilityService;
  let clockAt: Date;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    // Only this self-owned database: prove certificate boundaries in a non-UTC
    // SQL session rather than relying on the developer machine's timezone.
    cluster.sql(url, `ALTER DATABASE "${new URL(url).pathname.slice(1)}" SET TimeZone TO 'Asia/Seoul'`);
    db = new PrismaClient({ datasourceUrl: url });
    const clock = { now: () => clockAt };
    service = new VehicleSensorCapabilityService(db as never, new AutomationSnapshotService(clock as never), clock as never);
  });
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => { clockAt = now; await seed(db); });
  const ingest = (value: unknown, authenticatedScope = scope) =>
    service.applyBioDelivery(value, authenticatedScope);

  it("atomically stores envelope hash, node evidence and a distinct V2 receipt without enabling BIO", async () => {
    expect(await db.$queryRaw`SELECT current_setting('TimeZone') AS zone`).toEqual([{ zone: "Asia/Seoul" }]);
    const value = report();
    const ack = await ingest(value);
    expect(ack).toEqual({ schemaVersion: 2, siteId: ids.site, gatewayId: ids.gateway, assignmentVersion: 2,
      eventId: value.report.eventId, meshNodeId: ids.node, capabilityRevision: 2,
      deliveryPayloadHash: canonicalPayloadHash(value), status: "applied", errorCode: null, ingestedAt: now.toISOString() });
    expect(canonicalPayloadHash(value)).not.toBe(canonicalPayloadHash(value.report));
    expect(await db.meshNode.findUnique({ where: { id: ids.node } })).toMatchObject({
      bioPulseReadiness: "shadow", bioPulseCapabilityRevision: 2n, vehicleSensorCapabilityStatus: "unknown" });
    expect(await db.processedGatewayEvent.findUnique({ where: { eventId: value.report.eventId } })).toMatchObject({
      meshNodeId: ids.node, scopeKey: ids.node, eventType: "bio_pulse_capability", payloadHash: canonicalPayloadHash(value) });
    const row = await db.mqttOutbox.findFirstOrThrow();
    expect(row).toMatchObject({ gatewayId: ids.gateway, revision: null, automationAssignmentVersion: 2,
      topic: mqttTopics.vehicleSensorCapabilityIngested(ids.site, ids.gateway), payload: ack,
      payloadHash: canonicalPayloadHash(ack) });
    expect(await db.gatewayAutomationProtocolSupport.count()).toBe(0);
    expect(await db.vehicleEventRule.count({ where: { status: "enabled" } })).toBe(0);
  });

  it("accepts equal node-local revisions for two BIO sources and preserves legacy V1 ledger rows", async () => {
    await db.processedGatewayEvent.create({ data: { eventId: "retained-v1", gatewayId: ids.gateway,
      meshNodeId: ids.bluez, scopeKey: ids.bluez, sequence: 2n, eventType: "vehicle_sensor_capability",
      payloadHash: `sha256:${"a".repeat(64)}`, occurredAt: now } });
    const before = await db.processedGatewayEvent.findUnique({ where: { eventId: "retained-v1" } });
    expect((await ingest(report(ids.node))).status).toBe("applied");
    expect((await ingest(report(ids.second))).status).toBe("applied");
    expect(await db.processedGatewayEvent.findUnique({ where: { eventId: "retained-v1" } })).toEqual(before);
    expect(await db.mqttOutbox.count()).toBe(2);
  });

  it("replays the immutable first receipt after later evidence and revives publication only", async () => {
    const value = report();
    const first = await ingest(value);
    const row = await db.mqttOutbox.findFirstOrThrow();
    clockAt = new Date(now.getTime() + 10_000);
    const later = report(ids.node, 3);
    await ingest({ ...later, report: { ...later.report, readiness: "degraded" } });
    await db.mqttOutbox.update({ where: { id: row.id }, data: { publishedAt: now, attempts: 9, deadLetteredAt: now } });
    expect(await ingest(value)).toEqual(first);
    expect(await db.meshNode.findUnique({ where: { id: ids.node } })).toMatchObject({ bioPulseReadiness: "degraded", bioPulseCapabilityRevision: 3n });
    expect(await db.mqttOutbox.findUnique({ where: { id: row.id } })).toMatchObject({ payload: first, publishedAt: null, deadLetteredAt: null, attempts: 0 });
  });

  it("rejects altered payload, event identity and node revision without overwriting prior evidence", async () => {
    const value = report();
    const first = await ingest(value);
    for (const changed of [
      { ...value, report: { ...value.report, readiness: "degraded" } },
      { ...value, report: { ...value.report, meshNodeId: ids.second } },
      { ...value, report: { ...value.report, eventId: randomUUID() } }
    ]) {
      expect(await ingest(changed)).toMatchObject({ status: "rejected", errorCode: "capability_event_conflict" });
    }
    expect(await ingest(value)).toEqual(first);
    expect((await db.meshNode.findUniqueOrThrow({ where: { id: ids.node } })).bioPulseReadiness).toBe("shadow");
  });

  it("ACKs stale evidence without changing the current qualification", async () => {
    await ingest(report(ids.node, 3));
    expect(await ingest(report(ids.node, 2))).toMatchObject({ status: "stale", errorCode: null });
    expect((await db.meshNode.findUniqueOrThrow({ where: { id: ids.node } })).bioPulseCapabilityRevision).toBe(3n);
  });

  it("requires current assignment even for exact committed replay and binds a new assignment into the hash", async () => {
    const value = report();
    await ingest(value);
    const row = await db.mqttOutbox.findFirstOrThrow();
    await db.mqttOutbox.update({ where: { id: row.id }, data: { publishedAt: now } });
    await db.gateway.update({ where: { id: ids.gateway }, data: { assignmentVersion: 3 } });
    await expect(ingest(value)).rejects.toMatchObject({ status: 400 });
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).toEqual(now);
    const reused = { ...value, assignmentVersion: 3 };
    expect(await ingest(reused)).toMatchObject({ status: "rejected", errorCode: "capability_event_conflict" });
    expect(canonicalPayloadHash(reused)).not.toBe(canonicalPayloadHash(value));
    expect((await ingest({ ...report(ids.node, 3), assignmentVersion: 3 })).status).toBe("applied");
  });

  it.each(["expired", "not-yet-valid", "revoked", "disabled-inventory", "unclaimed-gateway", "unclaimed-inventory"])(
    "rejects %s authentication before reviving an existing receipt", async failure => {
      const value = report();
      await ingest(value);
      const row = await db.mqttOutbox.findFirstOrThrow();
      await db.mqttOutbox.update({ where: { id: row.id }, data: { publishedAt: now } });
      if (failure === "expired") await db.gatewayCertificate.update({ where: { id: ids.certificate }, data: { notAfter: now } });
      if (failure === "not-yet-valid") await db.gatewayCertificate.update({ where: { id: ids.certificate }, data: { notBefore: new Date(now.getTime() + 1) } });
      if (failure === "revoked") await db.gatewayCertificate.update({ where: { id: ids.certificate }, data: { revokedAt: now, status: "revoked" } });
      if (failure === "disabled-inventory") await db.gatewayInventory.update({ where: { id: ids.inventory }, data: { disabledAt: now } });
      if (failure === "unclaimed-gateway") await db.gateway.update({ where: { id: ids.gateway }, data: { claimedAt: null } });
      if (failure === "unclaimed-inventory") await db.gatewayInventory.update({ where: { id: ids.inventory }, data: { claimedAt: null } });
      await expect(ingest(value)).rejects.toMatchObject({ status: 400 });
      expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).toEqual(now);
      expect(await db.processedGatewayEvent.count()).toBe(1);
    }
  );

  it("rejects foreign scope, malformed delivery and BlueZ ownership before creating a receipt", async () => {
    for (const [value, auth] of [
      [report(), { ...scope, siteId: randomUUID() }], [report(), { ...scope, requireActiveClaim: false }],
      [report(), undefined], [{ ...report(), extra: true }, scope], [report(ids.bluez), scope]
    ]) {
      // Passing undefined explicitly must not select the default authenticated scope.
      await expect(service.applyBioDelivery(value, auth as never)).rejects.toMatchObject({ status: 400 });
    }
    expect(await db.mqttOutbox.count()).toBe(0);
    expect(await db.processedGatewayEvent.count()).toBe(0);
  });

  it("requires exact MeshNode identity rather than the V1 Fixture alias", async () => {
    const floor = await db.floor.create({ data: { siteId: ids.site, name: "Disposable", level: 1 } });
    const fixture = await db.fixture.create({ data: { floorId: floor.id, siteId: ids.site,
      gatewayId: ids.gateway, meshNodeId: ids.node, name: "Disposable", ratedWatt: 10, x: 0, y: 0 } });
    await expect(ingest(report(fixture.id))).rejects.toMatchObject({ status: 400 });
    expect(await db.mqttOutbox.count()).toBe(0);
    expect(await db.processedGatewayEvent.count()).toBe(0);
  });

  it("fails closed on tampered retained receipt rather than reviving it", async () => {
    const value = report();
    const first = await ingest(value);
    const row = await db.mqttOutbox.findFirstOrThrow();
    for (const payload of [{ ...first, assignmentVersion: 3 }, { ...first, eventId: randomUUID() },
      { ...first, deliveryPayloadHash: `sha256:${"d".repeat(64)}` }]) {
      await db.mqttOutbox.update({ where: { id: row.id }, data: { payload, payloadHash: canonicalPayloadHash(payload), publishedAt: now } });
      await expect(ingest(value)).rejects.toMatchObject({ status: 400 });
      expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).toEqual(now);
    }
    await db.mqttOutbox.update({ where: { id: row.id }, data: { payload: first,
      payloadHash: `sha256:${"e".repeat(64)}`, publishedAt: now } });
    await expect(ingest(value)).rejects.toMatchObject({ status: 400 });
  });

  it("rolls back qualification, ledger and watermark if durable ACK insertion fails", async () => {
    const failed = db.$extends({ query: { mqttOutbox: { create: async () => { throw new Error("test durable ACK unavailable"); } } } });
    const clock = { now: () => now };
    const failing = new VehicleSensorCapabilityService(failed as never, new AutomationSnapshotService(clock as never), clock as never);
    await expect(failing.applyBioDelivery(report(), scope)).rejects.toThrow("test durable ACK unavailable");
    expect((await db.meshNode.findUniqueOrThrow({ where: { id: ids.node } })).bioPulseCapabilityRevision).toBe(0n);
    expect(await db.processedGatewayEvent.count()).toBe(0);
    expect(await db.gatewayEventWatermark.count()).toBe(0);
  });

  it("retains all legacy rows while expanding BIO node-local uniqueness", async () => {
    const url = cluster.database();
    expect(cluster.deploy(url, "99999999", { exclude: [migrationName] }).status).toBe(0);
    const old = new PrismaClient({ datasourceUrl: url });
    try {
      await seed(old);
      const event = { eventId: randomUUID(), gatewayId: ids.gateway, meshNodeId: ids.node, scopeKey: ids.node,
        sequence: 7n, eventType: "bio_pulse_capability", payloadHash: `sha256:${"b".repeat(64)}`, occurredAt: now };
      await old.processedGatewayEvent.create({ data: event });
      const before = await old.processedGatewayEvent.findMany();
      const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
      cluster.sql(url, migration);
      expect(await old.processedGatewayEvent.findMany()).toEqual(before);
      await expect(old.processedGatewayEvent.create({ data: { ...event, eventId: randomUUID(), meshNodeId: ids.second, scopeKey: ids.second } })).resolves.toMatchObject({ meshNodeId: ids.second });
      await expect(old.processedGatewayEvent.create({ data: { ...event, eventId: randomUUID() } })).rejects.toThrow();
      await expect(old.processedGatewayEvent.create({ data: { ...event, eventId: randomUUID(), sequence: 8n, meshNodeId: null } })).rejects.toThrow();
    } finally { await old.$disconnect(); }
  });

  it("fails precisely and rolls back the complete migration for legacy BIO without node attribution", async () => {
    const url = cluster.database();
    expect(cluster.deploy(url, "99999999", { exclude: [migrationName] }).status).toBe(0);
    const old = new PrismaClient({ datasourceUrl: url });
    try {
      await seed(old);
      const eventId = randomUUID();
      await old.processedGatewayEvent.create({ data: { eventId, gatewayId: ids.gateway, sequence: 1n,
        eventType: "bio_pulse_capability", payloadHash: `sha256:${"c".repeat(64)}`, occurredAt: now } });
      const before = await old.processedGatewayEvent.findMany();
      const catalog = () => cluster.sql(url, `SELECT indexdef FROM pg_indexes WHERE tablename='ProcessedGatewayEvent' ORDER BY indexname`);
      const oldIndexes = catalog();
      // Use the actual deployment runner too: it must not mask the actionable
      // preflight identity behind a generic aborted-transaction error.
      const result = cluster.deploy(url);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(eventId);
      expect(result.stderr).toContain("Operator remediation");
      expect(await old.processedGatewayEvent.findMany()).toEqual(before);
      expect(catalog()).toBe(oldIndexes);
    } finally { await old.$disconnect(); }
  });
});

async function seed(db: PrismaClient) {
  // This client belongs only to the self-owned temporary PostgreSQL cluster.
  await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
  await db.organization.create({ data: { id: ids.org, name: "BIO capability disposable" } });
  await db.site.create({ data: { id: ids.site, organizationId: ids.org, name: "Disposable" } });
  await db.gateway.create({ data: { id: ids.gateway, siteId: ids.site, name: "Disposable", serialNumber: "BIO-CAP-TEST",
    firmwareVersion: "test", claimedAt: now, assignmentVersion: 2 } });
  await db.gatewayInventory.create({ data: { id: ids.inventory, serialNumber: "BIO-CAP-TEST", claimedGatewayId: ids.gateway, claimedAt: now } });
  await db.gatewayCertificate.create({ data: { id: ids.certificate, inventoryId: ids.inventory, gatewayId: ids.gateway,
    purpose: "mqtt", certificateSerial: "test-only", fingerprint: "test-only-capability-fingerprint", issuer: "test-only",
    status: "active", notBefore: new Date(now.getTime() - 60_000), notAfter: new Date(now.getTime() + 60_000) } });
  for (const [id, meshAddress, protocol] of [[ids.node, "0100", "bio_usb_pulse"], [ids.second, "0101", "bio_usb_pulse"], [ids.bluez, "0102", "bluez_stateful"]] as const) {
    await db.meshNode.create({ data: { id, gatewayId: ids.gateway, meshAddress, firmwareVersion: "test", vehicleSensorProtocol: protocol } });
  }
}
