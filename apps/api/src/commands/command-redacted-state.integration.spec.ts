import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { CommandsService } from "./commands.service";
import { CommandDispatchService } from "./command-dispatch.service";
import { CommandStatusService } from "./command-status.service";
import { CommandVerificationService } from "./command-verification.service";
import { MqttService } from "../mqtt/mqtt.service";

const enabled = process.env.COMMAND_REDACTION_TEST === "1";
(enabled ? describe : describe.skip)("Command redacted state on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let siteId: string;
  let organizationId: string;
  let gatewayId: string;
  let fixtureId: string;
  const access = { assert: jest.fn(), assertControlInTransaction: jest.fn() };
  // The specific site/key guard must work even without the broader automation mutex.
  const automation = { lockMutation: jest.fn() };
  const userId = randomUUID();
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    const org = await db.organization.create({ data: { name: "Redaction test" } });
    organizationId = org.id;
    siteId = (await db.site.create({ data: { organizationId, name: "Site" } })).id;
    gatewayId = (await db.gateway.create({ data: { siteId, name: "Gateway", serialNumber: randomUUID(), firmwareVersion: "test", lastHeartbeatAt: new Date() } })).id;
    const floor = await db.floor.create({ data: { siteId, name: "Floor", level: 1 } });
    const node = await db.meshNode.create({ data: { gatewayId, deviceUuid: randomUUID(), meshAddress: "0x0100", firmwareVersion: "test" } });
    fixtureId = (await db.fixture.create({ data: { siteId, floorId: floor.id, gatewayId, meshNodeId: node.id,
      name: "Light", ratedWatt: 40, x: 1, y: 1, status: "online" } })).id;
    await db.user.create({ data: { id: userId, organizationId, name: "Operator", loginId: randomUUID(), passwordHash: "unused", role: "admin" } });
  }, 40_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  function commandData(requestedBy: string | null = userId) {
    return { siteId, requestedBy, clientRequestId: randomUUID(), requestFingerprint: "private fingerprint",
      targetType: "fixtures", targetFixtureIds: [randomUUID()], brightness: 70, outcome: "applied" as const };
  }
  function service() {
    // Preserve compatibility with the shared checkout's uncommitted HMAC injection.
    return Reflect.construct(CommandsService, [db, new CommandDispatchService(), access, {},
      automation, { now: () => new Date() }, {}]) as CommandsService;
  }
  function retry(command: { clientRequestId: string }) {
    return service().createDimmingCommand({ id: userId } as never, { siteId, clientRequestId: command.clientRequestId,
      target: { type: "fixture", fixtureId }, brightness: 70 });
  }
  async function redact(id: string) {
    await db.$executeRaw`UPDATE "Command" SET "contentRedactedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
      "requestFingerprint" = NULL, "targetType" = NULL, "targetId" = NULL,
      "targetFixtureIds" = NULL, "brightness" = NULL, "errorMessage" = NULL WHERE "id" = ${id}`;
  }

  it("rejects half-redacted INSERT and UPDATE while allowing a complete atomic transition", async () => {
    const original = await db.command.create({ data: commandData() });
    await expect(db.$executeRaw`UPDATE "Command" SET "brightness" = NULL WHERE "id" = ${original.id}`)
      .rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "Command" SET "contentRedactedAt" = CURRENT_TIMESTAMP WHERE "id" = ${original.id}`)
      .rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO "Command" ("id", "siteId", "clientRequestId", "updatedAt", "contentRedactedAt", "brightness")
      VALUES (${randomUUID()}, ${siteId}, ${randomUUID()}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 70)`)
      .rejects.toThrow();
    await expect(redact(original.id)).resolves.toBeUndefined();
    const row = await db.command.findUniqueOrThrow({ where: { id: original.id } });
    expect(row).toMatchObject({ requestFingerprint: null, targetType: null, targetFixtureIds: null, brightness: null });
    await expect(db.$executeRaw`UPDATE "Command" SET "errorMessage" = 'restored' WHERE "id" = ${original.id}`)
      .rejects.toThrow();
  });

  it("rejects a redacted replay without a Set or outbox and omits it from history with flags off", async () => {
    const original = await db.command.create({ data: commandData() });
    await redact(original.id);
    await expect(retry(original)).rejects.toMatchObject({ status: 409, response: { code: "command_request_expired" } });
    expect(await db.command.count({ where: { clientRequestId: original.clientRequestId } })).toBe(1);
    expect(await db.mqttOutbox.count()).toBe(0);
    const history = new CommandStatusService(db as never, access as never);
    expect((await history.listCommands({ id: userId } as never, { siteId })).items.map((row) => row.id))
      .not.toContain(original.id);
  });

  it("rejects two concurrent orphan-key retries after deletion without relying on HMAC", async () => {
    const owner = await db.user.create({ data: { organizationId, name: "Deleted", loginId: randomUUID(), passwordHash: "unused", role: "admin" } });
    const original = await db.command.create({ data: commandData(owner.id) });
    await db.user.delete({ where: { id: owner.id } });
    const results = await Promise.allSettled([retry(original), retry(original)]);
    for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: {
      status: 409, response: { code: "command_request_expired" } } });
    expect(await db.command.count({ where: { clientRequestId: original.clientRequestId } })).toBe(1);
    expect(await db.mqttOutbox.count()).toBe(0);
  });

  it("serves payload-free expired HTTP contracts for retained redacted identities", async () => {
    const original = await db.command.create({ data: commandData() });
    await redact(original.id);
    const { Test } = await import("@nestjs/testing");
    const { AuthService } = await import("../auth/auth.service");
    const { CommandsController } = await import("./commands.controller");
    const { CommandRecoveryService } = await import("./command-recovery.service");
    const module = await Test.createTestingModule({ controllers: [CommandsController], providers: [
      { provide: AuthService, useValue: { getUserBySessionToken: async () => ({ id: userId }) } },
      { provide: CommandsService, useValue: service() },
      { provide: CommandStatusService, useValue: new CommandStatusService(db as never, access as never) },
      { provide: CommandVerificationService, useValue: new CommandVerificationService(db as never,
        access as never, automation as never, { now: () => new Date() }) },
      { provide: CommandRecoveryService, useValue: {} }
    ] }).compile();
    const app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    try {
      const baseUrl = await app.getUrl();
      const headers = { Cookie: "led_session=test", "Content-Type": "application/json" };
      const detail = await fetch(`${baseUrl}/commands/${original.id}`, { headers });
      expect(detail.status).toBe(410);
      expect(await detail.json()).toEqual({ code: "command_expired" });
      const get = await fetch(`${baseUrl}/commands/${original.id}/status-checks`, {
        method: "POST", headers, body: JSON.stringify({ clientRequestId: randomUUID() })
      });
      expect(get.status).toBe(410);
      expect(await get.json()).toEqual({ code: "command_expired" });
      const set = await fetch(`${baseUrl}/commands/dimming`, { method: "POST", headers,
        body: JSON.stringify({ siteId, clientRequestId: original.clientRequestId,
          target: { type: "fixture", fixtureId }, brightness: 70 }) });
      expect(set.status).toBe(409);
      expect(await set.json()).toEqual({ code: "command_request_expired" });
      expect(await db.mqttOutbox.count()).toBe(0);
    } finally { await app.close(); }
  });

  it("consumes late acceptance and result ACKs without recreating detailed rows or raw ledger", async () => {
    const original = await db.command.create({ data: commandData() });
    const dispatch = await db.commandDispatch.create({ data: { commandId: original.id, gatewayId,
      idempotencyKey: randomUUID(), sequence: 1n, status: "published" } });
    await db.gateway.update({ where: { id: gatewayId }, data: { nextCommandSequence: 1n } });
    await redact(original.id);
    const mqtt = new MqttService(db as never, {} as never, undefined, undefined, undefined, automation as never);
    const ack = { commandId: original.id, dispatchId: dispatch.id, gatewayId, siteId,
      idempotencyKey: dispatch.idempotencyKey, sequence: 1, acceptedAt: new Date().toISOString() };
    await (mqtt as any).storeAcceptanceAck({ ...ack, status: "accepted", errorMessage: "private ACK" });
    await (mqtt as any).storeAcceptanceAck({ ...ack, status: "rejected", errorMessage: "private ACK" });
    await (mqtt as any).storeDeviceStatusAck({ ...ack, eventId: randomUUID(), status: "failed",
      occurredAt: new Date().toISOString(), results: [] });
    expect(await db.commandDispatch.findUniqueOrThrow({ where: { id: dispatch.id } }))
      .toMatchObject({ status: "published", errorMessage: null });
    expect(await db.commandFixtureResult.count()).toBe(0);
    expect(await db.processedGatewayEvent.count()).toBe(0);
    expect(await db.command.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ brightness: null, errorMessage: null });
  });

  it("waits for an in-flight User deletion then sees the orphan instead of publishing a Set", async () => {
    const owner = await db.user.create({ data: { organizationId, name: "Deleting", loginId: randomUUID(), passwordHash: "unused", role: "admin" } });
    const original = await db.command.create({ data: commandData(owner.id) });
    let release!: () => void;
    let locked!: () => void;
    const deletionReady = new Promise<void>((resolve) => { locked = resolve; });
    const deletionRelease = new Promise<void>((resolve) => { release = resolve; });
    const deletion = db.$transaction(async (tx) => {
      await tx.user.delete({ where: { id: owner.id } });
      locked();
      await deletionRelease;
    }, { timeout: 10_000 });
    await deletionReady;
    const attempted = Promise.allSettled([retry(original), retry(original)]);
    try {
      const deadline = Date.now() + 5_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND query LIKE '%SELECT "requestedBy" FROM "Command"%'
            AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`;
        if (rows[0].blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); await deletion; }
    const results = await attempted;
    for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: {
      status: 409, response: { code: "command_request_expired" } } });
    expect(await db.command.count({ where: { clientRequestId: original.clientRequestId } })).toBe(1);
    expect(await db.mqttOutbox.count()).toBe(0);
  });

  it("still creates a complete normal Set and hides internal replay identifiers from its response", async () => {
    const clientRequestId = randomUUID();
    const response = await retry({ clientRequestId });
    expect(response).toMatchObject({ brightness: 70, targetType: "fixture", selectedTargetCount: 1 });
    expect(response).not.toHaveProperty("clientRequestId");
    expect(response).not.toHaveProperty("requestedBy");
    expect(response).not.toHaveProperty("requestFingerprint");
    const stored = await db.command.findUniqueOrThrow({ where: { id: response.id } });
    expect(stored).toMatchObject({ clientRequestId, requestedBy: userId, targetFixtureIds: [fixtureId], brightness: 70 });
    expect(await db.mqttOutbox.count({ where: { dispatch: { commandId: response.id } } })).toBe(1);
  });
});
