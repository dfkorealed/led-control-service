import { CommandOutcome, Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { CommandDetailRetentionService } from "./command-detail-retention.service";

const enabled = process.env.COMMAND_DETAIL_RETENTION_TEST === "1";
(enabled ? describe : describe.skip)("bounded detail worker on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let siteId: string;
  let gatewayId: string;
  let sequence = 0n;
  let log: jest.SpyInstance;
  const oldFlag = process.env.COMMAND_DETAIL_REDACTION_ENABLED;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  }, 40_000);
  beforeEach(async () => {
    process.env.COMMAND_DETAIL_REDACTION_ENABLED = "1";
    // A fresh site isolates attribution checks; prior rows are already redacted
    // or deferred, and each test finishes its own remaining eligible commands.
    const org = await db.organization.create({ data: { name: "worker test" } });
    siteId = (await db.site.create({ data: { organizationId: org.id, name: "test" } })).id;
    gatewayId = (await db.gateway.create({ data: { siteId, name: "test", serialNumber: randomUUID(), firmwareVersion: "test" } })).id;
  });
  afterAll(async () => {
    await db?.$disconnect(); cluster?.stop();
    log?.mockRestore();
    if (oldFlag === undefined) delete process.env.COMMAND_DETAIL_REDACTION_ENABLED;
    else process.env.COMMAND_DETAIL_REDACTION_ENABLED = oldFlag;
  });
  const worker = (client: unknown = db) => new CommandDetailRetentionService(client as never);
  async function seed(createdAt = new Date("2000-01-01T00:00:00Z"), outcome: CommandOutcome = "applied") {
    const command = await db.command.create({ data: { siteId, clientRequestId: randomUUID(),
      requestFingerprint: "private", targetType: "fixtures", targetFixtureIds: [], brightness: 42,
      status: "acknowledged", outcome, createdAt } });
    await db.commandDispatch.create({ data: { commandId: command.id, gatewayId, sequence: ++sequence,
      idempotencyKey: randomUUID(), status: "completed", completedAt: createdAt,
      outbox: { create: { topic: "never-publish", payload: { brightness: 42 }, publishedAt: createdAt } } } });
    return command;
  }
  it("converges over 1,001 commands, retains parent identities and is idempotent", async () => {
    for (let i = 0; i < 1001; i++) await seed();
    let redacted = 0;
    for (let i = 0; i < 11; i++) {
      const result = await worker().runBatch();
      expect(result.examined).toBeLessThanOrEqual(100);
      redacted += result.redacted;
    }
    expect(redacted).toBe(1001);
    expect(await db.command.count({ where: { siteId, contentRedactedAt: { not: null } } })).toBe(1001);
    expect(await db.commandDispatch.count({ where: { command: { siteId } } })).toBe(1001);
    expect(await db.mqttOutbox.count({ where: { dispatch: { command: { siteId } } } })).toBe(0);
    expect(await worker().runBatch()).toMatchObject({ examined: 0, redacted: 0, overdueCount: 0 });
  }, 120_000);
  it("defers 100 older blockers so a later eligible command cannot starve", async () => {
    for (let i = 0; i < 100; i++) await seed(new Date("1999-01-01Z"), "unknown");
    const later = await seed();
    expect(await worker().runBatch()).toMatchObject({ examined: 100, redacted: 0,
      skippedByReason: { command_unresolved: 100 }, overdueCount: 101 });
    expect(await worker().runBatch()).toMatchObject({ examined: 1, redacted: 1, overdueCount: 100 });
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ overdueCount: 100,
      blockedByReason: { command_unresolved: 100 }, oldestAgeSeconds: expect.any(Number) }));
    expect(log.mock.calls.at(-1)![0].oldestAgeSeconds).toBeGreaterThan(86_400_000);
    expect((await db.command.findUniqueOrThrow({ where: { id: later.id } })).contentRedactedAt).not.toBeNull();
    const attempts = await db.commandRetentionAttempt.findMany({ where: { command: { siteId } } });
    expect(attempts).toHaveLength(100);
    expect(attempts.every(row => row.reasonCode === "detail_command_unresolved" && row.retryAfterAt > row.lastTriedAt)).toBe(true);
  }, 30_000);
  it("records legacy attribution blockers and retries after backoff expires", async () => {
    const command = await seed();
    const ledger = await db.processedGatewayEvent.create({ data: { eventId: randomUUID(), gatewayId,
      eventType: "device_status_ack", sequence: ++sequence, payloadHash: `sha256:${"a".repeat(64)}`, occurredAt: new Date() } });
    expect(await worker().runBatch()).toMatchObject({ redacted: 0,
      skippedByReason: { legacy_ack_attribution_unverifiable: 1 } });
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({
      blockedByReason: expect.objectContaining({ legacy_ack_attribution_unverifiable: 1 }) }));
    expect((await db.command.findUniqueOrThrow({ where: { id: command.id } })).brightness).toBe(42);
    await db.processedGatewayEvent.delete({ where: { eventId: ledger.eventId } });
    await db.commandRetentionAttempt.update({ where: { commandId: command.id }, data: { retryAfterAt: new Date("2000-01-01Z") } });
    expect(await worker().runBatch()).toMatchObject({ redacted: 1 });
    expect(await db.commandRetentionAttempt.findUnique({ where: { commandId: command.id } })).toBeNull();
  });
  it("skips a Command locked by another transaction and later redacts it exactly once", async () => {
    const command = await seed();
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Command" WHERE "id" = ${command.id} FOR UPDATE`;
      locked(); await gate;
    });
    await ready;
    try { expect(await worker().runBatch()).toMatchObject({ examined: 0, redacted: 0 }); }
    finally { release(); await holding; }
    const results = await Promise.all([worker().runBatch(), worker().runBatch()]);
    expect(results.reduce((sum, result) => sum + result.redacted, 0)).toBe(1);
    expect((await db.command.findUniqueOrThrow({ where: { id: command.id } })).contentRedactedAt).not.toBeNull();
  });
  it("rolls back earlier activity removal when a later safety check blocks", async () => {
    const command = await seed();
    const floor = await db.floor.create({ data: { siteId, name: "test", level: 1 } });
    const activity = await db.monitoringActivity.create({ data: { siteId, floorId: floor.id, sourceType: "command",
      sourceKey: `${command.id}:applied`, kind: "command_result", commandOutcome: "applied" } });
    const job = await db.gatewayRecommissionJob.create({ data: { siteId, gatewayId, inventoryId: randomUUID(),
      serialNumber: "test", resetDigest: "test", status: "prepared", targetSnapshot: {}, objectKeys: [] } });
    expect(await worker().runBatch()).toMatchObject({ redacted: 0, skippedByReason: { recommission_job_active: 1 } });
    expect(await db.monitoringActivity.findUnique({ where: { id: activity.id } })).not.toBeNull();
    expect((await db.command.findUniqueOrThrow({ where: { id: command.id } })).brightness).toBe(42);
    await db.gatewayRecommissionJob.delete({ where: { id: job.id } });
  });
  it("rolls back SQL failure after outbox removal and records only a sanitized reason", async () => {
    const command = await seed();
    await db.$executeRawUnsafe(`CREATE FUNCTION test_detail_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'private raw detail must not be logged'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER test_detail_failure BEFORE UPDATE ON "Command"
      FOR EACH ROW WHEN (NEW."contentRedactedAt" IS NOT NULL) EXECUTE FUNCTION test_detail_failure()`);
    try {
      expect(await worker().runBatch()).toMatchObject({ examined: 1, redacted: 0,
        skippedByReason: { raw_copy_cleanup_failed: 1 } });
      expect((await db.command.findUniqueOrThrow({ where: { id: command.id } })).brightness).toBe(42);
      expect(await db.mqttOutbox.count({ where: { dispatch: { commandId: command.id } } })).toBe(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private raw detail");
      const attempt = await db.commandRetentionAttempt.findUniqueOrThrow({ where: { commandId: command.id } });
      expect(attempt.reasonCode).toBe("detail_raw_copy_cleanup_failed");
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_detail_failure ON "Command"');
      await db.$executeRawUnsafe("DROP FUNCTION test_detail_failure()");
    }
  });
  it.each(["UTC", "Asia/Seoul", "America/New_York"])("uses DB calendar months and retains exact leap-day cutoff in %s", async zone => {
    const before = await seed(new Date("2024-02-29T12:00:00.122Z"));
    const exact = await seed(new Date("2024-02-29T12:00:00.123Z"));
    const after = await seed(new Date("2024-02-29T12:00:00.124Z"));
    // Test-only database clock adapter: execute the actual worker SQL on PG
    // with a fixed DB timestamp, never a production/API-host clock injection.
    const frozen = (target: any): any => new Proxy(target, { get(object, key) {
      if (key === "$transaction") return (fn: (tx: unknown) => unknown) => db.$transaction(async tx => {
        await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
        return fn(frozen(tx));
      });
      if (key === "$queryRaw" || key === "$executeRaw") return (sql: Prisma.Sql) => object[key](Prisma.sql(
        sql.strings.map(part => part.replaceAll("transaction_timestamp()", "TIMESTAMPTZ '2024-05-31 12:00:00.123+00'")) as unknown as TemplateStringsArray, ...sql.values));
      const value = object[key]; return typeof value === "function" ? value.bind(object) : value;
    } });
    await worker(frozen(db)).runBatch();
    expect((await db.command.findUniqueOrThrow({ where: { id: before.id } })).contentRedactedAt).not.toBeNull();
    for (const id of [exact.id, after.id]) expect((await db.command.findUniqueOrThrow({ where: { id } })).contentRedactedAt).toBeNull();
    // Finish these now-expired real-clock fixtures before the next test.
    await worker().runBatch();
  });
});
