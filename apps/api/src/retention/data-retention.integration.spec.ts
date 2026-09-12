import { Logger } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { DataRetentionService } from "./data-retention.service";

const enabled = process.env.DATA_RETENTION_TEST === "1";
const now = new Date("2026-09-12T12:00:00.000Z");
const day = 86_400_000;
const old = new Date(now.getTime() - 400 * day);
const hash = `sha256:${"a".repeat(64)}`;
const ids = { organization: randomUUID(), site: randomUUID(), floor: randomUUID(), gateway: randomUUID(),
  node: randomUUID(), fixture: randomUUID(), user: randomUUID() };
const policies = [
  ["gateway_heartbeat", 7], ["fixture_state", 30], ["provisioning_scan_found", 90],
  ["provisioning_scan_completed", 90], ["provisioning_scan_failed", 90], ["vehicle_sensor_capability", 365]
] as const;

(enabled ? describe : describe.skip)("bounded operational retention on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let peer: PrismaClient;
  let service: DataRetentionService;
  let sequence = 0;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const databaseUrl = cluster.database();
    const deployed = cluster.deploy(databaseUrl);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: `${databaseUrl}?connection_limit=1` });
    peer = new PrismaClient({ datasourceUrl: `${databaseUrl}?connection_limit=1` });
    // Exercise UTC retention against a non-UTC DB session on every host, including CI.
    await db.$executeRawUnsafe("SET TIME ZONE 'Asia/Seoul'");
    await peer.$executeRawUnsafe("SET TIME ZONE 'Asia/Seoul'");
    service = new DataRetentionService(db as never);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
  }, 30_000);
  afterAll(async () => { await db?.$disconnect(); await peer?.$disconnect(); cluster?.stop(); jest.restoreAllMocks(); });
  beforeEach(async () => {
    sequence = 0;
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    await db.organization.create({ data: { id: ids.organization, name: "Retention fixture" } });
    await db.site.create({ data: { id: ids.site, organizationId: ids.organization, name: "Test", tariffKwhRate: "120" } });
    await db.floor.create({ data: { id: ids.floor, siteId: ids.site, name: "B1", level: -1 } });
    await db.user.create({ data: { id: ids.user, organizationId: ids.organization, name: "Test", loginId: "retention", passwordHash: "unused", role: "viewer" } });
    await db.gateway.create({ data: { id: ids.gateway, siteId: ids.site, name: "Gateway", serialNumber: "RETENTION", firmwareVersion: "test",
      lastHeartbeatSequence: 100_000n, lastHeartbeatEventId: "heartbeat-latest", lastHeartbeatOccurredAt: now } });
    await db.meshNode.create({ data: { id: ids.node, gatewayId: ids.gateway, deviceUuid: randomUUID(), meshAddress: "0x1201", firmwareVersion: "test",
      vehicleSensorCapabilityRevision: 100_000n, vehicleSensorCapabilityVerifiedAt: now,
      vehicleSensorCapabilityStatus: "supported", vehicleSensorServerBound: true, vehicleVendorEventModelBound: true } });
    await db.fixture.create({ data: { id: ids.fixture, floorId: ids.floor, meshNodeId: ids.node, name: "L1", ratedWatt: "40", x: 0, y: 0,
      lastStateSequence: 100_000n, lastStateEventId: "fixture-latest", lastStateOccurredAt: now } });
    await db.fixtureEnergyStateCursor.create({ data: { fixtureId: ids.fixture, aggregatedThrough: now, observedStateOccurredAt: now,
      brightness: 50, ratedWatt: "40", durationRemainders: [] } });
    await db.gatewayEventWatermark.createMany({ data: policies.map(([eventType]) => ({ gatewayId: ids.gateway, eventType,
      scopeKey: eventType === "fixture_state" ? ids.fixture : eventType === "vehicle_sensor_capability" ? ids.node : "",
      lastSequence: 100_000n, lastEventId: `${eventType}-latest`, lastPayloadHash: hash, lastOccurredAt: now })) });
  });

  async function event(eventType: string, createdAt = old, overrides: Partial<Prisma.ProcessedGatewayEventUncheckedCreateInput> = {}) {
    const eventId = randomUUID();
    const eventSequence = BigInt(++sequence);
    let scopeKey = eventType === "fixture_state" ? ids.fixture : eventType === "vehicle_sensor_capability" ? ids.node : "";
    if (eventType.startsWith("provisioning_scan_")) {
      const terminal = eventType !== "provisioning_scan_found";
      const session = await db.provisioningSession.create({ data: {
        siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway, requestedBy: ids.user, status: "completed",
        scanStatus: eventType === "provisioning_scan_failed" ? "failed" : "completed", scanCompletedAt: old,
        scanTerminalEventId: terminal ? eventId : randomUUID(), scanTerminalSequence: terminal ? eventSequence : 50_000n,
        scanTerminalEventType: terminal ? eventType : "provisioning_scan_completed",
        scanTerminalPayloadHash: hash, scanTerminalIngestedAt: old
      } });
      scopeKey = session.id;
    }
    return db.processedGatewayEvent.create({ data: { eventId, eventType, gatewayId: ids.gateway, sequence: eventSequence,
      fixtureId: eventType === "fixture_state" ? ids.fixture : null, meshNodeId: eventType === "vehicle_sensor_capability" ? ids.node : null,
      scopeKey, payloadHash: hash, occurredAt: old, createdAt, ...overrides } });
  }

  it.each(policies)("deletes %s only after %i complete days measured by createdAt", async (type, days) => {
    const cutoff = now.getTime() - days * day;
    const expired = await event(type, new Date(cutoff - 1));
    const boundary = await event(type, new Date(cutoff));
    const newer = await event(type, new Date(cutoff + 1));
    expect(await service.prune(now)).toMatchObject({ gatewayEvents: 1 });
    expect(await db.processedGatewayEvent.findMany({ select: { eventId: true } })).toEqual(expect.arrayContaining([
      { eventId: boundary.eventId }, { eventId: newer.eventId }
    ]));
    expect(await db.processedGatewayEvent.findUnique({ where: { eventId: expired.eventId } })).toBeNull();
  });

  it.each(policies)("retains %s legacy rows missing scope or complete hash", async (type) => {
    await event(type, old, { payloadHash: null });
    await event(type, old, { scopeKey: null });
    expect(await service.prune(now)).toMatchObject({ gatewayEvents: 0 });
    expect(await db.processedGatewayEvent.count()).toBe(2);
  });

  it("retains unknown event types even when old and given a watermark", async () => {
    await event("future_event");
    await db.gatewayEventWatermark.create({ data: { gatewayId: ids.gateway, eventType: "future_event", scopeKey: "",
      lastSequence: 100_000n, lastEventId: "future-latest", lastPayloadHash: hash, lastOccurredAt: now } });
    expect(await service.prune(now)).toMatchObject({ gatewayEvents: 0 });
  });

  it.each([
    "missing watermark", "unverified watermark", "behind watermark", "conflicting equal watermark", "behind gateway snapshot"
  ])("retains heartbeat with %s", async (condition) => {
    const row = await event("gateway_heartbeat");
    const where = { gatewayId_eventType_scopeKey: { gatewayId: ids.gateway, eventType: row.eventType, scopeKey: "" } };
    if (condition === "missing watermark") await db.gatewayEventWatermark.delete({ where });
    if (condition === "unverified watermark") await db.gatewayEventWatermark.update({ where, data: { lastPayloadHash: null } });
    if (condition === "behind watermark") {
      await db.gatewayEventWatermark.update({ where, data: { lastSequence: 1n } });
      await db.processedGatewayEvent.update({ where: { eventId: row.eventId }, data: { sequence: 2n } });
    }
    if (condition === "conflicting equal watermark") await db.gatewayEventWatermark.update({ where, data: { lastSequence: row.sequence } });
    if (condition === "behind gateway snapshot") await db.gateway.update({ where: { id: ids.gateway }, data: { lastHeartbeatSequence: 0 } });
    expect(await service.prune(now)).toMatchObject({ gatewayEvents: 0 });
  });

  it.each(["missing cursor", "behind cursor", "behind observed state", "behind snapshot", "missing fixture"])("retains fixture state with %s", async condition => {
    await event("fixture_state");
    const before = new Date(old.getTime() - 1);
    if (condition === "missing cursor") await db.fixtureEnergyStateCursor.deleteMany();
    if (condition === "behind cursor") await db.fixtureEnergyStateCursor.updateMany({ data: { aggregatedThrough: before } });
    if (condition === "behind observed state") await db.fixtureEnergyStateCursor.updateMany({ data: { observedStateOccurredAt: before } });
    if (condition === "behind snapshot") await db.fixture.updateMany({ data: { lastStateSequence: 0 } });
    if (condition === "missing fixture") await db.fixture.deleteMany();
    expect(await service.prune(now)).toMatchObject({ gatewayEvents: 0 });
  });

  it.each(["active session", "unfinished scan", "missing terminal identity", "wrong terminal identity", "wrong gateway"])("retains scan with %s", async condition => {
    const row = await event("provisioning_scan_completed");
    const where = { id: row.scopeKey! };
    if (condition === "active session") await db.provisioningSession.update({ where, data: { status: "active" } });
    if (condition === "unfinished scan") await db.provisioningSession.update({ where, data: { scanStatus: "scanning" } });
    if (condition === "missing terminal identity") await db.provisioningSession.update({ where, data: {
      scanTerminalEventId: null, scanTerminalSequence: null, scanTerminalEventType: null, scanTerminalPayloadHash: null, scanTerminalIngestedAt: null
    } });
    if (condition === "wrong terminal identity") await db.provisioningSession.update({ where, data: { scanTerminalEventId: randomUUID() } });
    if (condition === "wrong gateway") {
      const gateway = await db.gateway.create({ data: { siteId: ids.site, name: "Other", serialNumber: "OTHER", firmwareVersion: "test" } });
      await db.provisioningSession.update({ where, data: { gatewayId: gateway.id } });
    }
    expect(await service.prune(now)).toMatchObject({ gatewayEvents: 0 });
  });

  it("retains found rows if the durable terminal stream watermark is missing", async () => {
    await event("provisioning_scan_found");
    await db.gatewayEventWatermark.deleteMany({ where: { eventType: "provisioning_scan_completed" } });
    expect(await service.prune(now)).toMatchObject({ gatewayEvents: 0 });
  });

  it.each(["node", "watermark"])("keeps latest capability when %s has not superseded it", async source => {
    const row = await event("vehicle_sensor_capability");
    if (source === "node") await db.meshNode.update({ where: { id: ids.node }, data: { vehicleSensorCapabilityRevision: row.sequence } });
    else await db.gatewayEventWatermark.updateMany({ where: { eventType: row.eventType }, data: { lastSequence: row.sequence } });
    expect(await service.prune(now)).toMatchObject({ gatewayEvents: 0 });
  });

  it.each(["gateway_heartbeat", "fixture_state", "provisioning_scan_completed", "provisioning_scan_failed"])(
    "allows the exact current %s identity after its retention horizon", async type => {
      const row = await event(type);
      await db.gatewayEventWatermark.updateMany({ where: { eventType: type }, data: {
        lastSequence: row.sequence, lastEventId: row.eventId, lastPayloadHash: row.payloadHash, lastOccurredAt: row.occurredAt
      } });
      if (type === "gateway_heartbeat") await db.gateway.updateMany({ data: {
        lastHeartbeatSequence: row.sequence, lastHeartbeatEventId: row.eventId, lastHeartbeatOccurredAt: row.occurredAt
      } });
      if (type === "fixture_state") await db.fixture.updateMany({ data: {
        lastStateSequence: row.sequence, lastStateEventId: row.eventId, lastStateOccurredAt: row.occurredAt
      } });
      expect(await service.prune(now)).toMatchObject({ gatewayEvents: 1 });
      expect(await db.gatewayEventWatermark.count()).toBe(6);
      expect(await db.processedGatewayEvent.count()).toBe(0);
    }
  );

  it("deletes expired or revoked sessions after 30 days and preserves active/boundary rows", async () => {
    const cutoff = new Date(now.getTime() - 30 * day);
    const expired = new Date(cutoff.getTime() - 1);
    const future = new Date(now.getTime() + day);
    const rows = [
      { id: "expired", expiresAt: expired }, { id: "revoked", expiresAt: future, revokedAt: expired },
      { id: "active", expiresAt: future }, { id: "expiry-boundary", expiresAt: cutoff },
      { id: "revoked-boundary", expiresAt: future, revokedAt: cutoff }, { id: "recently-expired", expiresAt: now }
    ];
    await db.session.createMany({ data: rows.map(row => ({ ...row, userId: ids.user, tokenHash: row.id })) });
    expect(await service.prune(now)).toMatchObject({ sessions: 2 });
    expect((await db.session.findMany({ orderBy: { id: "asc" } })).map(row => row.id))
      .toEqual(["active", "expiry-boundary", "recently-expired", "revoked-boundary"]);
  });

  async function revisions(floorId: string, count: number) {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "FloorMapRevision" ("id", "floorId", "revision", "snapshot", "snapshotSha256", "changeSummary", "changedBy", "createdAt")
      SELECT ${floorId} || '-' || lpad(value::text, 5, '0'), ${floorId}, value, '{}'::jsonb, ${hash}, '{}'::jsonb, ${ids.user}, ${old}
      FROM generate_series(1, ${count}) value
    `);
  }

  it("keeps the latest 100 revisions per floor or the last 365 days, whichever is wider", async () => {
    await revisions(ids.floor, 105);
    await db.floorMapRevision.updateMany({ where: { floorId: ids.floor, revision: 2 }, data: { createdAt: new Date(now.getTime() - 365 * day) } });
    await db.floorMapRevision.updateMany({ where: { floorId: ids.floor, revision: 3 }, data: { createdAt: now } });
    const second = await db.floor.create({ data: { siteId: ids.site, name: "B2", level: -2 } });
    await revisions(second.id, 100);
    expect(await service.prune(now)).toMatchObject({ floorMapRevisions: 3 });
    const kept = await db.floorMapRevision.findMany({ where: { floorId: ids.floor }, orderBy: { revision: "asc" } });
    expect(kept).toHaveLength(102);
    expect(kept.slice(0, 3).map(row => row.revision)).toEqual([2, 3, 6]);
    expect(await db.floorMapRevision.count({ where: { floorId: second.id } })).toBe(100);
  });

  it("caps each sweep at 10,000 gateway events, 10,000 sessions and 1,000 revisions", async () => {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "ProcessedGatewayEvent" ("eventId", "gatewayId", "sequence", "eventType", "scopeKey", "payloadHash", "occurredAt", "createdAt")
      SELECT 'bounded-event-' || lpad(value::text, 5, '0'), ${ids.gateway}, value, 'gateway_heartbeat', '', ${hash}, ${old}, ${old}
      FROM generate_series(1, 10001) value
    `);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "Session" ("id", "userId", "tokenHash", "expiresAt", "updatedAt")
      SELECT 'bounded-session-' || lpad(value::text, 5, '0'), ${ids.user}, 'token-' || value, ${old}, ${old}
      FROM generate_series(1, 10001) value
    `);
    await revisions(ids.floor, 1101);
    expect(await service.prune(now)).toEqual({ gatewayEvents: 10000, sessions: 10000, floorMapRevisions: 1000 });
    expect((await db.processedGatewayEvent.findMany()).map(row => row.eventId)).toEqual(["bounded-event-10001"]);
    expect((await db.session.findMany()).map(row => row.id)).toEqual(["bounded-session-10001"]);
    expect((await db.floorMapRevision.findMany({ orderBy: { revision: "asc" }, take: 1 }))[0].revision).toBe(1001);
    expect(await service.prune(now)).toEqual({ gatewayEvents: 1, sessions: 1, floorMapRevisions: 1 });
    expect(await service.prune(now)).toEqual({ gatewayEvents: 0, sessions: 0, floorMapRevisions: 0 });
  });

  it("skips rows locked by another connection and converges on the next sweep", async () => {
    const locked = await event("gateway_heartbeat");
    await event("gateway_heartbeat");
    await db.session.createMany({ data: ["locked", "free"].map(id => ({ id, userId: ids.user, tokenHash: id, expiresAt: old })) });
    await revisions(ids.floor, 102);
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const lock = peer.$transaction(async tx => {
      await tx.$queryRaw`SELECT "eventId" FROM "ProcessedGatewayEvent" WHERE "eventId" = ${locked.eventId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = 'locked' FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "FloorMapRevision" WHERE "floorId" = ${ids.floor} AND "revision" = 1 FOR UPDATE`;
      acquired();
      await gate;
    }, { timeout: 10_000 });
    try {
      await Promise.race([ready, lock.then(() => { throw new Error("lock transaction ended before acquiring rows"); })]);
      expect(await service.prune(now)).toEqual({ gatewayEvents: 1, sessions: 1, floorMapRevisions: 1 });
      expect(await db.processedGatewayEvent.findUnique({ where: { eventId: locked.eventId } })).not.toBeNull();
      expect(await db.session.findUnique({ where: { id: "locked" } })).not.toBeNull();
      expect(await db.floorMapRevision.count()).toBe(101);
    } finally { release(); await lock; }
    expect(await service.prune(now)).toEqual({ gatewayEvents: 1, sessions: 1, floorMapRevisions: 1 });
    expect(await db.floorMapRevision.count()).toBe(100);
  }, 15_000);
});
