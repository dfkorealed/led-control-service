import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { gatewayDimmingCommandEpochPublishedV2Schema } from "@led-control/shared";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { disposableSetBroker } from "../../test/support/disposable-set-broker";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { LegacyStatusCheckPublisherService } from "./legacy-status-check-publisher.service";
import { CommandDbClockHealth, type CommandDbClockEvidence } from "./command-db-clock-health.service";
import { CommandPublishEpochService } from "./command-publish-epoch.service";
import { CommandPublishQuiesceService } from "./command-publish-quiesce.service";
import { CommandSetMqttService } from "./command-set-mqtt.service";

(process.env.COMMAND_RETENTION_TEST === "1" ? describe : describe.skip)("Set publisher PostgreSQL epoch permit", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let peer: PrismaClient;
  let epoch = 0;
  let evidence: CommandDbClockEvidence;
  let health: CommandDbClockHealth;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    expect(cluster.deploy(url).status).toBe(0);
    db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=3` });
    peer = new PrismaClient({ datasourceUrl: `${url}?connection_limit=2` });
  }, 30_000);
  beforeEach(async () => {
    process.env.COMMAND_SET_EGRESS_ENABLED = "1";
    process.env.COMMAND_RETENTION_PUBLISH_CUTOFF = "1";
    process.env.COMMAND_RETENTION_PUBLISH_FENCE = "1";
    await db.commandPublishEpoch.create({ data: { generation: ++epoch } });
    await db.commandPublishMember.createMany({ data: ["worker-a", "worker-b"].map(workerId => ({
      generation: epoch, workerId, brokerIdentity: `command-set-${epoch}`
    })) });
    const [primary] = await db.$queryRaw<Array<{ startedAt: Date; address: string; port: number }>>`
      SELECT pg_postmaster_start_time() AS "startedAt", inet_server_addr()::text AS address, inet_server_port() AS port`;
    evidence = { issuedAt: new Date(), offsetMs: 0, stepGeneration: 0, clearedStepGeneration: 0,
      failoverGeneration: 0, clearedFailoverGeneration: 0, primary };
    const baseline = { generation: epoch, ...evidence };
    health = new CommandDbClockHealth({ read: async () => ({ ...evidence, issuedAt: new Date() }),
      readEpochContinuity: async () => baseline });
  });
  afterEach(async () => {
    const live = await db.commandPublishEpoch.findUniqueOrThrow({ where: { generation: epoch } });
    const statuses = ["active", "quiescing", "fenced", "retired"] as const;
    for (const status of statuses.slice(statuses.indexOf(live.status) + 1)) {
      await db.commandPublishEpoch.update({ where: { generation: epoch }, data: { status } });
    }
    for (const name of ["COMMAND_SET_EGRESS_ENABLED", "COMMAND_RETENTION_PUBLISH_CUTOFF", "COMMAND_RETENTION_PUBLISH_FENCE"]) {
      if (originalEnv[name] === undefined) delete process.env[name]; else process.env[name] = originalEnv[name];
    }
  });
  afterAll(async () => { await Promise.all([db?.$disconnect(), peer?.$disconnect()]); cluster?.stop(); });

  function publisher(workerId = "worker-a", send: (...args: any[]) => Promise<void> = async () => {}, client = db) {
    const egress = { publish: jest.fn((_generation, topic, payload, authorize) =>
      authorize((expiry: number) => send(_generation, topic, payload, expiry))),
      assertPublisherIdentity: jest.fn(), close: jest.fn(async () => {}) };
    const shared = { publishTopic: jest.fn(async () => {}) };
    const service = new (OutboxPublisherService as any)(client, shared, { workerId }, undefined,
      egress, new CommandPublishEpochService(), health) as OutboxPublisherService;
    return { service, egress, shared };
  }
  async function record(kind: "dimming" | "status_check" = "dimming", workerId = "worker-a", createdAt = new Date()) {
    const org = await db.organization.create({ data: { name: "Permit fixture" } });
    const site = await db.site.create({ data: { organizationId: org.id, name: "Site" } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, name: "Gateway", serialNumber: randomUUID(), firmwareVersion: "test" } });
    const command = await db.command.create({ data: { siteId: site.id, createdAt, clientRequestId: randomUUID(),
      requestFingerprint: "permit", targetType: "fixtures", brightness: 50 } });
    const dispatchId = randomUUID();
    const fixtureId = randomUUID();
    const payload = { commandId: command.id, dispatchId, siteId: site.id, gatewayId: gateway.id,
      idempotencyKey: randomUUID(), sequence: 1, targetFixtureIds: [fixtureId], requestedAt: new Date().toISOString(),
      ...(kind === "dimming" ? { targetType: "fixture", targetId: fixtureId, deliveryMode: "unicast", brightness: 50 }
        : { originalCommandId: command.id, expectedBrightness: 50, verificationAttempt: 1 }) };
    await db.commandDispatch.create({ data: { id: dispatchId, commandId: command.id, gatewayId: gateway.id, kind,
      idempotencyKey: randomUUID(), sequence: 1n, outbox: { create: {
        topic: `sites/${site.id}/gateways/${gateway.id}/commands/${kind === "dimming" ? "dimming" : "status-check"}`,
        payload, lockedBy: workerId, lockedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 30_000)
      } } } });
    return db.mqttOutbox.findUniqueOrThrow({ where: { dispatchId }, include: { dispatch: true } }) as Promise<any>;
  }

  it("commits the exact strict epoch envelope before MQTT and keeps the shared permit until PUBACK", async () => {
    const row = await record();
    const { service, shared } = publisher("worker-a", async (generation, topic, payload) => {
      expect(generation).toBe(epoch);
      expect(topic).toBe(row.topic);
      expect(gatewayDimmingCommandEpochPublishedV2Schema.parse(payload)).toEqual(payload);
      const attempts = await peer.commandPublishAttempt.findMany({ where: { dispatchId: row.dispatchId } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ generation: epoch, workerId: "worker-a", expiresAt: new Date(payload.expiresAt) });
      const [lock] = await peer.$transaction(tx => tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${8052026092501n}) AS acquired`);
      expect(lock.acquired).toBe(false);
    });
    await service.publishClaimed(row);
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).not.toBeNull();
    expect(shared.publishTopic).not.toHaveBeenCalled();
  });

  it("does not claim or prepare any Set after quiesce, including a lease acquired by another worker", async () => {
    const row = await record();
    const leased = await record("dimming", "worker-b");
    await db.mqttOutbox.update({ where: { id: row.id }, data: { lockedBy: null, leaseExpiresAt: null } });
    await db.commandPublishEpoch.update({ where: { generation: epoch }, data: { status: "quiescing" } });
    const first = publisher(), second = publisher("worker-b");
    await expect(first.service.claimBatch()).resolves.toEqual([]);
    await expect(second.service.claimBatch()).resolves.toEqual([]);
    await first.service.publishClaimed(row);
    await second.service.publishClaimed(leased);
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).payload).toEqual(row.payload);
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: leased.id } })).payload).toEqual(leased.payload);
    expect(await db.commandPublishAttempt.count({ where: { generation: epoch } })).toBe(0);
    expect(first.egress.publish).not.toHaveBeenCalled();
    expect(second.egress.publish).not.toHaveBeenCalled();
  });

  it("blocks a restarted publisher with only a live clock sample and no durable epoch baseline", async () => {
    const row = await record();
    health = new CommandDbClockHealth({ read: async () => ({ ...evidence, issuedAt: new Date() }) });
    const { service, egress } = publisher();
    await service.publishClaimed(row);
    expect(egress.publish).not.toHaveBeenCalled();
    expect(await db.commandPublishAttempt.count({ where: { dispatchId: row.dispatchId } })).toBe(0);
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).payload).toEqual(row.payload);
  });

  it("refuses a clock discontinuity after attempt commit while preserving its immutable expiry", async () => {
    const row = await record();
    const baseline = { generation: epoch, ...evidence };
    let reads = 0;
    health = new CommandDbClockHealth({ readEpochContinuity: async () => baseline, read: async () => ({
      ...evidence, issuedAt: new Date(), stepGeneration: ++reads >= 4 ? 1 : 0
    }) });
    const { service, egress } = publisher();
    await service.publishClaimed(row);
    expect(egress.publish).not.toHaveBeenCalled();
    const stored = await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } });
    const attempts = await db.commandPublishAttempt.findMany({ where: { dispatchId: row.dispatchId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].expiresAt).toEqual(new Date((stored.payload as any).expiresAt));
    expect(stored.deliveryAttemptedAt).not.toBeNull();
    expect(stored.publishedAt).toBeNull();
  });

  it("orders two publishers racing an exclusive quiesce behind the in-flight Set", async () => {
    const row = await record();
    const sent = deferred(), complete = deferred();
    const first = publisher("worker-a", async () => { sent.resolve(); await complete.promise; });
    const next = await record("dimming", "worker-b");
    await db.mqttOutbox.update({ where: { id: next.id }, data: { lockedBy: null, leaseExpiresAt: null } });
    const second = publisher("worker-b", undefined, peer);
    const publishing = first.service.publishClaimed(row);
    await sent.promise;
    const quiescing = new CommandPublishQuiesceService(peer as never).begin();
    // Observe the actual exclusive lock wait, rather than relying on a timer.
    for (let i = 0; i < 100; i++) {
      const [waiting] = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      if (waiting.count > 0n) break;
      if (i === 99) throw new Error("exclusive quiesce did not queue");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const claiming = second.service.claimBatch();
    complete.resolve();
    await publishing;
    expect((await quiescing).pendingWorkerIds).toEqual(["worker-a", "worker-b"]);
    expect(await claiming).toEqual([]);
    await second.service.publishClaimed(next);
    expect(second.egress.publish).not.toHaveBeenCalled();
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: next.id } })).payload).toEqual(next.payload);
  });

  it.each(["step", "failover"])("invalidates a prepared Set on a %s and never renews its wire window", async kind => {
    const row = await record();
    let calls = 0;
    const baseline = { generation: epoch, ...evidence };
    health = new CommandDbClockHealth({ readEpochContinuity: async () => baseline, read: async () => {
      if (++calls >= 3) {
        if (kind === "step") evidence.stepGeneration = 1;
        else evidence.failoverGeneration = 1;
      }
      return { ...evidence, issuedAt: new Date() };
    } });
    const { service, egress } = publisher();
    await service.publishClaimed(row);
    const stored = await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(egress.publish).not.toHaveBeenCalled();
    expect(await db.commandPublishAttempt.count({ where: { dispatchId: row.dispatchId } })).toBe(0);
    expect(stored.payload).toHaveProperty("publishEpoch", epoch);
    const originalPayload = stored.payload;
    evidence.clearedStepGeneration = evidence.stepGeneration;
    evidence.clearedFailoverGeneration = evidence.failoverGeneration;
    await db.mqttOutbox.update({ where: { id: row.id }, data: { lockedBy: "worker-a", leaseExpiresAt: new Date(Date.now() + 30_000) } });
    await service.publishClaimed({ ...stored, dispatchId: row.dispatchId, dispatch: row.dispatch });
    expect(egress.publish).not.toHaveBeenCalled();
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).payload).toEqual(originalPayload);
  });

  it.each([false, true])("proves deferred QoS1 safety after DB backend kill requires broker retirement=%s", async retired => {
    const broker = await disposableSetBroker(epoch);
    const row = await record();
    const sent = deferred();
    let backendPid = 0;
    const tracked = new Proxy(db, { get(target, key) {
      if (key === "$transaction") return (work: (tx: any) => Promise<unknown>, options: any) => target.$transaction(async tx => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        backendPid = backend.pid;
        return work(tx);
      }, options);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const deferredClient = broker.client(`command-set-${epoch}`, true);
    let publishError: Error | undefined;
    const { service } = publisher("worker-a", async (_epoch, topic, payload, ttl) => {
      const packet = deferredClient.publishAsync(topic, JSON.stringify(payload), {
        qos: 1, retain: false, properties: { messageExpiryInterval: ttl }
      }).catch(error => { publishError = error; throw error; });
      sent.resolve();
      await packet;
    }, tracked);
    const observer = broker.client("observer");
    const observed: string[] = [];
    const received = deferred();
    let publishing: Promise<void> | undefined;
    try {
      await broker.connected(observer);
      await observer.subscribeAsync(row.topic, { qos: 1 });
      observer.on("message", topic => { observed.push(topic); received.resolve(); });
      publishing = service.publishClaimed(row);
      await sent.promise;
      const [killed] = await peer.$queryRaw<Array<{ killed: boolean }>>`SELECT pg_terminate_backend(${backendPid}::integer) AS killed`;
      expect(killed.killed).toBe(true);
      const result = await new CommandPublishQuiesceService(peer as never).begin();
      expect(result.brokerFenced).toBe(false);
      expect(result.allMembersAcknowledged).toBe(false);
      expect(await peer.commandPublishAttempt.count({ where: { dispatchId: row.dispatchId } })).toBe(1);
      // The DB permit is already gone while MQTT.js still owns the QoS1 packet.
      // Explicit external broker denial is necessary; begin()/close is no proof.
      if (retired) await broker.retire();
      deferredClient.connect();
      await publishing;
      if (retired) {
        expect(publishError?.message).toMatch(/not authorized/i);
        expect(observed).toEqual([]);
      } else {
        await received.promise;
        expect(publishError).toBeUndefined();
        expect(observed).toEqual([row.topic]);
      }
      expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).toBeNull();
      const api = broker.client("api-service");
      await broker.connected(api);
      await expect(api.publishAsync(row.topic.replace("dimming", "status-check"), "{}", { qos: 1 })).resolves.toBeDefined();
    } finally {
      await broker.stop();
      await publishing;
    }
  }, 15_000);

  it("preserves unknown on lost PUBACK with the durable expiry envelope", async () => {
    const row = await record();
    await db.command.update({ where: { id: row.dispatch.commandId }, data: { outcome: "pending" } });
    const { service } = publisher("worker-a", async () => { throw new Error("PUBACK lost"); });
    await service.publishClaimed({ ...row, attempts: 9 });
    expect(await db.commandPublishAttempt.count({ where: { dispatchId: row.dispatchId } })).toBe(1);
    expect((await db.command.findUniqueOrThrow({ where: { id: row.dispatch.commandId } })).outcome).toBe("unknown");
  });

  it.each(["expiry", "clock-step", "permit-backend-kill"])(
    "real Set egress rejects %s incurred while waiting for MQTT connection before native enqueue", async fault => {
      const broker = await disposableSetBroker(epoch);
      const row = await record();
      const client = broker.client(`command-set-${epoch}`, true);
      const initialConnectListeners = client.listenerCount("connect");
      const nativePublish = jest.spyOn(client, "publish");
      let backendPid = 0;
      const tracked = new Proxy(db, { get(target, key) {
        if (key === "$transaction") return (work: (tx: any) => Promise<unknown>, options: any) => target.$transaction(async tx => {
          const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          backendPid = backend.pid;
          return work(tx);
        }, options);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      // Only credential construction is bypassed for this localhost ACL fixture.
      // The production egress class, Prisma transactions and MQTT.js client run.
      const egress = new CommandSetMqttService(db as never);
      Object.assign(egress, { registration: { generation: epoch, workerId: "worker-a", brokerIdentity: `command-set-${epoch}` },
        connection: { url: "fixture-owned-client", options: {} }, client });
      const service = new OutboxPublisherService(tracked as never, { publishTopic: jest.fn() } as never,
        { workerId: "worker-a" }, undefined, egress, new CommandPublishEpochService(), health);
      let publishing: Promise<void> | undefined;
      try {
        publishing = service.publishClaimed(row);
        await until(() => client.listenerCount("connect") > initialConnectListeners);
        if (fault === "expiry") {
          // Keep lease headroom: expiry rejection must not accidentally pass
          // only because the 30s lease has less than 20s remaining.
          await peer.mqttOutbox.update({ where: { id: row.id }, data: { leaseExpiresAt: new Date(Date.now() + 60_000) } });
          await new Promise(resolve => setTimeout(resolve, 10_100));
        }
        if (fault === "clock-step") evidence.stepGeneration = 1;
        if (fault === "permit-backend-kill") {
          const [killed] = await peer.$queryRaw<Array<{ killed: boolean }>>`
            SELECT pg_terminate_backend(${backendPid}::integer) AS killed`;
          expect(killed.killed).toBe(true);
          const [permit] = await peer.$transaction(tx => tx.$queryRaw<Array<{ acquired: boolean }>>`
            SELECT pg_try_advisory_xact_lock(${8052026092501n}) AS acquired`);
          expect(permit.acquired).toBe(true);
        }
        client.connect();
        await publishing;
        expect(nativePublish).not.toHaveBeenCalled();
        const rejected = await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } });
        expect(rejected.publishedAt).toBeNull();
        if (fault === "expiry") expect(rejected.deadLetteredAt).not.toBeNull();
        expect(await db.commandPublishAttempt.count({ where: { dispatchId: row.dispatchId } })).toBe(1);
      } finally {
        if (!(client as any).stream) client.connect();
        await egress.close();
        await publishing;
        await broker.stop();
      }
    }, 25_000);

  it("real Set egress preserves unknown if the permit backend dies after native enqueue before PUBACK resolution", async () => {
    const broker = await disposableSetBroker(epoch);
    const row = await record();
    await db.command.update({ where: { id: row.dispatch.commandId }, data: { outcome: "pending" } });
    const client = broker.client(`command-set-${epoch}`);
    await broker.connected(client);
    const ack = deferred(), release = deferred();
    const nativePublish = client.publish.bind(client);
    jest.spyOn(client, "publish").mockImplementation(((topic: string, payload: string, options: any, callback: any) =>
      nativePublish(topic, payload, options, (error: Error | undefined) => {
        ack.resolve();
        void release.promise.then(() => callback(error));
      })) as any);
    let backendPid = 0;
    const tracked = new Proxy(db, { get(target, key) {
      if (key === "$transaction") return (work: (tx: any) => Promise<unknown>, options: any) => target.$transaction(async tx => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        backendPid = backend.pid;
        return work(tx);
      }, options);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const egress = new CommandSetMqttService(db as never);
    Object.assign(egress, { registration: { generation: epoch, workerId: "worker-a", brokerIdentity: `command-set-${epoch}` },
      connection: { url: "fixture-owned-client", options: {} }, client });
    const service = new OutboxPublisherService(tracked as never, { publishTopic: jest.fn() } as never,
      { workerId: "worker-a" }, undefined, egress, new CommandPublishEpochService(), health);
    const publishing = service.publishClaimed({ ...row, attempts: 9 });
    try {
      await ack.promise;
      await peer.$queryRaw`SELECT pg_terminate_backend(${backendPid}::integer)`;
      release.resolve();
      await publishing;
      expect(client.publish).toHaveBeenCalledTimes(1);
      expect((await db.command.findUniqueOrThrow({ where: { id: row.dispatch.commandId } })).outcome).toBe("unknown");
      expect(await db.commandPublishAttempt.count({ where: { dispatchId: row.dispatchId } })).toBe(1);
    } finally {
      release.resolve();
      await publishing;
      await egress.close();
      await broker.stop();
    }
  }, 15_000);

  it("keeps legacy Get available while Set epoch is quiescing and clock evidence is absent", async () => {
    const row = await record("status_check");
    await db.commandPublishEpoch.update({ where: { generation: epoch }, data: { status: "quiescing" } });
    const shared = { publishTopic: jest.fn(async () => {}) };
    const get = new LegacyStatusCheckPublisherService(db as never, shared as never, { workerId: "worker-a" });
    await get.publishClaimed(row);
    expect(shared.publishTopic).toHaveBeenCalledWith(row.topic, expect.objectContaining({ originalCommandId: row.dispatch.commandId }), expect.anything());
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).publishedAt).not.toBeNull();
  });

  it("applies the original Command rolling cutoff to legacy Get even with a fresh outbox", async () => {
    const row = await record("status_check", "worker-a", new Date("2020-01-01T00:00:00Z"));
    const shared = { publishTopic: jest.fn(async () => {}) };
    await new LegacyStatusCheckPublisherService(db as never, shared as never, { workerId: "worker-a" }).publishClaimed(row);
    expect(shared.publishTopic).not.toHaveBeenCalled();
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: row.id } })).deadLetteredAt).not.toBeNull();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("egress did not reach its connection wait");
}
