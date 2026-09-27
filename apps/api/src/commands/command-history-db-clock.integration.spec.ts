import { GoneException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import type { AuthenticatedUser } from "../auth/auth.types";
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
    process.env.COMMAND_RECOVERY_ACTIONS_ENABLED = "1";
    process.env.COMMAND_RECOVERY_PUBLISHER_READY = "1";
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

  async function insertCommand(createdAt: Date, outcome: "applied" | "unknown") {
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
      await expect(service.getCommand(user, fresh.id, hostNow)).resolves.toMatchObject({ id: fresh.id });
      await expect(service.getCommand(user, expired.id, hostNow)).rejects.toBeInstanceOf(GoneException);
    }
    const expiredCursor = Buffer.from(JSON.stringify({ id: expired.id, createdAt: expired.createdAt.toISOString() })).toString("base64url");
    await expect(service.listCommands(user, { siteId, cursor: expiredCursor }, slowHost)).rejects.toMatchObject({
      response: { code: "command_history_cursor_expired" }, status: 400
    });
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
      const legacy = await service.listCommands(user, { siteId }, new Date(clock.generatedAt.getTime() - 60_000));
      expect(legacy.generatedAt).toBeUndefined();
      expect(legacy.items.map((item) => item.id)).toContain(expired.id);
    }
  );
});
