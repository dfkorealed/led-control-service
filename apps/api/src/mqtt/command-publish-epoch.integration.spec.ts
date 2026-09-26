import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { CommandPublishEpochService } from "./command-publish-epoch.service";

const enabled = process.env.COMMAND_RETENTION_TEST === "1";

(enabled ? describe : describe.skip)("Command publish epoch on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  const service = new CommandPublishEpochService();
  let generation = 9;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
  }, 30_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  async function activeEpoch() {
    generation += 1;
    await db.$executeRaw`INSERT INTO "CommandPublishEpoch" ("generation") VALUES (${generation})`;
    await db.$executeRaw`INSERT INTO "CommandPublishMember" ("generation", "workerId", "brokerIdentity")
      VALUES (${generation}, 'worker-a', ${`set-epoch-${generation}`})`;
    return generation;
  }
  async function transition(value: number, status: string) {
    await db.$executeRaw`UPDATE "CommandPublishEpoch" SET "status" = ${status}::"CommandPublishEpochStatus"
      WHERE "generation" = ${value}`;
  }
  async function retire(value: number) {
    for (const status of ["quiescing", "fenced", "retired"]) await transition(value, status);
  }
  async function dispatch(kind: "dimming" | "status_check" = "dimming", attempted = false) {
    const org = await db.organization.create({ data: { name: "Epoch test" } });
    const site = await db.site.create({ data: { organizationId: org.id, name: "Disposable" } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, name: "Gateway",
      serialNumber: randomUUID(), firmwareVersion: "test" } });
    const command = await db.command.create({ data: { siteId: site.id, clientRequestId: randomUUID(),
      requestFingerprint: "test", targetType: "fixtures", brightness: 50 } });
    return db.commandDispatch.create({ data: { commandId: command.id, gatewayId: gateway.id,
      kind, idempotencyKey: randomUUID(), sequence: 1n,
      outbox: { create: { topic: `sites/${site.id}/gateways/${gateway.id}/commands/${kind === "dimming" ? "dimming" : "status-check"}`,
        payload: {}, deliveryAttemptedAt: attempted ? new Date() : null } } } });
  }
  async function attempt(value: number, dispatchId: string, expiry = "2026-09-26T12:00:10.000Z") {
    const id = randomUUID();
    await db.$executeRaw`INSERT INTO "CommandPublishAttempt" ("id", "generation", "workerId", "dispatchId", "expiresAt")
      VALUES (${id}, ${value}, 'worker-a', ${dispatchId}, ${new Date(expiry)})`;
    return id;
  }

  it("rejects concurrent active generations, skipped transitions, rollback and reused retired generations", async () => {
    const value = await activeEpoch();
    await expect(service.currentForSet(db)).resolves.toBe(value);
    await expect(db.$executeRaw`INSERT INTO "CommandPublishEpoch" ("generation") VALUES (${value + 1})`).rejects.toThrow();
    await expect(transition(value, "fenced")).rejects.toThrow(/transition/);
    await transition(value, "quiescing");
    await expect(service.currentForSet(db)).rejects.toThrow(/active/);
    await expect(transition(value, "active")).rejects.toThrow(/transition/);
    await transition(value, "fenced");
    await transition(value, "retired");
    await expect(transition(value, "active")).rejects.toThrow(/transition/);
    await expect(db.$executeRaw`DELETE FROM "CommandPublishEpoch" WHERE "generation" = ${value}`).rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO "CommandPublishEpoch" ("generation") VALUES (0)`).rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO "CommandPublishEpoch" ("generation") VALUES (${value - 1})`).rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO "CommandPublishEpoch" ("generation", "status")
      VALUES (${value + 1}, 'retired')`).rejects.toThrow();
    const rows = await db.$queryRaw<Array<{ quiescingAt: Date; fencedAt: Date; retiredAt: Date }>>`
      SELECT "quiescingAt", "fencedAt", "retiredAt" FROM "CommandPublishEpoch" WHERE "generation" = ${value}`;
    expect(rows[0].quiescingAt).toBeInstanceOf(Date);
    expect(rows[0].fencedAt).toBeInstanceOf(Date);
    expect(rows[0].retiredAt).toBeInstanceOf(Date);
  });

  it("refuses Set envelopes without a dimming dispatch, registered member or active generation", async () => {
    const value = await activeEpoch();
    const get = await dispatch("status_check");
    const set = await dispatch();
    await expect(attempt(value, get.id)).rejects.toThrow(/dimming/);
    await expect(attempt(value, randomUUID())).rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO "CommandPublishAttempt" ("id", "generation", "workerId", "dispatchId", "expiresAt")
      VALUES (${randomUUID()}, ${value}, 'unregistered', ${set.id}, CURRENT_TIMESTAMP + INTERVAL '10 seconds')`).rejects.toThrow();
    await transition(value, "quiescing");
    await expect(attempt(value, set.id)).rejects.toThrow(/active/);
    await transition(value, "fenced");
    await transition(value, "retired");
  });

  it("includes every attempted Set expiry despite missing PUBACK or a terminal dispatch result", async () => {
    await db.$executeRawUnsafe("SET TIME ZONE 'Asia/Seoul'");
    const value = await activeEpoch();
    const first = await dispatch("dimming", true);
    const second = await dispatch("dimming", true);
    await attempt(value, first.id, "2026-09-26T12:00:10.000Z");
    await attempt(value, first.id, "2026-09-26T12:00:12.000Z");
    await attempt(value, second.id, "2026-09-26T12:00:20.000Z");
    await db.commandDispatch.update({ where: { id: second.id }, data: { status: "completed", completedAt: new Date() } });
    await expect(service.maxUnsettledExpiry(db, value)).resolves.toEqual(new Date("2026-09-26T12:00:20.000Z"));
    await db.$executeRawUnsafe("SET TIME ZONE 'UTC'");
    await expect(service.maxUnsettledExpiry(db, value)).resolves.toEqual(new Date("2026-09-26T12:00:20.000Z"));
    await retire(value);
  });

  it("fails closed for an attempted legacy Set even when its mutable outbox claims a known expiry", async () => {
    const value = await activeEpoch();
    const legacy = await dispatch("dimming", true);
    await expect(service.maxUnsettledExpiry(db, value)).rejects.toThrow(/envelope/);
    await db.mqttOutbox.update({ where: { dispatchId: legacy.id }, data: {
      payload: { epoch: value, expiresAt: "2026-09-26T12:00:10.000Z" } } });
    await expect(service.maxUnsettledExpiry(db, value)).rejects.toThrow(/envelope/);
    // Removing this disposable legacy fixture cannot manufacture evidence for real traffic.
    await db.command.delete({ where: { id: legacy.commandId } });
    await retire(value);
  });

  it("returns no expiry for an empty generation and does not gate legacy Get traffic", async () => {
    const value = await activeEpoch();
    await dispatch("status_check", true);
    await expect(service.maxUnsettledExpiry(db, value)).resolves.toBeNull();
    await expect(service.maxUnsettledExpiry(db, value + 50)).rejects.toThrow(/generation/);
    await retire(value);
  });

  it("keeps envelopes immutable and blocks deleting their raw Set before protected cleanup", async () => {
    const value = await activeEpoch();
    const set = await dispatch();
    const id = await attempt(value, set.id);
    await expect(db.$executeRaw`UPDATE "CommandPublishAttempt" SET "expiresAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}`).rejects.toThrow();
    await expect(db.commandDispatch.update({ where: { id: set.id }, data: { kind: "status_check" } })).rejects.toThrow();
    await expect(db.command.delete({ where: { id: set.commandId } })).rejects.toThrow();
    await expect(db.$executeRaw`DELETE FROM "CommandPublishAttempt" WHERE "id" = ${id}`).rejects.toThrow();
    await retire(value);
  });

  it("denies runtime epoch transitions, evidence writes and destructive envelope privileges", async () => {
    const value = await activeEpoch();
    async function runtime(statement: string) {
      return db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE command_set_publisher");
        return tx.$executeRawUnsafe(statement);
      });
    }
    await expect(runtime(`UPDATE "CommandPublishEpoch" SET status='quiescing' WHERE generation=${value}`)).rejects.toThrow(/permission denied/);
    await expect(runtime('DELETE FROM "CommandPublishAttempt"')).rejects.toThrow(/permission denied/);
    await expect(runtime('TRUNCATE "CommandPublishAttempt"')).rejects.toThrow(/permission denied/);
    await expect(runtime(`INSERT INTO "CommandPurgeBarrierEvidence" ("id", "generation", "workerId", "brokerDigest", "gatewayDigest", "clockDigest", "signature", "keyVersion")
      VALUES ('forged',${value},'runtime','x','x','x','x',1)`)).rejects.toThrow(/permission denied/);
    await retire(value);
  });

  it("allows the least-privilege publisher to register, record an attempt and acknowledge quiesce", async () => {
    const value = await activeEpoch();
    const set = await dispatch();
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE command_set_publisher");
      await expect(service.currentForSet(tx)).resolves.toBe(value);
      await tx.$executeRaw`INSERT INTO "CommandPublishMember" ("generation", "workerId", "brokerIdentity")
        VALUES (${value}, 'runtime-worker', ${`set-epoch-${value}`})`;
      await tx.$executeRaw`INSERT INTO "CommandPublishAttempt" ("id", "generation", "workerId", "dispatchId", "expiresAt")
        VALUES (${randomUUID()}, ${value}, 'runtime-worker', ${set.id}, ${new Date("2026-09-26T12:00:15Z")})`;
    });
    await transition(value, "quiescing");
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE command_set_publisher");
      await tx.$executeRaw`UPDATE "CommandPublishMember" SET "quiesceAckAt" = CURRENT_TIMESTAMP
        WHERE "generation" = ${value} AND "workerId" = 'runtime-worker'`;
    });
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE command_publish_retention");
      await expect(service.maxUnsettledExpiry(tx, value)).resolves.toEqual(new Date("2026-09-26T12:00:15Z"));
    });
    await transition(value, "fenced");
    await transition(value, "retired");
  });

  it("deploys independently of optional retention cutovers without provisioning an active epoch", async () => {
    const url = cluster.database();
    const deployed = cluster.deploy(url, "20260925115999");
    expect(deployed.status).toBe(0);
    const migration = readFileSync(join(__dirname, "../../prisma/migrations/20260926100000_command_publish_epoch/migration.sql"), "utf8");
    cluster.sql(url, migration);
    expect(cluster.sql(url, 'SELECT count(*) FROM "CommandPublishEpoch"')).toBe("0");
  }, 30_000);
});
