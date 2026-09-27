import { GoneException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import type { AuthenticatedUser } from "../auth/auth.types";
import { inspectCommandHistoryReadiness } from "./command-history-rollout";
import { CommandStatusService } from "./command-status.service";

const enabled = process.env.COMMAND_HISTORY_DB_CLOCK_TEST === "1";

(enabled ? describe : describe.skip)("Command GET DB-clock boundary on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let siteId: string;
  let service: CommandStatusService;
  const user: AuthenticatedUser = { id: randomUUID(), organizationId: randomUUID(), organizationType: "customer",
    loginId: "clock-reader", name: "Clock reader", role: "admin", status: "active", mustChangePassword: false };

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
    const organization = await db.organization.create({ data: { name: "Command DB-clock test" } });
    const site = await db.site.create({ data: { organizationId: organization.id, name: "Clock site" } });
    siteId = site.id;
    service = new CommandStatusService(db as never, { assert: jest.fn().mockResolvedValue(site) } as never);
  }, 40_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    await db.command.deleteMany({ where: { siteId } });
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
  });
  afterEach(() => {
    delete process.env.COMMAND_HISTORY_RETENTION_ENABLED;
    delete process.env.COMMAND_RECOVERY_ACTIONS_ENABLED;
    delete process.env.COMMAND_RECOVERY_PUBLISHER_READY;
  });

  async function dbBoundary() {
    const [clock] = await db.$queryRaw<Array<{ generatedAt: Date; retainedFrom: Date }>>`
      SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS "generatedAt",
        (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months' AS "retainedFrom"`;
    return clock;
  }

  async function insertCommand(createdAt: Date, outcome: "applied" | "unknown" | "pending") {
    return db.command.create({ data: { siteId, clientRequestId: randomUUID(), requestFingerprint: randomUUID(),
      targetType: "fixtures", targetFixtureIds: [], brightness: 30, status: "acknowledged", outcome, createdAt } });
  }

  it("uses DB time rather than fast/slow API host time for list, detail, cursor and metadata", async () => {
    await db.$executeRawUnsafe(`SET TIME ZONE 'UTC'`);
    const clock = await dbBoundary();
    const fresh = await insertCommand(new Date(clock.retainedFrom.getTime() + 30_000), "applied");
    const expired = await insertCommand(new Date(clock.retainedFrom.getTime() - 30_000), "applied");
    const fastHost = new Date(clock.generatedAt.getTime() + 60_000);
    const slowHost = new Date(clock.generatedAt.getTime() - 60_000);
    for (const hostNow of [fastHost, slowHost]) {
      const list = await service.listCommands(user, { siteId }, hostNow);
      expect(list.items.map((item) => item.id)).toEqual([fresh.id]);
      expect(Math.abs(new Date(list.generatedAt!).getTime() - clock.generatedAt.getTime())).toBeLessThan(10_000);
      expect(Math.abs(new Date(list.generatedAt!).getTime() - hostNow.getTime())).toBeGreaterThan(30_000);
      expect(Math.abs(new Date(list.retainedFrom!).getTime() - clock.retainedFrom.getTime())).toBeLessThan(10_000);
      const detail = await service.getCommand(user, fresh.id, hostNow);
      expect(detail).toMatchObject({ id: fresh.id, generatedAt: expect.any(String), retainedFrom: expect.any(String) });
      expect(Math.abs(Date.parse((detail as any).generatedAt) - clock.generatedAt.getTime())).toBeLessThan(10_000);
      await expect(service.getCommand(user, expired.id, hostNow)).rejects.toBeInstanceOf(GoneException);
    }
    const expiredCursor = Buffer.from(JSON.stringify({ id: expired.id, createdAt: expired.createdAt.toISOString() })).toString("base64url");
    await expect(service.listCommands(user, { siteId, cursor: expiredCursor }, slowHost)).rejects.toMatchObject({
      response: { code: "command_history_cursor_expired" }, status: 400
    });
  });

  it("exposes DB anchors with rollout OFF while preserving old unresolved detail and history", async () => {
    delete process.env.COMMAND_HISTORY_RETENTION_ENABLED;
    const clock = await dbBoundary();
    const old = await insertCommand(new Date("2020-01-01T00:00:00Z"), "unknown");
    const detail = await service.getCommand(user, old.id, new Date("1900-01-01"));
    expect(detail).toMatchObject({ id: old.id, retentionEnabled: false, brightness: 30, generatedAt: expect.any(String) });
    expect(Math.abs(Date.parse(detail.generatedAt!) - clock.generatedAt.getTime())).toBeLessThan(10_000);
    expect(await service.listCommands(user, { siteId })).toMatchObject({ retentionEnabled: false, items: [{ id: old.id }] });
  });

  it.each(["UTC", "Asia/Seoul", "America/New_York"])(
    "compares an unheld row against the UTC TIMESTAMP cutoff in DB session %s", async (zone) => {
      await db.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
      const clock = await dbBoundary();
      const fresh = await insertCommand(new Date(clock.retainedFrom.getTime() + 30_000), "unknown");
      const list = await service.listCommands(user, { siteId }, new Date(clock.generatedAt.getTime() + 60_000));
      expect(list.generatedAt).toEqual(expect.any(String));
      expect(list.items.map((item) => item.id)).toContain(fresh.id);
      const expired = await insertCommand(new Date(clock.retainedFrom.getTime() - 30_000), "unknown");
      const retained = await service.listCommands(user, { siteId }, new Date(clock.generatedAt.getTime() - 60_000));
      expect(retained.generatedAt).toEqual(expect.any(String));
      expect(retained.items.map((item) => item.id)).toEqual([fresh.id]);
      await expect(service.getCommand(user, expired.id)).rejects.toBeInstanceOf(GoneException);
    }
  );

  it("preflight rejects old unheld pending and unknown rows and passes after removal", async () => {
    const clock = await dbBoundary();
    const old = await insertCommand(new Date(clock.retainedFrom.getTime() - 30_000), "unknown");
    const pending = await insertCommand(new Date(clock.retainedFrom.getTime() - 30_000), "pending");
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return inspectCommandHistoryReadiness(tx);
    })).rejects.toThrow("unheld old commands: 2");
    await db.command.delete({ where: { id: old.id } });
    await db.command.delete({ where: { id: pending.id } });
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return inspectCommandHistoryReadiness(tx);
    })).resolves.toMatchObject({ unheldCount: 0, sampleIds: [] });
  });
});
