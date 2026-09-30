import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "./support/disposable-postgres";
import { SensorModeOperationsService } from "../src/commands/sensor-mode-operations.service";
import { SiteAccessService } from "../src/access/site-access.service";
import { AutomationSnapshotService } from "../src/automation/automation-snapshot.service";
import { AutomationClock } from "../src/automation/automation-clock";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuthenticatedUser } from "../src/auth/auth.types";
import { bioSensorModeTopics } from "@led-control/shared";
import { SensorModePublisherService } from "../src/mqtt/sensor-mode-publisher.service";
import { MqttService } from "../src/mqtt/mqtt.service";

(process.env.BIO_SENSOR_MODE_DISPOSABLE_POSTGRES === "1" ? describe : describe.skip)("sensor mode durable operation on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let prisma: PrismaClient;
  let service: SensorModeOperationsService;
  let user: AuthenticatedUser;
  let siteId: string; let gatewayId: string; let fixtureId: string;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database(); const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(deployed.stderr + deployed.stdout);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as PrismaService;
    service = new SensorModeOperationsService(db, new SiteAccessService(db), new AutomationSnapshotService(new AutomationClock()));
  }, 60_000);
  afterAll(async () => { await prisma?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    await service.expire(new Date(Date.now() + 60_000));
    const id = randomUUID();
    const org = await prisma.organization.create({ data: { name: id, type: "customer" } });
    const actor = await prisma.user.create({ data: { organizationId: org.id, loginId: id, email: `${id}@test.local`, name: "Admin", passwordHash: "unused", role: "admin" } });
    user = { ...actor, organizationType: "customer" } as unknown as AuthenticatedUser;
    siteId = (await prisma.site.create({ data: { name: id, organizationId: org.id, adminUserId: actor.id } })).id;
    const floor = await prisma.floor.create({ data: { siteId, name: "B1", level: -1 } });
    gatewayId = (await prisma.gateway.create({ data: { siteId, name: id, serialNumber: id, firmwareVersion: "test", assignmentVersion: 1 } })).id;
    const inventory = await prisma.gatewayInventory.create({ data: { serialNumber: `inv-${id}`, claimedGatewayId: gatewayId, claimedAt: new Date() } });
    await prisma.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId, purpose: "mqtt", status: "active", certificateSerial: id,
      fingerprint: id, issuer: "synthetic", notBefore: new Date(), notAfter: new Date(Date.now() + 60_000) } });
    const node = await prisma.meshNode.create({ data: { gatewayId, meshAddress: "0x0001", firmwareVersion: "test", deviceUuid: `bio:${id.replaceAll("-", "").slice(0, 12)}`, vehicleSensorProtocol: "bio_usb_pulse" } });
    fixtureId = (await prisma.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "A", ratedWatt: 20, x: 0, y: 0 } })).id;
  });
  const request = () => ({ siteId, fixtureId, clientRequestId: randomUUID(), operation: "ensure_sensor" as const });
  async function result(commandId: string, changes: Record<string, unknown> = {}) {
    const row = await prisma.sensorModeOperation.findUniqueOrThrow({ where: { commandId } });
    const { requestedAt: _requestedAt, expiresAt: _expiresAt, ...identity } = row.payload as Record<string, unknown>;
    return { ...identity, eventId: randomUUID(), sequence: 1, occurredAt: new Date().toISOString(), status: "verified", modeVerified: true,
      observedMode: "sensor", evidence: "mode_get", ...changes };
  }
  it("persists one command per request and never treats publish acceptance as mode verification", async () => {
    const input = request(); const created = await service.create(user, input);
    expect(await service.create(user, input)).toEqual(created);
    expect(created).toMatchObject({ status: "pending", modeVerified: false });
    const row = await prisma.sensorModeOperation.findUniqueOrThrow({ where: { commandId: created.commandId } });
    expect(row.payload).toMatchObject({ operation: "ensure_sensor", fixtureId });
    await prisma.sensorModeOperation.update({ where: { commandId: created.commandId }, data: { publishedAt: new Date() } });
    expect(await service.get(user, created.commandId)).toMatchObject({ status: "pending", modeVerified: false });
    await expect(service.create(user, { ...input, operation: "query" })).rejects.toThrow();
  });
  it("retries the same outbox identity and expires silence without success", async () => {
    const created = await service.create(user, request());
    const sent: Array<{ topic: string; payload: unknown }> = [];
    const mqtt = { publishTopic: async (topic: string, payload: unknown) => { sent.push({ topic, payload }); } } as unknown as MqttService;
    const publisher = new SensorModePublisherService(prisma as PrismaService, mqtt, service, new AutomationSnapshotService(new AutomationClock()));
    await publisher.processBatch();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ topic: bioSensorModeTopics.command(siteId, gatewayId), payload: { commandId: created.commandId } });
    expect((await service.get(user, created.commandId)).modeVerified).toBe(false);
    await prisma.sensorModeOperation.update({ where: { commandId: created.commandId }, data: { nextAttemptAt: new Date(0) } });
    await publisher.processBatch();
    expect(sent[1]).toEqual(sent[0]);
    await service.expire(new Date(Date.now() + 60_000));
    await publisher.processBatch();
    expect(sent).toHaveLength(2);
  });
  it("records only matched mode GET and leaves capability, high-brightness and optical state unchanged", async () => {
    const created = await service.create(user, request());
    const before = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId }, include: { meshNode: true } });
    const event = await result(created.commandId);
    await service.ingest(bioSensorModeTopics.result(siteId, gatewayId), event);
    expect(await service.get(user, created.commandId)).toMatchObject({ status: "verified", modeVerified: true });
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId }, include: { meshNode: true } })).toEqual(before);
    expect((await service.ingest(bioSensorModeTopics.result(siteId, gatewayId), event)).status).toBe("duplicate");
  });
  it("times out durably and a new query never reuses old success", async () => {
    const created = await service.create(user, request());
    await service.expire(new Date(Date.now() + 60_000));
    await service.ingest(bioSensorModeTopics.result(siteId, gatewayId), await result(created.commandId));
    expect(await service.get(user, created.commandId)).toMatchObject({ status: "timed_out", modeVerified: false });
    const queried = await service.create(user, { ...request(), operation: "query", requeryOfCommandId: created.commandId });
    expect(queried.commandId).not.toBe(created.commandId);
    expect(queried.modeVerified).toBe(false);
    await service.ingest(bioSensorModeTopics.result(siteId, gatewayId), await result(queried.commandId));
    expect(await service.get(user, queried.commandId)).toMatchObject({ modeVerified: true });
  });
  it("rejects another gateway, stale assignment, and events before the request", async () => {
    const created = await service.create(user, request());
    const event = await result(created.commandId);
    await expect(service.ingest(bioSensorModeTopics.result(siteId, randomUUID()), event)).rejects.toThrow();
    await expect(service.ingest(bioSensorModeTopics.result(siteId, gatewayId), { ...event, occurredAt: "2020-01-01T00:00:00.000Z" })).rejects.toThrow();
    await prisma.gateway.update({ where: { id: gatewayId }, data: { assignmentVersion: { increment: 1 } } });
    expect((await service.ingest(bioSensorModeTopics.result(siteId, gatewayId), event)).status).toBe("stale_checkpoint");
    expect((await service.get(user, created.commandId)).modeVerified).toBe(false);
  });
  it("superseded results cannot verify and callers need site control permission", async () => {
    const created = await service.create(user, request());
    await service.create(user, { ...request(), operation: "query", requeryOfCommandId: created.commandId });
    await service.ingest(bioSensorModeTopics.result(siteId, gatewayId), await result(created.commandId));
    expect((await service.get(user, created.commandId)).modeVerified).toBe(false);
    await expect(service.create({ ...user, id: randomUUID() }, request())).rejects.toThrow();
  });
  it("rejects forged verification in the database and contradictory duplicate events", async () => {
    const created = await service.create(user, request());
    await expect(prisma.sensorModeOperation.update({ where: { commandId: created.commandId }, data: { status: "verified", result: {} } })).rejects.toThrow();
    const event = await result(created.commandId);
    await service.ingest(bioSensorModeTopics.result(siteId, gatewayId), event);
    await expect(service.ingest(bioSensorModeTopics.result(siteId, gatewayId), { ...event, sequence: 2 })).rejects.toThrow("conflict");
  });
  it("does not verify a device replaced in the same node/address", async () => {
    const created = await service.create(user, request());
    const event = await result(created.commandId);
    const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
    await prisma.meshNode.update({ where: { id: fixture.meshNodeId! }, data: { deviceUuid: "bio:000000000001" } });
    expect((await service.ingest(bioSensorModeTopics.result(siteId, gatewayId), event)).status).toBe("stale_checkpoint");
    expect((await service.get(user, created.commandId)).modeVerified).toBe(false);
  });
});
