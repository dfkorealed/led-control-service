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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bioSensorModeCommandSchema } from "@led-control/shared";
// Runtime-only integration imports keep Gateway test dependencies out of API's
// TypeScript emit root; static cross-app imports move dist/src/main.js.
const { CommandJournal } = require("../../gateway/src/commands/command-journal");
const { StateEventOutbox } = require("../../gateway/src/state/state-event-outbox");
const { handleBioSensorMode } = require("../../gateway/src/commands/bio-sensor-mode-handler");

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
  it.each([-60_000, 60_000].flatMap((offset) => [false, true].map((restart) => ({ offset, restart }))))(
    "ACKs a real Gateway failure with clock offset $offset and restart=$restart without verifying", async ({ offset, restart }) => {
    const created = await service.create(user, request());
    const row = await prisma.sensorModeOperation.findUniqueOrThrow({ where: { commandId: created.commandId } });
    const command = bioSensorModeCommandSchema.parse(row.payload);
    const dir = await mkdtemp(join(tmpdir(), "bio-mode-api-clock-"));
    try {
      const outbox = new StateEventOutbox(join(dir, "outbox.json"), command);
      const adapter = { sensorModeOperation: jest.fn() };
      const journal = new CommandJournal(join(dir, "journal.json"));
      if (restart) await journal.accept(command.commandId, { kind: "bio_sensor_mode", command });
      await handleBioSensorMode(adapter, command, { journal, outbox,
        scope: command, now: () => new Date(row.requestedAt.getTime() + offset), nextSequence: async () => 1 });
      const [event] = await outbox.pending();
      expect(event.payload).toMatchObject({ status: restart ? "unknown" : "timed_out", modeVerified: false,
        errorCode: restart ? "GATEWAY_RESTART" : "COMMAND_EXPIRED" });
      expect(adapter.sensorModeOperation).not.toHaveBeenCalled();
      // Relaxing failure time proof must not relax command identity or success proof.
      await expect(service.ingest(event.topic, { ...event.payload, deviceIdentityHash: "f".repeat(64) })).rejects.toThrow("identity");
      const { errorCode: _error, ...envelope } = event.payload as Record<string, unknown>;
      await expect(service.ingest(event.topic, { ...envelope, status: "verified", modeVerified: true,
        observedMode: "sensor", evidence: "mode_get" })).rejects.toThrow("time");
      const ack = await service.ingest(event.topic, event.payload);
      expect(ack.status).toBe("ingested");
      expect(await service.get(user, created.commandId)).toMatchObject({ status: restart ? "unknown" : "timed_out", modeVerified: false, verifiedAt: null });
      expect((await service.ingest(event.topic, event.payload)).status).toBe("duplicate");
      await outbox.acknowledge({ ...ack, ingestedAt: new Date().toISOString() });
      expect(await outbox.pending()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  async function result(commandId: string, changes: Record<string, unknown> = {}) {
    const row = await prisma.sensorModeOperation.findUniqueOrThrow({ where: { commandId } });
    const { requestedAt: _requestedAt, expiresAt: _expiresAt, ...identity } = row.payload as Record<string, unknown>;
    return { ...identity, eventId: randomUUID(), sequence: 1, occurredAt: new Date().toISOString(), status: "verified", modeVerified: true,
      observedMode: "sensor", evidence: "mode_get", ...changes };
  }
  it.each([
    { reason: "before request", offset: -1, receivedOffset: 1_000 },
    { reason: "future versus server receipt", offset: 5_000, receivedOffset: 1_000 },
    { reason: "after command expiry", offset: 30_001, receivedOffset: 32_000 }
  ])("still rejects verified GET $reason", async ({ offset, receivedOffset }) => {
    const created = await service.create(user, request());
    const start = Date.parse(created.requestedAt);
    await expect(service.ingest(bioSensorModeTopics.result(siteId, gatewayId),
      await result(created.commandId, { occurredAt: new Date(start + offset).toISOString() }),
      new Date(start + receivedOffset))).rejects.toThrow("time");
    const row = await prisma.sensorModeOperation.findUniqueOrThrow({ where: { commandId: created.commandId } });
    expect(row).toMatchObject({ status: "pending", result: null, resultHash: null });
  });
  it.each([-60_000, 60_000].flatMap((offset) => [
    { status: "mismatch", observedMode: "force-on", evidence: "mode_get" },
    { status: "mismatch", observedMode: "force-off", evidence: "mode_get" },
    { status: "unknown", errorCode: "GATEWAY_CLOCK_UNTRUSTED" },
    { status: "unknown", errorCode: "GATEWAY_SHUTDOWN" },
    { status: "unknown", errorCode: "UNSUPPORTED_ADAPTER" },
    { status: "unknown", errorCode: "MODE_GET_UNCONFIRMED" },
    { status: "timed_out", errorCode: "MODE_GET_UNCONFIRMED" }
  ].map((detail) => ({ offset, detail }))))("keeps $detail at offset $offset as unverified audit only", async ({ offset, detail }) => {
    const created = await service.create(user, request());
    const success = await result(created.commandId);
    const { observedMode: _mode, evidence: _proof, ...envelope } = success;
    const event = { ...envelope, ...detail, modeVerified: false,
      occurredAt: new Date(Date.parse(created.requestedAt) + offset).toISOString() };
    const topic = bioSensorModeTopics.result(siteId, gatewayId);
    await expect(service.ingest(topic, { ...event, assignmentVersion: 2 })).rejects.toThrow("identity");
    await expect(service.ingest(bioSensorModeTopics.result(siteId, randomUUID()), event)).rejects.toThrow("scope");
    expect((await service.ingest(topic, event)).status).toBe("ingested");
    expect(await service.get(user, created.commandId)).toMatchObject({ modeVerified: false, verifiedAt: null });
    expect((await prisma.sensorModeOperation.findUniqueOrThrow({ where: { commandId: created.commandId } })).result).toEqual(event);
    expect((await service.ingest(topic, event)).status).toBe("duplicate");
    await expect(service.ingest(topic, { ...event, sequence: 2 })).rejects.toThrow("conflict");
  });
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
