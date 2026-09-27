import { Logger } from "@nestjs/common";
import { threeCalendarMonthsBefore } from "./calendar-month-window";
import { Test } from "@nestjs/testing";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { DataRetentionService } from "./data-retention.service";
import { recordCommandOutcomeActivity } from "../monitoring-activity/command-outcome-activity";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { RetentionModule } from "./retention.module";

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
  let databaseUrl: string;
  let sequence = 0;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
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
  afterEach(() => {
    delete process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED;
    delete process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION;
    delete process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
  });
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

  it("backfills a still-visible raw Command activity key without changing its recordedAt or retention window", async () => {
    process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "1";
    process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
    process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({
      1: randomBytes(32).toString("base64url") });
    const commandId = randomUUID();
    const recordedAt = new Date("2026-09-11T12:00:00.000Z");
    const activity = await db.monitoringActivity.create({ data: {
      siteId: ids.site, floorId: ids.floor, sourceType: "command",
      sourceKey: `${commandId}:unknown`, kind: "command_result",
      commandOutcome: "unknown", recordedAt
    } });
    await service.prune(now);
    const rekeyed = await db.monitoringActivity.findUniqueOrThrow({ where: { id: activity.id } });
    expect(rekeyed).toMatchObject({ recordedAt, sourceKey: expect.stringMatching(/^v1:hmac-sha256:[a-f0-9]{64}$/) });
    expect(rekeyed.sourceKey).not.toContain(commandId);
  });

  it("leaves legacy Command activity untouched when keyed-source backfill is disabled", async () => {
    const commandId = randomUUID();
    const activity = await db.monitoringActivity.create({ data: {
      siteId: ids.site, floorId: ids.floor, sourceType: "command",
      sourceKey: `${commandId}:unknown`, kind: "command_result",
      commandOutcome: "unknown", recordedAt: new Date("2026-09-11T12:00:00.000Z")
    } });
    await service.prune(now);
    expect(await db.monitoringActivity.findUniqueOrThrow({ where: { id: activity.id } }))
      .toMatchObject({ sourceKey: `${commandId}:unknown` });
  });

  it("rekeys no more than 100 legacy Command sources per sweep and converges on repetition", async () => {
    process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "1";
    process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
    process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({ 1: randomBytes(32).toString("base64url") });
    const sources = Array.from({ length: 101 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}:unknown`);
    await db.monitoringActivity.createMany({ data: sources.map(sourceKey => ({
      siteId: ids.site, floorId: ids.floor, sourceType: "command", sourceKey,
      kind: "command_result", commandOutcome: "unknown",
      recordedAt: new Date("2026-09-11T12:00:00.000Z")
    })) });
    await service.prune(now);
    const first = await db.monitoringActivity.findMany({ select: { sourceKey: true } });
    expect(first.filter(row => row.sourceKey.endsWith(":unknown"))).toHaveLength(1);
    expect(first.filter(row => row.sourceKey.startsWith("v1:hmac-sha256:"))).toHaveLength(100);
    await service.prune(now);
    const second = await db.monitoringActivity.findMany({ select: { sourceKey: true } });
    expect(second).toHaveLength(101);
    expect(second.every(row => /^v1:hmac-sha256:[a-f0-9]{64}$/.test(row.sourceKey))).toBe(true);
    await service.prune(now);
    expect(await db.monitoringActivity.count()).toBe(101);
  });

  it("deletes only pre-cutoff Command activity and rekeys the exact UTC calendar-month boundary", async () => {
    process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "1";
    process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
    process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({ 1: randomBytes(32).toString("base64url") });
    const boundary = new Date("2026-02-28T12:00:00.000Z");
    const rows = await Promise.all([-1, 0, 1].map(offset => db.monitoringActivity.create({ data: {
      siteId: ids.site, floorId: ids.floor, sourceType: "command",
      sourceKey: `${randomUUID()}:unknown`, kind: "command_result", commandOutcome: "unknown",
      recordedAt: new Date(boundary.getTime() + offset)
    } })));
    expect(await service.prune(new Date("2026-05-31T12:00:00.000Z")))
      .toMatchObject({ monitoringActivities: 1 });
    expect(await db.monitoringActivity.findUnique({ where: { id: rows[0].id } })).toBeNull();
    for (const row of rows.slice(1)) {
      expect(await db.monitoringActivity.findUniqueOrThrow({ where: { id: row.id } }))
        .toMatchObject({ recordedAt: row.recordedAt,
          sourceKey: expect.stringMatching(/^v1:hmac-sha256:[a-f0-9]{64}$/) });
    }
  });

  it("reserves the backfill page for visible rows while the physical deletion backlog drains", async () => {
    process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "1";
    process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
    process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({ 1: randomBytes(32).toString("base64url") });
    const expiredAt = new Date("2026-02-28T11:59:59.999Z");
    const retainedFrom = new Date("2026-02-28T12:00:00.000Z");
    await db.monitoringActivity.createMany({ data: Array.from({ length: 1001 }, (_, index) => ({
      siteId: ids.site, floorId: ids.floor, sourceType: "command",
      sourceKey: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}:unknown`,
      kind: "command_result" as const, commandOutcome: "unknown" as const,
      recordedAt: expiredAt
    })) });
    const visible = await db.monitoringActivity.create({ data: {
      siteId: ids.site, floorId: ids.floor, sourceType: "command",
      sourceKey: "ffffffff-ffff-4fff-8fff-ffffffffffff:unknown",
      kind: "command_result", commandOutcome: "unknown", recordedAt: retainedFrom
    } });
    expect(await service.prune(new Date("2026-05-31T12:00:00.000Z")))
      .toMatchObject({ monitoringActivities: 1000 });
    expect(await db.monitoringActivity.count({ where: { recordedAt: expiredAt } })).toBe(1);
    expect(await db.monitoringActivity.count({ where: { recordedAt: expiredAt,
      sourceKey: { startsWith: "v1:hmac-sha256:" } } })).toBe(0);
    expect((await db.monitoringActivity.findUniqueOrThrow({ where: { id: visible.id } })).sourceKey)
      .toMatch(/^v1:hmac-sha256:[a-f0-9]{64}$/);
  });

  it("fails closed without an HMAC key and leaves surviving raw Command activity intact", async () => {
    process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "1";
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const sourceKey = `${randomUUID()}:unknown`;
    const activity = await db.monitoringActivity.create({ data: {
      siteId: ids.site, floorId: ids.floor, sourceType: "command", sourceKey,
      kind: "command_result", commandOutcome: "unknown",
      recordedAt: new Date("2026-09-11T12:00:00.000Z")
    } });
    try {
      await expect(service.prune(now)).rejects.toThrow("command safety HMAC key unavailable");
      expect(await db.monitoringActivity.findUniqueOrThrow({ where: { id: activity.id } }))
        .toMatchObject({ sourceKey });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        failedStage: "commandActivitySourceBackfill", rekeyedCommandActivitySources: 0
      }));
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sourceKey);
    } finally {
      warn.mockRestore();
    }
  });

  it("merges a concurrent keyed producer with the backfill without a duplicate activity", async () => {
    process.env.MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED = "1";
    process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
    process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({ 1: randomBytes(32).toString("base64url") });
    const command = await db.command.create({ data: {
      siteId: ids.site, clientRequestId: randomUUID(), requestFingerprint: "retention-concurrency",
      targetType: "fixture", targetFixtureIds: [ids.fixture], brightness: 70,
      status: "pending", outcome: "pending"
    } });
    const recordedAt = new Date("2026-09-11T12:00:00.000Z");
    const legacy = await db.monitoringActivity.create({ data: {
      siteId: ids.site, floorId: ids.floor, sourceType: "command",
      sourceKey: `${command.id}:unknown`, kind: "command_result",
      commandOutcome: "unknown", recordedAt
    } });
    let sweep!: ReturnType<DataRetentionService["prune"]>;
    await peer.$transaction(async tx => {
      expect((await tx.command.updateMany({ where: { id: command.id, outcome: "pending" },
        data: { status: "failed", outcome: "unknown" } })).count).toBe(1);
      await recordCommandOutcomeActivity(tx, command.id, "pending", "unknown");
      sweep = service.prune(now);
      let waiting = false;
      for (let attempt = 0; attempt < 150 && !waiting; attempt += 1) {
        const locks = await tx.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS "count" FROM pg_locks
          WHERE locktype = 'advisory' AND granted = false`;
        waiting = locks[0]?.count === 1;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
    }, { timeout: 15_000 });
    await sweep;
    const activities = await db.monitoringActivity.findMany({ where: {
      siteId: ids.site, sourceType: "command", commandOutcome: "unknown"
    } });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ id: legacy.id, recordedAt,
      sourceKey: expect.stringMatching(/^v1:hmac-sha256:[a-f0-9]{64}$/) });
  });

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

  async function refresh(status: "pending" | "completed" | "partial" | "failed" | "expired", completedAt: Date | null) {
    const terminal = status !== "pending";
    const row = await db.monitoringRefresh.create({ data: {
      siteId: ids.site, floorId: ids.floor, requestedById: ids.user, clientRequestId: randomUUID(),
      status, totalFixtures: 1, onlineFixtures: terminal ? 1 : 0,
      createdAt: old, deadlineAt: new Date(old.getTime() + 30_000), completedAt
    } });
    const batch = await db.monitoringRefreshBatch.create({ data: {
      refreshId: row.id, siteId: ids.site, gatewayId: ids.gateway, sequence: ++sequence,
      idempotencyKey: randomUUID(), targetFixtureIds: [ids.fixture],
      status: terminal ? "completed" : "pending", publishedAt: completedAt, completedAt
    } });
    await db.monitoringRefreshFixture.create({ data: {
      refreshId: row.id, siteId: ids.site, fixtureId: ids.fixture, batchId: batch.id,
      status: terminal ? "online" : "pending", observedAt: completedAt
    } });
    await db.monitoringRefreshRequest.create({ data: {
      refreshId: row.id, siteId: ids.site, floorId: ids.floor, requestedById: ids.user, clientRequestId: row.clientRequestId
    } });
    await db.mqttOutbox.create({ data: {
      monitoringRefreshBatchId: batch.id, topic: "retention/test", payload: {}, publishedAt: completedAt
    } });
    return row;
  }

  it("deletes only terminal refreshes strictly older than seven days and cascades their exact relations", async () => {
    const cutoff = new Date(now.getTime() - 7 * day);
    const expired = await Promise.all((["completed", "partial", "failed", "expired"] as const)
      .map(status => refresh(status, new Date(cutoff.getTime() - 1))));
    const boundary = await refresh("completed", cutoff);
    const recent = await refresh("completed", now);
    const pending = await refresh("pending", null);
    expect(await service.prune(now)).toMatchObject({ monitoringRefreshes: 4 });
    const retained = [boundary.id, recent.id, pending.id].sort();
    expect((await db.monitoringRefresh.findMany()).map(row => row.id).sort()).toEqual(retained);
    for (const model of [db.monitoringRefreshBatch, db.monitoringRefreshFixture, db.monitoringRefreshRequest]) {
      expect(await (model.count as () => Promise<number>)()).toBe(3);
    }
    expect(await db.mqttOutbox.count()).toBe(3);
    expect(await db.fixture.count()).toBe(1);
    expect(await db.gateway.count()).toBe(1);
    expect(await db.monitoringRefreshBatch.count({ where: { refreshId: { in: expired.map(row => row.id) } } })).toBe(0);
  });

  it("bounds an otherwise empty sweep to 1,000 terminal refresh parents", async () => {
    await db.monitoringRefresh.createMany({ data: Array.from({ length: 1001 }, () => ({
      id: randomUUID(), siteId: ids.site, floorId: ids.floor, requestedById: ids.user,
      clientRequestId: randomUUID(), status: "completed" as const, totalFixtures: 0,
      completedAt: old, deadlineAt: old, createdAt: old
    })) });
    expect(await service.prune(now)).toMatchObject({ monitoringRefreshes: 1000 });
    expect(await db.monitoringRefresh.count()).toBe(1);
    expect(await service.prune(now)).toMatchObject({ monitoringRefreshes: 1 });
  });

  it.each(["2026-01-31T12:00:00.000Z", "2026-02-28T12:00:00.000Z", "2026-05-31T12:00:00.000Z"])(
    "physically removes only activity strictly before the shared 3-calendar-month cutoff at %s", async iso => {
      const asOf = new Date(iso);
      const cutoff = threeCalendarMonthsBefore(asOf);
      await db.monitoringActivity.createMany({ data: [-1, 0, 1].map(offset => ({
        siteId: ids.site, floorId: ids.floor, sourceType: "fixture_state", sourceKey: `boundary:${offset}`,
        kind: "fixture_online" as const, recordedAt: new Date(cutoff.getTime() + offset)
      })) });
      expect(await service.prune(asOf)).toMatchObject({ monitoringActivities: 1 });
      expect((await db.monitoringActivity.findMany({ orderBy: { recordedAt: "asc" }, select: { sourceKey: true } }))
        .map(row => row.sourceKey)).toEqual(["boundary:0", "boundary:1"]);
    }
  );

  it("uses the same exclusive UTC boundary in a UTC database session", async () => {
    await db.$executeRawUnsafe("SET TIME ZONE 'UTC'");
    try {
      const cutoff = threeCalendarMonthsBefore(now);
      await db.monitoringActivity.createMany({ data: [-1, 0, 1].map(offset => ({
        siteId: ids.site, floorId: ids.floor, sourceType: "fixture_state", sourceKey: `utc:${offset}`,
        kind: "fixture_online" as const, recordedAt: new Date(cutoff.getTime() + offset)
      })) });
      expect(await service.prune(now)).toMatchObject({ monitoringActivities: 1 });
      expect((await db.monitoringActivity.findMany({ orderBy: { recordedAt: "asc" }, select: { sourceKey: true } }))
        .map(row => row.sourceKey)).toEqual(["utc:0", "utc:1"]);
    } finally {
      await db.$executeRawUnsafe("SET TIME ZONE 'Asia/Seoul'");
    }
  });

  it("bounds activity deletion at 1,000 rows without changing Command or recent activity", async () => {
    const cutoff = threeCalendarMonthsBefore(now);
    await db.monitoringActivity.createMany({ data: Array.from({ length: 1001 }, (_, index) => ({
      siteId: ids.site, floorId: ids.floor, sourceType: "fixture_state", sourceKey: `old:${index}`,
      kind: "fixture_online" as const, recordedAt: new Date(cutoff.getTime() - 1)
    })) });
    await db.monitoringActivity.create({ data: { siteId: ids.site, floorId: ids.floor,
      sourceType: "fixture_state", sourceKey: "new", kind: "fixture_online", recordedAt: now } });
    const beforeCommands = await db.command.count();
    expect(await service.prune(now)).toMatchObject({ monitoringActivities: 1000 });
    expect(await db.monitoringActivity.count()).toBe(2);
    expect(await db.command.count()).toBe(beforeCommands);
    expect(await service.prune(now)).toMatchObject({ monitoringActivities: 1 });
    expect(await db.monitoringActivity.findMany({ select: { sourceKey: true } })).toEqual([{ sourceKey: "new" }]);
  });

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
      INSERT INTO "Session" ("id", "userId", "familyId", "tokenHash", "expiresAt", "updatedAt")
      SELECT 'bounded-session-' || lpad(value::text, 5, '0'), ${ids.user}, 'bounded-family-' || value, 'token-' || value, ${old}, ${old}
      FROM generate_series(1, 10001) value
    `);
    await revisions(ids.floor, 1101);
    const retainedRefresh = await refresh("completed", old);
    expect(await service.prune(now)).toEqual({ gatewayEvents: 10000, sessions: 10000, floorMapRevisions: 1000,
      monitoringRefreshes: 0, monitoringActivities: 0 });
    expect(await db.monitoringRefresh.findUnique({ where: { id: retainedRefresh.id } })).not.toBeNull();
    expect((await db.processedGatewayEvent.findMany()).map(row => row.eventId)).toEqual(["bounded-event-10001"]);
    expect((await db.session.findMany()).map(row => row.id)).toEqual(["bounded-session-10001"]);
    expect((await db.floorMapRevision.findMany({ orderBy: { revision: "asc" }, take: 1 }))[0].revision).toBe(1001);
    expect(await service.prune(now)).toEqual({ gatewayEvents: 1, sessions: 1, floorMapRevisions: 1,
      monitoringRefreshes: 1, monitoringActivities: 0 });
    expect(await service.prune(now)).toEqual({ gatewayEvents: 0, sessions: 0, floorMapRevisions: 0,
      monitoringRefreshes: 0, monitoringActivities: 0 });
  });

  it("skips rows locked by another connection and converges on the next sweep", async () => {
    const locked = await event("gateway_heartbeat");
    await event("gateway_heartbeat");
    await db.session.createMany({ data: ["locked", "free"].map(id => ({ id, userId: ids.user, tokenHash: id, expiresAt: old })) });
    await revisions(ids.floor, 102);
    const lockedRefresh = await refresh("completed", old);
    await refresh("completed", old);
    const activityTime = new Date(threeCalendarMonthsBefore(now).getTime() - 1);
    const lockedActivity = await db.monitoringActivity.create({ data: { siteId: ids.site, floorId: ids.floor,
      sourceType: "fixture_state", sourceKey: "locked-activity", kind: "fixture_online", recordedAt: activityTime } });
    await db.monitoringActivity.create({ data: { siteId: ids.site, floorId: ids.floor,
      sourceType: "fixture_state", sourceKey: "free-activity", kind: "fixture_online", recordedAt: activityTime } });
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const lock = peer.$transaction(async tx => {
      await tx.$queryRaw`SELECT "eventId" FROM "ProcessedGatewayEvent" WHERE "eventId" = ${locked.eventId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = 'locked' FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "FloorMapRevision" WHERE "floorId" = ${ids.floor} AND "revision" = 1 FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "MonitoringRefresh" WHERE "id" = ${lockedRefresh.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "MonitoringActivity" WHERE "id" = ${lockedActivity.id} FOR UPDATE`;
      acquired();
      await gate;
    }, { timeout: 10_000 });
    try {
      await Promise.race([ready, lock.then(() => { throw new Error("lock transaction ended before acquiring rows"); })]);
      expect(await service.prune(now)).toEqual({ gatewayEvents: 1, sessions: 1, floorMapRevisions: 1,
        monitoringRefreshes: 1, monitoringActivities: 1 });
      expect(await db.monitoringRefresh.findUnique({ where: { id: lockedRefresh.id } })).not.toBeNull();
      expect(await db.processedGatewayEvent.findUnique({ where: { eventId: locked.eventId } })).not.toBeNull();
      expect(await db.session.findUnique({ where: { id: "locked" } })).not.toBeNull();
      expect(await db.floorMapRevision.count()).toBe(101);
      expect(await db.monitoringActivity.findUnique({ where: { id: lockedActivity.id } })).not.toBeNull();
    } finally { release(); await lock; }
    expect(await service.prune(now)).toEqual({ gatewayEvents: 1, sessions: 1, floorMapRevisions: 1,
      monitoringRefreshes: 1, monitoringActivities: 1 });
    expect(await db.floorMapRevision.count()).toBe(100);
    expect(await db.monitoringActivity.count()).toBe(0);
  }, 15_000);

  it("drains retention before final Prisma disconnect when the real Nest application closes", async () => {
    await event("gateway_heartbeat");
    await db.session.create({ data: { userId: ids.user, tokenHash: "lifecycle-session", expiresAt: old } });
    await revisions(ids.floor, 101);
    const connectionCount = async () => {
      const [row] = await peer.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
      `;
      return row.count;
    };
    const baselineConnections = await connectionCount();
    const prisma = new PrismaService({ datasourceUrl: `${databaseUrl}?connection_limit=1` });
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, RetentionModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    const app = moduleRef.createNestApplication();
    const worker = app.get(DataRetentionService);
    const order: string[] = [];
    let release!: () => void;
    let firstCompleted!: () => void;
    let drainEntered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const first = new Promise<void>(resolve => { firstCompleted = resolve; });
    const draining = new Promise<void>(resolve => { drainEntered = resolve; });
    const execute = prisma.$executeRaw.bind(prisma);
    let queries = 0;
    // Keep every SQL statement real. Pausing its result after query 1 commits
    // leaves Prisma free to disconnect early, reproducing the production race.
    const executeSpy = jest.spyOn(prisma, "$executeRaw").mockImplementation((query, ...values) => (async () => {
      const count = await execute(query, ...values);
      order.push(`query-${++queries}`);
      if (queries === 1) { firstCompleted(); await paused; }
      return count;
    })() as never);
    const disconnect = prisma.$disconnect.bind(prisma);
    const disconnectSpy = jest.spyOn(prisma, "$disconnect").mockImplementation(async () => {
      await disconnect();
      order.push("disconnect");
    });
    const destroy = worker.onModuleDestroy.bind(worker);
    const destroySpy = jest.spyOn(worker, "onModuleDestroy").mockImplementation(async () => {
      drainEntered();
      await destroy();
    });
    let closing: Promise<void> | undefined;
    let sweep: ReturnType<DataRetentionService["prune"]> | undefined;
    const previousEnvironment = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      await app.init();
      process.env.NODE_ENV = previousEnvironment;
      sweep = worker.prune(now);
      await first;
      closing = app.close();
      await draining;
      const atDrain = [...order];
      release();
      expect(await sweep).toEqual({ gatewayEvents: 1, sessions: 1, floorMapRevisions: 1,
        monitoringRefreshes: 0, monitoringActivities: 0 });
      await closing;
      expect({ atDrain, completed: order, connections: await connectionCount() }).toEqual({
        atDrain: ["query-1"], completed: ["query-1", "query-2", "query-3", "query-4", "query-5", "disconnect"],
        connections: baselineConnections
      });
      expect(await db.session.count()).toBe(0);
      expect(await db.floorMapRevision.count()).toBe(100);
    } finally {
      process.env.NODE_ENV = previousEnvironment;
      release();
      await sweep?.catch(() => {});
      await (closing ?? app.close()).catch(() => {});
      executeSpy.mockRestore(); disconnectSpy.mockRestore(); destroySpy.mockRestore();
      await prisma.$disconnect();
    }
  }, 15_000);
});
