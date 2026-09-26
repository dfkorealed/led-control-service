import { Prisma, PrismaClient } from "@prisma/client";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const describeWithDatabase = process.env.COMMAND_RETENTION_TEST === "1" ? describe : describe.skip;

describeWithDatabase("Set publisher PostgreSQL permit", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let publisherConnection: PrismaClient;
  let purgeConnection: PrismaClient;
  const priorEgress = process.env.COMMAND_SET_EGRESS_ENABLED;
  beforeEach(() => { process.env.COMMAND_SET_EGRESS_ENABLED = "1"; });
  afterEach(() => {
    if (priorEgress === undefined) delete process.env.COMMAND_SET_EGRESS_ENABLED;
    else process.env.COMMAND_SET_EGRESS_ENABLED = priorEgress;
  });

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const databaseUrl = cluster.database();
    publisherConnection = new PrismaClient({ datasourceUrl: databaseUrl });
    purgeConnection = new PrismaClient({ datasourceUrl: databaseUrl });
    await Promise.all([publisherConnection.$connect(), purgeConnection.$connect()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([publisherConnection?.$disconnect(), purgeConnection?.$disconnect()]);
    cluster?.stop();
  });

  it("drains a live MQTT publish before an exclusive purge permit while ordinary queries continue", async () => {
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    const now = new Date();
    const commandId = "11111111-1111-4111-8111-111111111111";
    const dispatchId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const payload = {
      ...wireScope(commandId, dispatchId, gatewayId, now),
      deliveryGeneration: "44444444-4444-4444-8444-444444444444",
      deliveryGeneratedAt: now.toISOString(), deliveryWindowMs: 10_000,
      expiresAt: new Date(now.getTime() + 10_000).toISOString()
    };
    const mqttStarted = deferred<void>();
    const completeMqtt = deferred<void>();
    const publish = { publishTopic: jest.fn(async () => { mqttStarted.resolve(); await completeMqtt.promise; }) };
    const fakeRows = {
      commandPublishMember: { findFirst: async () => ({ generation: 7 }) },
      commandPublishAttempt: { findFirst: async () => ({ generation: 7 }) },
      command: { findUnique: async () => ({ createdAt: now }) },
      mqttOutbox: { findUnique: async () => ({ dispatchId, lockedBy: "publisher-integration",
        publishedAt: null, deadLetteredAt: null, deliveryAttemptedAt: now,
        leaseExpiresAt: new Date(now.getTime() + 30_000), payload }) },
      gatewayRecommissionJob: { count: async () => 0 }
    };
    const db = {
      $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
        publisherConnection.$transaction(
          (tx) => callback(Object.assign(Object.create(tx), fakeRows) as Prisma.TransactionClient), options
        )
    };
    const publisher = new OutboxPublisherService(db as never, publish as never, {
      workerId: "publisher-integration", clock: () => now
    }, undefined, egress(publish) as never, { currentForSet: async () => 7 } as never,
    { assertHealthy: async () => now } as never);
    const publishing = (publisher as any).publishUnderRetentionPermit({
      id: "55555555-5555-4555-8555-555555555555", dispatchId, topic: "test/command",
      dispatch: { commandId, gatewayId }
    }, payload);

    try {
      await mqttStarted.promise;
      const whilePublishing = await purgeConnection.$transaction(async (tx) => {
        const [permit] = await tx.$queryRaw<Array<{ acquired: boolean }>>(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(${8052026092501n}) AS "acquired"`
        );
        const [query] = await tx.$queryRaw<Array<{ healthy: number }>>(Prisma.sql`SELECT 1 AS "healthy"`);
        return { permit: permit.acquired, healthy: query.healthy };
      });
      expect(whilePublishing).toEqual({ permit: false, healthy: 1 });
    } finally {
      completeMqtt.resolve();
      await publishing;
      delete process.env.COMMAND_RETENTION_PUBLISH_CUTOFF;
    }
    const afterPublish = await purgeConnection.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ acquired: boolean }>>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(${8052026092501n}) AS "acquired"`
      );
      return row.acquired;
    });
    expect(afterPublish).toBe(true);
    expect(publish.publishTopic).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("shows why a lost DB connection still requires a wire-expiry purge guard", async () => {
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    const now = new Date();
    const commandId = "11111111-1111-4111-8111-111111111111";
    const dispatchId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const payload = {
      ...wireScope(commandId, dispatchId, gatewayId, now),
      deliveryGeneration: "44444444-4444-4444-8444-444444444444",
      deliveryGeneratedAt: now.toISOString(), deliveryWindowMs: 10_000,
      expiresAt: new Date(now.getTime() + 10_000).toISOString()
    };
    const mqttStarted = deferred<void>();
    const releaseMqtt = deferred<void>();
    const brokerAccepted = deferred<void>();
    const mqtt = { publishTopic: jest.fn(async () => {
      mqttStarted.resolve();
      await releaseMqtt.promise;
      brokerAccepted.resolve();
    }) };
    const fakeRows = {
      commandPublishMember: { findFirst: async () => ({ generation: 7 }) },
      commandPublishAttempt: { findFirst: async () => ({ generation: 7 }) },
      command: { findUnique: async () => ({ createdAt: now }) },
      mqttOutbox: { findUnique: async () => ({ dispatchId, lockedBy: "publisher-integration",
        publishedAt: null, deadLetteredAt: null, deliveryAttemptedAt: now,
        leaseExpiresAt: new Date(now.getTime() + 30_000), payload }) },
      gatewayRecommissionJob: { count: async () => 0 }
    };
    let backendPid = 0;
    const db = { $transaction: (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
      publisherConnection.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`SELECT pg_backend_pid() AS "pid"`);
      backendPid = backend.pid;
      return callback(Object.assign(Object.create(tx), fakeRows) as Prisma.TransactionClient);
    }, options) };
    const publisher = new OutboxPublisherService(db as never, mqtt as never, {
      workerId: "publisher-integration", clock: () => now
    }, undefined, egress(mqtt) as never, { currentForSet: async () => 7 } as never,
    { assertHealthy: async () => now } as never);
    const publishing = (publisher as any).publishUnderRetentionPermit({
      id: "55555555-5555-4555-8555-555555555555", dispatchId, topic: "test/command",
      dispatch: { commandId, gatewayId }
    }, payload);
    const settled = publishing.then(() => "committed", () => "connection-lost");
    try {
      await mqttStarted.promise;
      const [terminated] = await purgeConnection.$queryRaw<Array<{ terminated: boolean }>>(
        Prisma.sql`SELECT pg_terminate_backend(${backendPid}::integer) AS "terminated"`
      );
      expect(terminated.terminated).toBe(true);
      const [permit] = await purgeConnection.$transaction((tx) => tx.$queryRaw<Array<{ acquired: boolean }>>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(${8052026092501n}) AS "acquired"`
      ));
      expect(permit.acquired).toBe(true);
      expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
      // The broker can accept the already-started MQTT publish only *after*
      // the DB session/permit vanished. An exclusive permit is insufficient.
    } finally {
      releaseMqtt.resolve();
      delete process.env.COMMAND_RETENTION_PUBLISH_CUTOFF;
    }
    await brokerAccepted.promise;
    expect(await settled).toBe("connection-lost");
  }, 10_000);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function egress(mqtt: { publishTopic: (...args: any[]) => Promise<void> }) {
  return { assertPublisherIdentity: () => {}, publish: (_generation: number, topic: string, payload: unknown, expiry: number) =>
    mqtt.publishTopic(topic, payload, { messageExpiryInterval: expiry, timeoutMs: 20_000 }) };
}

function wireScope(commandId: string, dispatchId: string, gatewayId: string, now: Date) {
  return { commandId, dispatchId, gatewayId, siteId: commandId, idempotencyKey: commandId, sequence: 1,
    targetType: "fixture", targetId: commandId, targetFixtureIds: [commandId], deliveryMode: "unicast",
    brightness: 50, requestedAt: now.toISOString(), publishEpoch: 7 };
}
