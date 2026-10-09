import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { MqttService } from "../src/mqtt/mqtt.service";
import { RegistrationService } from "../src/registration/registration.service";
import { disposablePostgres } from "./support/disposable-postgres";

const enabled = process.env.BIO_DISCOVERY_TEST === "1";
const ids = { organization: randomUUID(), site: randomUUID(), floor: randomUUID(), gateway: randomUUID(),
  user: randomUUID(), session: randomUUID(), correlation: randomUUID() };
const fingerprint = { deviceType: 1, firmware: { major: 2, minor: 3, revision: 4, build: 513 },
  sensorType: 5, infraredType: 6, ambientLightType: 7, hardwareType: 8 };
const event = () => ({ schemaVersion: 2, fingerprint, sessionId: ids.session, scanCorrelationId: ids.correlation,
  scanAttempt: 1, siteId: ids.site, gatewayId: ids.gateway, eventId: randomUUID(), sequence: 10,
  occurredAt: "2026-10-08T00:00:00.000Z", deviceUuid: "bio:001122334455", serialNumber: "BIO-1",
  rssi: -45, oobCapability: "none", firmwareVersion: "2.3.4.513" });
const topic = (suffix = "scan-found-v2") => `sites/${ids.site}/gateways/${ids.gateway}/events/provisioning/${suffix}`;

(enabled ? describe : describe.skip)("BIO discovery on self-owned disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let mqtt: MqttService;
  const observed = () => db.discoveredMeshNode.findFirst();
  const send = (value: unknown, target = topic()) => mqtt.handleMessage(target, Buffer.from(JSON.stringify(value)));
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployment = cluster.deploy(url);
    expect(deployment.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    mqtt = new MqttService(db as never, { attachProvisionedNode: async () => undefined } as never);
  }, 30_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    await db.organization.create({ data: { id: ids.organization, name: "Discovery test", type: "customer" } });
    await db.site.create({ data: { id: ids.site, organizationId: ids.organization, name: "Test" } });
    await db.floor.create({ data: { id: ids.floor, siteId: ids.site, name: "B1", level: -1 } });
    await db.gateway.create({ data: { id: ids.gateway, siteId: ids.site, name: "Gateway", serialNumber: "DISCOVERY-GW", firmwareVersion: "test" } });
    await db.user.create({ data: { id: ids.user, organizationId: ids.organization, name: "Admin", loginId: "discovery-test", passwordHash: "unused", role: "admin" } });
    await db.provisioningSession.create({ data: { id: ids.session, siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway,
      requestedBy: ids.user, scanStatus: "scanning", scanAttempt: 1, scanCorrelationId: ids.correlation } });
  });

  it("adds a nullable SQL observation without a default or existing-row synthesis", async () => {
    const columns = await db.$queryRaw<Array<{ is_nullable: string; column_default: string | null }>>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'DiscoveredMeshNode' AND column_name = 'bioDiscoveryFingerprint'`;
    expect(columns).toEqual([{ is_nullable: "YES", column_default: null }]);
  });
  it("forward-migrates an existing legacy row to SQL null without altering metadata", async () => {
    const legacyUrl = cluster.database();
    expect(cluster.deploy(legacyUrl, "20261008049999").status).toBe(0);
    cluster.sql(legacyUrl, `
      INSERT INTO "Organization" (id, name, "updatedAt") VALUES ('org', 'Legacy', now());
      INSERT INTO "User" (id, "organizationId", "loginId", name, "passwordHash", role, "updatedAt")
        VALUES ('user', 'org', 'legacy', 'Legacy', 'unused', 'admin', now());
      INSERT INTO "Site" (id, "organizationId", name, "updatedAt") VALUES ('site', 'org', 'Legacy', now());
      INSERT INTO "Floor" (id, "siteId", name, level, "updatedAt") VALUES ('floor', 'site', 'B1', -1, now());
      INSERT INTO "Gateway" (id, "siteId", name, "serialNumber", "firmwareVersion", "updatedAt")
        VALUES ('gateway', 'site', 'Legacy', 'legacy-gw', 'test', now());
      INSERT INTO "ProvisioningSession" (id, "siteId", "floorId", "gatewayId", "requestedBy", "updatedAt")
        VALUES ('session', 'site', 'floor', 'gateway', 'user', now());
      INSERT INTO "DiscoveredMeshNode" (id, "sessionId", "deviceUuid", "serialNumber", rssi, "oobCapability", "firmwareVersion", "updatedAt")
        VALUES ('node', 'session', 'legacy-node', 'legacy-serial', -45, 'none', '2.3.4.513', now());`);
    expect(cluster.deploy(legacyUrl).status).toBe(0);
    expect(cluster.sql(legacyUrl, `SELECT "deviceUuid" || ':' || "firmwareVersion" || ':' ||
      ("bioDiscoveryFingerprint" IS NULL)::text FROM "DiscoveredMeshNode"`)).toBe("legacy-node:2.3.4.513:true");
  }, 30_000);
  it("stores accepted typed observation with existing scan identity and ledger hash", async () => {
    const value = event();
    await send(value);
    expect(await observed()).toMatchObject({ bioDiscoveryFingerprint: fingerprint,
      scanCorrelationId: ids.correlation, scanAttempt: 1, status: "discovered" });
    expect(await db.processedGatewayEvent.findFirst()).toMatchObject({ eventId: value.eventId,
      eventType: "provisioning_scan_found", scopeKey: ids.session });
    expect(await db.bioSensorPreparationOperation.count()).toBe(0);
    expect(await db.meshNode.count()).toBe(0);
  });
  it.each([
    ["correlation", { scanCorrelationId: randomUUID() }], ["attempt", { scanAttempt: 2 }],
    ["session", { sessionId: randomUUID() }], ["site", { siteId: randomUUID() }],
    ["gateway", { gatewayId: randomUUID() }]
  ])("rejects another %s before persisting observation or ledger", async (_name, change) => {
    await send({ ...event(), ...(change as object) });
    expect(await observed()).toBeNull();
    expect(await db.processedGatewayEvent.count()).toBe(0);
  });
  it("rejects a topic scope mismatch", async () => {
    await send(event(), `sites/${randomUUID()}/gateways/${ids.gateway}/events/provisioning/scan-found-v2`);
    expect(await observed()).toBeNull();
  });
  it.each(["completed", "failed", "pending"] as const)("rejects late discovery while scan is %s", async scanStatus => {
    await db.provisioningSession.update({ where: { id: ids.session }, data: { scanStatus } });
    await send(event());
    expect(await observed()).toBeNull();
    expect(await db.processedGatewayEvent.count()).toBe(0);
  });
  it.each(["completed", "cancelled"] as const)("rejects discovery for a %s registration session", async status => {
    await db.provisioningSession.update({ where: { id: ids.session }, data: { status } });
    await send(event());
    expect(await observed()).toBeNull();
    expect(await db.processedGatewayEvent.count()).toBe(0);
  });
  it("rejects altered duplicate, lower sequence and retained-watermark replay", async () => {
    const value = event();
    await send(value);
    const before = await observed();
    await send({ ...value, fingerprint: { ...fingerprint, sensorType: 9 } });
    await send({ ...value, eventId: randomUUID(), sequence: 9, fingerprint: null });
    const { schemaVersion: _version, fingerprint: _fingerprint, ...legacy } = value;
    await send({ ...legacy, eventId: randomUUID(), sequence: 9 }, topic("scan-found"));
    await db.processedGatewayEvent.deleteMany();
    await send({ ...value, eventId: randomUUID(), fingerprint: null });
    await send({ ...legacy, eventId: randomUUID() }, topic("scan-found"));
    expect(await observed()).toEqual(before);
    expect(before).toMatchObject({ bioDiscoveryFingerprint: fingerprint });
  });
  it("refreshes accepted observation and clears it for a newer null or legacy observation", async () => {
    await send(event());
    const newer = { ...event(), eventId: randomUUID(), sequence: 11, fingerprint: { ...fingerprint, sensorType: 9 } };
    await send(newer);
    expect(await observed()).toMatchObject({ bioDiscoveryFingerprint: { ...fingerprint, sensorType: 9 } });
    await send({ ...newer, eventId: randomUUID(), sequence: 12, fingerprint: null });
    expect(await observed()).toMatchObject({ bioDiscoveryFingerprint: null });
    await send({ ...event(), eventId: randomUUID(), sequence: 13 });
    const { schemaVersion: _version, fingerprint: _fingerprint, ...legacy } = event();
    await send({ ...legacy, sequence: 14 }, topic("scan-found"));
    expect(await observed()).toMatchObject({ bioDiscoveryFingerprint: null });
  });
  it("keeps legacy firmware text observation null and strict", async () => {
    const { schemaVersion: _version, fingerprint: _fingerprint, ...legacy } = event();
    await send(legacy, topic("scan-found"));
    expect(await observed()).toMatchObject({ bioDiscoveryFingerprint: null });
    await expect(send({ ...legacy, fingerprint }, topic("scan-found"))).rejects.toThrow();
  });
  it.each([{ schemaVersion: 1 }, { fingerprint: { ...fingerprint, deviceType: 256 } },
    { fingerprint: { ...fingerprint, firmware: { ...fingerprint.firmware, build: 65536 } } },
    { fingerprint: undefined }, { ready: true }])("rejects malformed typed payload %j", async change => {
    await expect(send({ ...event(), ...change })).rejects.toThrow();
    expect(await observed()).toBeNull();
    expect(await db.processedGatewayEvent.count()).toBe(0);
  });
  it("preserves observation through confirmed registration and redacts HTTP session nodes", async () => {
    await send(event());
    const node = await db.discoveredMeshNode.findFirstOrThrow();
    await db.provisioningSession.update({ where: { id: ids.session }, data: { scanStatus: "completed" } });
    await db.discoveredMeshNode.update({ where: { id: node.id }, data: {
      status: "provisioning", meshAddress: "0x0100", pendingFixtureName: "L01", pendingFixtureX: 1, pendingFixtureY: 2
    } });
    await mqtt.handleMessage(`sites/${ids.site}/gateways/${ids.gateway}/events/provisioning-completed`,
      Buffer.from(JSON.stringify({ sessionId: ids.session, nodeId: node.id, deviceUuid: node.deviceUuid,
        meshAddress: "0x0100", completedAt: "2026-10-08T00:00:01.000Z" })));
    expect(await observed()).toMatchObject({ status: "provisioned", bioDiscoveryFingerprint: fingerprint });
    const service = new RegistrationService(db as never, mqtt, { assert: async () => undefined } as never, {} as never, {} as never);
    const response = await service.getSession({ id: ids.user, role: "admin", status: "active", organizationType: "customer" } as never, ids.session);
    expect(response.discoveredNodes[0]).not.toHaveProperty("bioDiscoveryFingerprint");
    expect(JSON.stringify(response)).not.toContain('"sensorType"');
    expect((await db.meshNode.findFirstOrThrow()).vehicleSensorCapabilityStatus).toBe("unknown");
  });
});
