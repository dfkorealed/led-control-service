import { LegacyStatusCheckPublisherService } from "./legacy-status-check-publisher.service";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const now = new Date("2026-07-11T00:01:00.000Z");
const siteId = "11111111-1111-4111-8111-111111111111";
const gatewayId = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";
const dispatchId = "44444444-4444-4444-8444-444444444444";
const topic = `sites/${siteId}/gateways/${gatewayId}/commands/status-check`;
const draft = { commandId, originalCommandId: commandId, dispatchId, siteId, gatewayId,
  idempotencyKey: "55555555-5555-4555-8555-555555555555", sequence: 1,
  targetFixtureIds: ["66666666-6666-4666-8666-666666666666"], expectedBrightness: 65,
  verificationAttempt: 1, requestedAt: "2026-07-11T00:00:00.000Z" };
const record = { id: "outbox-get", dispatchId, topic, payload: draft, attempts: 0,
  createdAt: now, deliveryAttemptedAt: null,
  dispatch: { commandId, kind: "status_check", gatewayId, deliveryMode: "unicast",
    destinationAddress: null, meshControlGroupId: null, meshControlGroupVersion: null } };

describe("LegacyStatusCheckPublisherService", () => {
  afterEach(() => {
    delete process.env.COMMAND_RETENTION_PUBLISH_CUTOFF;
    delete process.env.COMMAND_RETENTION_PUBLISH_FENCE;
  });

  it("claims only status-check rows into its own lease", async () => {
    const tx: any = { $queryRaw: jest.fn().mockResolvedValue([]), mqttOutbox: { updateMany: jest.fn() } };
    const prisma: any = { $transaction: jest.fn((work: (client: any) => Promise<unknown>) => work(tx)) };
    const snapshot = { lockMutation: jest.fn().mockResolvedValue(undefined) };
    const publisher = new LegacyStatusCheckPublisherService(prisma, {} as never,
      { workerId: "get-worker" }, snapshot as never);

    await expect(publisher.claimBatch(now)).resolves.toEqual([]);

    const query = tx.$queryRaw.mock.calls[0][0];
    expect(query.strings.join(" ")).toContain('dispatch."kind" =');
    expect(query.values).toContain("status_check");
    expect(tx.mqttOutbox.updateMany).not.toHaveBeenCalled();
  });

  it("keeps legacy Get publication available after Set drain with the fence flag enabled", async () => {
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    process.env.COMMAND_RETENTION_PUBLISH_FENCE = "1";
    const tx: any = {
      $executeRaw: jest.fn(),
      command: { findUnique: jest.fn().mockResolvedValue({ createdAt: now }) },
      mqttOutbox: { count: jest.fn().mockResolvedValue(1), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const prisma: any = { ...tx, $transaction: jest.fn((work: (client: any) => Promise<unknown>) => work(tx)) };
    const snapshot = { lockMutation: jest.fn().mockResolvedValue(undefined) };
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const set = new OutboxPublisherService(prisma, mqtt as never, { workerId: "set-worker" }, snapshot as never);
    const get = new LegacyStatusCheckPublisherService(prisma, mqtt as never,
      { workerId: "get-worker", clock: () => now }, snapshot as never);
    await set.stopAndDrain();

    await get.publishClaimed(record as never);

    expect(mqtt.publishTopic).toHaveBeenCalledWith(topic, expect.objectContaining({ originalCommandId: commandId }),
      { messageExpiryInterval: 10, timeoutMs: 20_000 });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: dispatchId, status: "pending" }, data: expect.objectContaining({ status: "published" })
    }));
  });

  it("rejects Set dispatches and an incorrect Get topic before preparing a payload", async () => {
    const prisma: any = { $transaction: jest.fn() };
    const mqtt = { publishTopic: jest.fn() };
    const get = new LegacyStatusCheckPublisherService(prisma, mqtt as never, { workerId: "get-worker" });
    await get.publishClaimed({ ...record, dispatch: { ...record.dispatch, kind: "dimming" } } as never);
    await get.publishClaimed({ ...record, topic: `sites/${siteId}/gateways/${gatewayId}/commands/dimming` } as never);
    await get.publishClaimed({ ...record, topic: `sites/${randomUUID()}/gateways/${gatewayId}/commands/status-check` } as never);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("does not prepare or publish a Get when its DB dispatch kind changed after claim", async () => {
    const tx: any = {
      mqttOutbox: {
        updateMany: jest.fn(async ({ where }: any) => ({ count: where.dispatch?.kind === "status_check" ? 0 : 1 })),
        count: jest.fn().mockResolvedValue(1)
      },
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const prisma: any = { ...tx, $transaction: jest.fn((work: (client: any) => Promise<unknown>) => work(tx)) };
    const snapshot = { lockMutation: jest.fn().mockResolvedValue(undefined) };
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const get = new LegacyStatusCheckPublisherService(prisma, mqtt as never,
      { workerId: "get-worker", clock: () => now }, snapshot as never);

    await get.publishClaimed(record as never);

    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ dispatch: { kind: "status_check" } }),
      data: expect.objectContaining({ payload: expect.objectContaining({ originalCommandId: commandId }) })
    }));
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });
});

(process.env.COMMAND_RETENTION_TEST === "1" ? describe : describe.skip)("mixed command outbox leases on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
  }, 30_000);

  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  it.each(["UTC", "Asia/Seoul"])("leases each kind once in %s and leaves Get claimable when Set stops", async (timeZone) => {
    await db.$executeRawUnsafe(timeZone === "UTC" ? "SET TIME ZONE 'UTC'" : "SET TIME ZONE 'Asia/Seoul'");
    const organization = await db.organization.create({ data: { name: "Publisher split" } });
    const site = await db.site.create({ data: { organizationId: organization.id, name: "Site" } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, name: "Gateway",
      serialNumber: randomUUID(), firmwareVersion: "test" } });
    const command = await db.command.create({ data: { siteId: site.id, clientRequestId: randomUUID(),
      requestFingerprint: "split", targetType: "fixtures", brightness: 65 } });
    const createOutbox = async (kind: "dimming" | "status_check", sequence: bigint) => db.commandDispatch.create({
      data: { commandId: command.id, gatewayId: gateway.id, kind, idempotencyKey: randomUUID(), sequence,
        outbox: { create: { topic: `sites/${site.id}/gateways/${gateway.id}/commands/${kind === "dimming" ? "dimming" : "status-check"}`,
          payload: {} } } }, include: { outbox: true }
    });
    const setRow = await createOutbox("dimming", 1n);
    const getRow = await createOutbox("status_check", 2n);
    const snapshot = { lockMutation: async () => undefined };
    const set = new OutboxPublisherService(db as never, {} as never, { workerId: "set-worker" }, snapshot as never);
    const get = new LegacyStatusCheckPublisherService(db as never, {} as never,
      { workerId: "get-worker" }, snapshot as never);
    const claimAt = new Date();

    const [setClaims, getClaims] = await Promise.all([set.claimBatch(claimAt), get.claimBatch(claimAt)]);

    expect(setClaims.map(({ id }) => id)).toEqual([setRow.outbox!.id]);
    expect(getClaims.map(({ id }) => id)).toEqual([getRow.outbox!.id]);
    expect((await db.mqttOutbox.findMany({ where: { id: { in: [setRow.outbox!.id, getRow.outbox!.id] } },
      orderBy: { topic: "asc" } })).map(({ lockedBy }) => lockedBy).sort()).toEqual(["get-worker", "set-worker"]);

    await set.stopAndDrain();
    const nextGet = await createOutbox("status_check", 3n);
    expect(await set.claimBatch(new Date())).toEqual([]);
    expect((await get.claimBatch(new Date())).map(({ id }) => id)).toEqual([nextGet.outbox!.id]);
  });
});
