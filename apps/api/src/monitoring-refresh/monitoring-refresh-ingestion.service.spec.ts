import { fixtureUnreachableV1Schema, mqttTopicsV2 } from "@led-control/shared";
import { MonitoringRefreshIngestionService } from "./monitoring-refresh-ingestion.service";

const ids = {
  siteId: "11111111-1111-4111-8111-111111111111", gatewayId: "22222222-2222-4222-8222-222222222222",
  fixtureId: "33333333-3333-4333-8333-333333333333", refreshId: "44444444-4444-4444-8444-444444444444",
  batchId: "55555555-5555-4555-8555-555555555555"
};
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 8, 0, seconds));
const event = () => fixtureUnreachableV1Schema.parse({ ...ids,
  eventId: "66666666-6666-4666-8666-666666666666", sequence: 9, occurredAt: at(5).toISOString(), reason: "not_found" });
const topic = mqttTopicsV2.fixtureUnreachable(ids.siteId, ids.gatewayId);
const completion = () => ({ ...ids, fixtureId: undefined, eventId: "77777777-7777-4777-8777-777777777777",
  sequence: 10, occurredAt: at(8).toISOString(), targetFixtureIds: [ids.fixtureId] });

describe("MonitoringRefreshIngestionService", () => {
  it.each(["unreachable", "completion"])("discards retired %s with its application ACK and no data mutation", async (kind) => {
    const db = database(); db.refresh = undefined; db.batch = undefined;
    const service = new MonitoringRefreshIngestionService(db as never);
    const { fixtureId: _, ...completed } = completion();
    const result = kind === "unreachable" ? await service.ingestUnreachable(topic, event(), at(6))
      : await service.completeBatch(mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId), completed, at(8));
    expect(result).toEqual(kind === "unreachable"
      ? { eventId: event().eventId, sequence: 9, fixtureId: ids.fixtureId, status: "duplicate" }
      : { ack: { siteId: ids.siteId, gatewayId: ids.gatewayId, refreshId: ids.refreshId, batchId: ids.batchId } });
    expect(db.fixture.update).not.toHaveBeenCalled(); expect(db.monitoringRefreshFixture.update).not.toHaveBeenCalled();
    expect(db.processedGatewayEvent.create).not.toHaveBeenCalled(); expect(db.gatewayEventWatermark.upsert).not.toHaveBeenCalled();
    expect(db.monitoringRefresh.updateMany).not.toHaveBeenCalled(); expect(db.mqttOutbox.deleteMany).not.toHaveBeenCalled();
  });

  it.each(["refresh", "batch"])("rejects a missing %s when the other identity still exists", async (missing) => {
    const db = database(); db[missing] = undefined;
    const { fixtureId: _, ...completed } = completion();
    const service = new MonitoringRefreshIngestionService(db as never);
    await expect(service.ingestUnreachable(topic, event(), at(6))).rejects.toThrow("scope");
    await expect(service.completeBatch(mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId), completed, at(8))).rejects.toThrow("scope");
  });

  it.each(["unreachable", "completion"])("never acknowledges %s when retirement lookup fails", async (kind) => {
    const db = database(); const query = db.$queryRaw.getMockImplementation();
    db.$queryRaw.mockImplementation(async (q: any) => {
      if (q.sql.includes('FROM "MonitoringRefresh"')) throw new Error("DB unavailable");
      return query(q);
    });
    const { fixtureId: _, ...completed } = completion();
    const service = new MonitoringRefreshIngestionService(db as never);
    await expect(kind === "unreachable" ? service.ingestUnreachable(topic, event(), at(6))
      : service.completeBatch(mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId), completed, at(8))).rejects.toThrow("DB unavailable");
  });
  it("stores verified offline without fabricating output or reported state and replays exactly", async () => {
    const db = database(); const service = new MonitoringRefreshIngestionService(db as never);
    expect(await service.ingestUnreachable(topic, event(), at(6))).toMatchObject({ status: "ingested" });
    expect(db.fixtureRow).toMatchObject({ lastUnreachableAt: at(6), status: "offline", brightness: 70, reportedStatus: "online" });
    expect(db.child).toMatchObject({ status: "offline", errorCode: "not_found" });
    expect(db.fixture.update.mock.calls[0][0].data).toEqual({ lastUnreachableAt: at(6), status: "offline", statusReason: "fixture_stale" });
    expect(await service.ingestUnreachable(topic, event(), at(7))).toMatchObject({ status: "duplicate" });
    expect(db.fixture.update).toHaveBeenCalledTimes(1);
    await expect(service.ingestUnreachable(topic, { ...event(), reason: "read_failed" }, at(7))).rejects.toThrow("conflict");
  });

  it("locks Site, Gateway, Fixture, refresh, batch, child in that order", async () => {
    const db = database(); await new MonitoringRefreshIngestionService(db as never).ingestUnreachable(topic, event(), at(6));
    const tables = db.$queryRaw.mock.calls.map(([q]: any[]) => /FROM "(\w+)"/.exec(q.sql)?.[1]);
    expect(tables).toEqual(["Site", "Gateway", "Fixture", "MonitoringRefresh", "MonitoringRefreshBatch", "MonitoringRefreshFixture"]);
  });

  it("lets a success after refresh creation win over delayed failure", async () => {
    const db = database(); db.fixtureRow.lastSeenAt = at(4);
    await new MonitoringRefreshIngestionService(db as never).ingestUnreachable(topic, event(), at(6));
    expect(db.fixture.update).not.toHaveBeenCalled(); expect(db.child.status).toBe("online");
  });

  it.each(["deadline", "gateway", "older-refresh"])("does not mark offline for %s", async (reason) => {
    const db = database();
    if (reason === "gateway") db.gateway.lastHeartbeatAt = at(-500);
    if (reason === "older-refresh") db.fixtureRow.lastUnreachableAt = at(7);
    await new MonitoringRefreshIngestionService(db as never).ingestUnreachable(topic, event(), reason === "deadline" ? at(30) : at(6));
    expect(db.fixture.update).not.toHaveBeenCalled(); expect(db.child.status).toBe("unverified");
  });

  it.each(["site", "gateway", "batch", "snapshot", "child"])("rejects wrong %s ownership", async (kind) => {
    const db = database();
    if (kind === "site") db.refresh.siteId = "other";
    if (kind === "gateway") db.batch.gatewayId = "other";
    if (kind === "batch") db.batch.refreshId = "other";
    if (kind === "snapshot") db.batch.targetFixtureIds = [];
    if (kind === "child") db.child.batchId = "other";
    await expect(new MonitoringRefreshIngestionService(db as never).ingestUnreachable(topic, event(), at(6))).rejects.toThrow("scope");
    expect(db.fixture.update).not.toHaveBeenCalled();
  });

  it("rejects raw errors and topic mismatch", async () => {
    const db = database(); const service = new MonitoringRefreshIngestionService(db as never);
    await expect(service.ingestUnreachable(topic, { ...event(), reason: "USB secret" }, at(6))).rejects.toThrow();
    await expect(service.ingestUnreachable(topic.replace(ids.siteId, ids.fixtureId), event(), at(6))).rejects.toThrow("scope");
    await expect(service.ingestUnreachable(`sites/${ids.siteId}/gateways/${ids.gatewayId}/state/fixture-unreachable`, event(), at(6))).rejects.toThrow("scope");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(["sequence", "time", "future"])("does not apply %s reversal", async (kind) => {
    const db = database();
    if (kind !== "future") db.watermark = { lastSequence: kind === "sequence" ? 10n : 8n,
      lastOccurredAt: at(7), lastEventId: "old", lastPayloadHash: "old" };
    const input = kind === "future" ? { ...event(), occurredAt: "9999-01-01T00:00:00.000Z" } : event();
    const result = await new MonitoringRefreshIngestionService(db as never).ingestUnreachable(topic, input, at(6));
    expect(result.status).toBe(kind === "future" ? "rejected_future_timestamp" : "stale_sequence");
    expect(db.fixture.update).not.toHaveBeenCalled(); expect(db.child.status).toBe("pending");
  });

  it("rejects an altered sequence reusing a watermark-only event identity", async () => {
    const db = database(); db.watermark = { lastSequence: 10n, lastOccurredAt: at(5), lastEventId: event().eventId, lastPayloadHash: "old" };
    await expect(new MonitoringRefreshIngestionService(db as never).ingestUnreachable(topic, event(), at(6))).rejects.toThrow("conflict");
    expect(db.fixture.update).not.toHaveBeenCalled();
  });

  it("uses the locked Site heartbeat policy instead of an assumed default", async () => {
    const db = database(); db.site.gatewayOfflineAfterSeconds = 3;
    await new MonitoringRefreshIngestionService(db as never).ingestUnreachable(topic, event(), at(6));
    expect(db.fixture.update).not.toHaveBeenCalled(); expect(db.child).toMatchObject({ status: "unverified", errorCode: "gateway_offline" });
  });

  it("rejects a completion whose target snapshot differs from the command", async () => {
    const db = database(); db.child.status = "online";
    const { fixtureId: _, ...completed } = completion();
    await expect(new MonitoringRefreshIngestionService(db as never).completeBatch(mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId),
      { ...completed, targetFixtureIds: [ids.gatewayId] }, at(8))).rejects.toThrow("scope");
    expect(db.mqttOutbox.deleteMany).not.toHaveBeenCalled();
  });

  it("withholds completion until all expected children are terminal, then aggregates DB truth and replays", async () => {
    const db = database(); const service = new MonitoringRefreshIngestionService(db as never);
    const { fixtureId: _, ...completed } = completion(); const completionTopic = mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId);
    await expect(service.completeBatch(completionTopic, completed, at(8))).resolves.toEqual({ ack: null });
    expect(db.ledger.size).toBe(0);
    await service.ingestUnreachable(topic, event(), at(6));
    expect(await service.completeBatch(completionTopic, completed, at(8))).toEqual({ ack: {
      siteId: ids.siteId, gatewayId: ids.gatewayId, refreshId: ids.refreshId, batchId: ids.batchId } });
    expect(db.refresh).toMatchObject({ status: "completed", onlineFixtures: 0, offlineFixtures: 1, unverifiedFixtures: 0 });
    expect(db.batch.status).toBe("completed"); expect(db.mqttOutbox.deleteMany).toHaveBeenCalledTimes(1);
    await service.completeBatch(completionTopic, completed, at(9));
    expect(db.monitoringRefresh.updateMany).toHaveBeenCalledTimes(1);
    await expect(service.completeBatch(completionTopic, { ...completed, sequence: 11 }, at(9))).rejects.toThrow("conflict");
  });

  it("rejects a conflicting completion event identity even while children are pending", async () => {
    const db = database();
    const { fixtureId: _, ...completed } = completion();
    db.ledger.set(completed.eventId, { gatewayId: ids.gatewayId, eventType: "fixture_presence_check_completed", scopeKey: ids.batchId,
      sequence: 10n, occurredAt: at(8), payloadHash: "different-payload" });
    await expect(new MonitoringRefreshIngestionService(db as never).completeBatch(
      mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId), completed, at(8))).rejects.toThrow("identity conflict");
  });

  it.each([false, true])("rejects a watermark-only completion identity conflict (retired=%s)", async (retired) => {
    const db = database(); if (retired) { db.refresh = undefined; db.batch = undefined; }
    const { fixtureId: _, ...completed } = completion();
    db.gatewayEventWatermark.findFirst.mockResolvedValue({ gatewayId: ids.gatewayId, eventType: "fixture_presence_check_completed",
      scopeKey: ids.batchId, lastEventId: completed.eventId, lastSequence: 99n, lastOccurredAt: at(8), lastPayloadHash: "altered" });
    await expect(new MonitoringRefreshIngestionService(db as never).completeBatch(
      mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId), completed, at(8))).rejects.toThrow("identity conflict");
  });

  it.each([null, at(1)])("completes before or after publisher persistence, preserving publishedAt=%s", async (publishedAt) => {
    const db = database(); db.batch.publishedAt = publishedAt; db.batch.status = publishedAt ? "published" : "pending"; db.child.status = "online";
    const { fixtureId: _, ...completed } = completion();
    await new MonitoringRefreshIngestionService(db as never).completeBatch(mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId), completed, at(8));
    expect(db.batch).toMatchObject({ status: "completed", publishedAt: publishedAt ?? at(8), completedAt: at(8) });
    expect(db.refresh.status).toBe("completed");
  });

  it("acknowledges expired child truth without rewriting terminal aggregates", async () => {
    const db = database(); db.refresh.status = "expired"; db.batch.status = "expired"; db.child.status = "unverified";
    const { fixtureId: _, ...completed } = completion();
    const service = new MonitoringRefreshIngestionService(db as never);
    const completionTopic = mqttTopicsV2.fixturePresenceCheckCompleted(ids.siteId, ids.gatewayId);
    const expected = { ack: { siteId: ids.siteId, gatewayId: ids.gatewayId, refreshId: ids.refreshId, batchId: ids.batchId } };
    await expect(service.completeBatch(completionTopic, completed, at(40))).resolves.toEqual(expected);
    await expect(service.completeBatch(completionTopic, completed, at(41))).resolves.toEqual(expected);
    await expect(service.completeBatch(completionTopic, { ...completed, sequence: 11 }, at(42))).rejects.toThrow("conflict");
    expect(db.monitoringRefreshBatch.update).not.toHaveBeenCalled();
    expect(db.monitoringRefresh.updateMany).not.toHaveBeenCalled();
    expect(db.refresh.status).toBe("expired"); expect(db.batch.status).toBe("expired");
  });
});

function database(): any {
  const db: any = {
    fixtureRow: { id: ids.fixtureId, floorId: "floor", lastSeenAt: at(-1), lastUnreachableAt: null, status: "online", brightness: 70, reportedStatus: "online" },
    site: { id: ids.siteId, gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200 },
    gateway: { id: ids.gatewayId, lastHeartbeatAt: at(0) },
    refresh: { id: ids.refreshId, siteId: ids.siteId, floorId: "floor", status: "pending", totalFixtures: 1, createdAt: at(0), deadlineAt: at(30) },
    batch: { id: ids.batchId, siteId: ids.siteId, refreshId: ids.refreshId, gatewayId: ids.gatewayId, status: "published", publishedAt: at(1), completedAt: null, targetFixtureIds: [ids.fixtureId] },
    child: { ...ids, status: "pending", errorCode: null, observedAt: null }, ledger: new Map(), watermark: null,
    $executeRaw: jest.fn().mockResolvedValue(1)
  };
  db.$queryRaw = jest.fn(async (q: { sql: string }) => {
    const table = /FROM "(\w+)"/.exec(q.sql)?.[1];
    return [{ Site: db.site, Gateway: db.gateway, Fixture: db.fixtureRow, MonitoringRefresh: db.refresh,
      MonitoringRefreshBatch: db.batch, MonitoringRefreshFixture: db.child }[table as string]!];
  });
  db.$transaction = jest.fn(async (fn: any) => fn(db));
  db.processedGatewayEvent = { findUnique: jest.fn(async ({ where }: any) => db.ledger.get(where.eventId) ?? null),
    create: jest.fn(async ({ data }: any) => { db.ledger.set(data.eventId, data); return data; }) };
  db.gatewayEventWatermark = { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(async () => db.watermark),
    upsert: jest.fn(async ({ update }: any) => { db.watermark = update; }) };
  db.fixture = { update: jest.fn(async ({ data }: any) => Object.assign(db.fixtureRow, data)) };
  db.monitoringRefreshFixture = { update: jest.fn(async ({ data }: any) => Object.assign(db.child, data)),
    findMany: jest.fn(async () => [db.child]), count: jest.fn(async () => db.child.status === "pending" ? 1 : 0),
    groupBy: jest.fn(async () => [{ status: db.child.status, _count: { _all: 1 } }]) };
  db.monitoringRefreshBatch = { update: jest.fn(async ({ data }: any) => Object.assign(db.batch, data)),
    count: jest.fn(async () => ["pending", "published"].includes(db.batch.status) ? 1 : 0) };
  db.monitoringRefresh = { updateMany: jest.fn(async ({ data }: any) => { Object.assign(db.refresh, data); return { count: 1 }; }) };
  db.mqttOutbox = { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) };
  return db;
}
