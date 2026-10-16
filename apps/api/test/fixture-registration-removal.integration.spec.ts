import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPayloadHash } from "../src/automation/automation-payload-hash";
import { disposablePostgres } from "./support/disposable-postgres";
import { activeFixtureRegistrationWhere, assertFixtureRegistrationsActive, lockFixtureRegistrationRemovalDomain } from "../src/fixtures/fixture-registration-removal-policy";

const enabled = process.env.FIXTURE_REMOVAL_DISPOSABLE_POSTGRES === "1";
(enabled ? describe : describe.skip)("fixture registration removal database foundation", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>, db: PrismaClient, second: PrismaClient;
  let siteId: string, floorId: string, gatewayId: string, nodeId: string, fixtureId: string, deviceUuid: string;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const previous = cluster.deploy(url, "20261015000000");
    if (previous.status !== 0) throw new Error(previous.stdout + previous.stderr);
    db = new PrismaClient({ datasourceUrl: url }); second = new PrismaClient({ datasourceUrl: url });
    const org = await db.organization.create({ data: { name: "preserved", type: "customer" } });
    const site = await db.site.create({ data: { organizationId: org.id, name: "preserved" } });
    siteId = site.id;
    floorId = (await db.floor.create({ data: { siteId, name: "B1", level: -1 } })).id;
    gatewayId = randomUUID();
    await db.$executeRaw`INSERT INTO "Gateway" (id,"siteId",name,"serialNumber","firmwareVersion","assignmentVersion","updatedAt")
      VALUES (${gatewayId},${siteId},'GW',${randomUUID()},'test',1,CURRENT_TIMESTAMP)`;
    const deployed = cluster.deploy(url);
    if (deployed.status !== 0) {
      // Prisma's transaction-aborted summary may hide the first DDL error.
      cluster.sql(url, readFileSync(join(__dirname, "../prisma/migrations/20261016090000_fixture_registration_removal/migration.sql"), "utf8"));
      throw new Error(deployed.stdout + deployed.stderr);
    }
    console.info("fixture removal staged migration:", deployed.status,
      cluster.sql(url, 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'));
  }, 60_000);
  afterAll(async () => { await db?.$disconnect(); await second?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    deviceUuid = `bio:${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const address = `0x${(256 + ++sequence).toString(16).padStart(4, "0")}`;
    nodeId = (await db.meshNode.create({ data: { gatewayId, deviceUuid, meshAddress: address,
      firmwareVersion: "test", vehicleSensorProtocol: "bio_usb_pulse" } })).id;
    fixtureId = (await db.fixture.create({ data: { floorId, meshNodeId: nodeId, name: "preserved", ratedWatt: 20, x: 0, y: 0 } })).id;
  });
  let sequence = 0;
  async function createOperation(overrides: Record<string, unknown> = {}, tx: Prisma.TransactionClient = db) {
    await tx.$executeRaw`UPDATE "Gateway" SET "fixtureRegistrationRemovalVersion"=1 WHERE id=${gatewayId}`;
    const node = await tx.meshNode.findUniqueOrThrow({ where: { id: nodeId } });
    const gateway = await tx.gateway.findUniqueOrThrow({ where: { id: gatewayId } });
    const fixture = await tx.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
    const operationId = randomUUID(), requestedAt = new Date(), expiresAt = new Date(requestedAt.getTime() + 30_000);
    const bindingSnapshot = { version: 1, siteId, fixtureId, gatewayId, gatewaySerial: gateway.serialNumber,
      assignmentVersion: 1, nodeId: fixtureId, deviceUuid, meshAddress: node.meshAddress, originalProvisionCommandId: randomUUID() };
    const bindingHash = canonicalPayloadHash(bindingSnapshot);
    const payload = { ...bindingSnapshot, operationId, bindingHash, requestedAt: requestedAt.toISOString(), expiresAt: expiresAt.toISOString() };
    const { version: _version, ...columns } = bindingSnapshot;
    const data = { operationId, ...columns, floorId, meshNodeId: nodeId, fixtureName: fixture.name, serialNumber: node.serialNumber,
      requestedById: randomUUID(), clientRequestId: randomUUID(), expectedUpdatedAt: fixture.updatedAt,
      requestHash: canonicalPayloadHash({ fixtureId, expectedUpdatedAt: fixture.updatedAt.toISOString() }),
      bindingSnapshot, bindingHash, payload, commandHash: canonicalPayloadHash(payload), requestedAt, expiresAt, ...overrides };
    await tx.fixtureRegistrationRemovalOperation.create({ data: data as Prisma.FixtureRegistrationRemovalOperationUncheckedCreateInput });
    return data;
  }
  async function operation(operationId: string) {
    const rows = await db.$queryRaw<any[]>`SELECT * FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=${operationId}`;
    return rows[0];
  }
  async function createGroup() {
    const node = await db.meshNode.create({ data: { gatewayId, meshAddress: `0x${(256 + ++sequence).toString(16).padStart(4, "0")}`, firmwareVersion: "test" } });
    const anchor = await db.fixture.create({ data: { floorId, meshNodeId: node.id, name: "anchor", ratedWatt: 20, x: 0, y: 0 } });
    return db.fixtureGroup.create({ data: { siteId, floorId, gatewayId, name: randomUUID(), groupFixtures: { create: { fixtureId: anchor.id } } } });
  }
  it("adds fail-closed capability and null retirement without rewriting previous data", async () => {
    const rows = await db.$queryRaw<any[]>`SELECT f."retiredAt", g."fixtureRegistrationRemovalVersion", f.name
      FROM "Fixture" f JOIN "Gateway" g ON g.id=f."gatewayId" WHERE f.id=${fixtureId}`;
    expect(rows).toEqual([{ retiredAt: null, fixtureRegistrationRemovalVersion: 0, name: "preserved" }]);
    await expect(db.$executeRaw`UPDATE "Gateway" SET "fixtureRegistrationRemovalVersion"=2 WHERE id=${gatewayId}`).rejects.toThrow();
  });
  it("persists a retryable operation and prevents duplicate request and active fixture", async () => {
    const first = await createOperation(); const row = await operation(first.operationId);
    expect(row).toMatchObject({ status: "pending", attempts: 0, ackAttempts: 0, result: null, applicationAck: null, lockedBy: null });
    await expect(createOperation()).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "payload"='{}' WHERE "operationId"=${first.operationId}`).rejects.toThrow();
    await expect(db.$executeRaw`DELETE FROM "FixtureRegistrationRemovalOperation" WHERE "operationId"=${first.operationId}`).rejects.toThrow();
    await db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='rejected', "errorCode"='SERVER_REJECTED' WHERE "operationId"=${first.operationId}`;
    await expect(createOperation({ requestedById: first.requestedById, clientRequestId: first.clientRequestId })).rejects.toThrow();
    await expect(createOperation()).resolves.toBeDefined();
  });
  it("requires exact terminal and ACK identity and preserves accepted evidence", async () => {
    const row = await createOperation();
    const terminal = { ...row.payload, eventId: randomUUID(), commandHash: row.commandHash,
      occurredAt: row.requestedAt.toISOString(), status: "removed", errorCode: null };
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='completed', "completedAt"=now()
      WHERE "operationId"=${row.operationId}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='gateway_confirmed', result=${JSON.stringify({ ...terminal, commandHash: canonicalPayloadHash({}) })}::jsonb,
      "resultHash"=${canonicalPayloadHash(terminal)}, "resultEventId"=${terminal.eventId}, "gatewayConfirmedAt"=now() WHERE "operationId"=${row.operationId}`).rejects.toThrow();
    await db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='gateway_confirmed', result=${JSON.stringify(terminal)}::jsonb,
      "resultHash"=${canonicalPayloadHash(terminal)}, "resultEventId"=${terminal.eventId}, "gatewayConfirmedAt"=now() WHERE "operationId"=${row.operationId}`;
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "resultHash"=${canonicalPayloadHash({})} WHERE "operationId"=${row.operationId}`).rejects.toThrow();
    const { requestedAt: _r, expiresAt: _e, ...identity } = row.payload;
    const ack = { ...identity, commandHash: row.commandHash, eventId: terminal.eventId, resultHash: canonicalPayloadHash(terminal),
      ingestedAt: new Date().toISOString(), status: "ingested" };
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "applicationAck"=${JSON.stringify({ ...ack, eventId: randomUUID() })}::jsonb,
      "applicationAckHash"=${canonicalPayloadHash(ack)} WHERE "operationId"=${row.operationId}`).rejects.toThrow();
    await db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "applicationAck"=${JSON.stringify(ack)}::jsonb,
      "applicationAckHash"=${canonicalPayloadHash(ack)} WHERE "operationId"=${row.operationId}`;
    expect((await operation(row.operationId)).applicationAck).toEqual(ack);
  });
  it("pins cleanup convergence once without changing the wire command", async () => {
    const row = await createOperation();
    const cleanup = { catalog: { assignmentVersion: 1, revision: 2, payloadHash: canonicalPayloadHash({ catalog: 2 }) },
      groups: [{ id: randomUUID(), configurationVersion: 3, desiredHash: canonicalPayloadHash([]) }] };
    await db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "cleanupSnapshot"=${JSON.stringify(cleanup)}::jsonb WHERE "operationId"=${row.operationId}`;
    expect((await operation(row.operationId)).cleanupSnapshot).toEqual(cleanup);
    expect((await operation(row.operationId)).payload).toEqual(row.payload);
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "cleanupSnapshot"='{}' WHERE "operationId"=${row.operationId}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "cleanupSnapshot"=NULL WHERE "operationId"=${row.operationId}`).rejects.toThrow();
  });
  it("does not allow malformed cleanup, terminal-on-pending or partial retirement", async () => {
    const row = await createOperation();
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "cleanupSnapshot"='{}' WHERE "operationId"=${row.operationId}`).rejects.toThrow();
    await expect(db.fixture.update({ where: { id: fixtureId }, data: { retiredAt: new Date() } })).rejects.toThrow();
    const result = { ...row.payload, commandHash: row.commandHash, eventId: randomUUID(), occurredAt: row.requestedAt.toISOString(), status: "removed", errorCode: null };
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET result=${JSON.stringify(result)}::jsonb,
      "resultEventId"=${result.eventId}, "resultHash"=${canonicalPayloadHash(result)} WHERE "operationId"=${row.operationId}`).rejects.toThrow();
    await db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='gateway_confirmed', result=${JSON.stringify(result)}::jsonb,
      "resultEventId"=${result.eventId}, "resultHash"=${canonicalPayloadHash(result)}, "gatewayConfirmedAt"=CURRENT_TIMESTAMP WHERE "operationId"=${row.operationId}`;
    await expect(db.meshNode.update({ where: { id: nodeId }, data: { retiredAt: new Date(), deviceUuid: null } })).rejects.toThrow();
    await expect(db.$transaction(async tx => {
      await tx.meshNode.update({ where: { id: nodeId }, data: { retiredAt: new Date(), deviceUuid: null, meshAddress: "0x7777" } });
      await tx.fixture.update({ where: { id: fixtureId }, data: { retiredAt: new Date() } });
      await tx.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='completed', "completedAt"=CURRENT_TIMESTAMP WHERE "operationId"=${row.operationId}`;
    })).rejects.toThrow();
  });
  it("blocks pending/uncertain new membership, sensor work and identity reuse", async () => {
    const row = await createOperation();
    const group = await createGroup();
    const insert = () => db.groupFixture.create({ data: { groupId: group.id, fixtureId } });
    await expect(insert()).rejects.toThrow();
    await expect(db.$executeRaw`SELECT assert_fixture_registration_active(${fixtureId})`).rejects.toThrow();
    await expect(db.meshNode.update({ where: { id: nodeId }, data: { deviceUuid: null } })).rejects.toThrow();
    await db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='reconcile_required', "errorCode"='DELIVERY_UNCERTAIN' WHERE "operationId"=${row.operationId}`;
    await expect(insert()).rejects.toThrow();
    await db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='rejected', "errorCode"='NO_MUTATION_CONFIRMED' WHERE "operationId"=${row.operationId}`;
    await expect(insert()).resolves.toBeDefined();
  });
  it("retirement preserves snapshot/address/history and only releases operating UUID", async () => {
    const row = await createOperation();
    const terminal = { ...row.payload, eventId: randomUUID(), commandHash: row.commandHash,
      occurredAt: row.requestedAt.toISOString(), status: "removed", errorCode: null };
    await db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='gateway_confirmed', result=${JSON.stringify(terminal)}::jsonb,
      "resultHash"=${canonicalPayloadHash(terminal)}, "resultEventId"=${terminal.eventId}, "gatewayConfirmedAt"=now() WHERE "operationId"=${row.operationId}`;
    await db.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "MeshNode" SET "retiredAt"=CURRENT_TIMESTAMP, "deviceUuid"=NULL WHERE id=${nodeId}`;
      await tx.$executeRaw`UPDATE "Fixture" SET "retiredAt"=CURRENT_TIMESTAMP WHERE id=${fixtureId}`;
      await tx.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET status='completed', "completedAt"=CURRENT_TIMESTAMP WHERE "operationId"=${row.operationId}`;
    });
    expect((await operation(row.operationId)).bindingSnapshot).toEqual(row.bindingSnapshot);
    expect(await db.meshNode.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ deviceUuid: null, meshAddress: row.meshAddress });
    await expect(db.meshNode.create({ data: { gatewayId, deviceUuid, meshAddress: "0x7000", firmwareVersion: "test" } })).resolves.toBeDefined();
    await expect(db.fixture.update({ where: { id: fixtureId }, data: { retiredAt: null } } as any)).rejects.toThrow();
    await expect(db.fixture.delete({ where: { id: fixtureId } })).rejects.toThrow();
    await expect(db.$executeRaw`SELECT assert_fixture_registration_active(${fixtureId})`).rejects.toThrow();
  });
  it("serializes deletion admission with DB-only membership producers", async () => {
    const group = await createGroup();
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const first = db.$transaction(async tx => {
      await lockFixtureRegistrationRemovalDomain(tx, { siteId, floorId, gatewayId, fixtureId, meshNodeId: nodeId, deviceUuid });
      await assertFixtureRegistrationsActive(tx, [fixtureId, fixtureId]);
      await createOperation({}, tx); ready(); await resume;
    });
    await Promise.race([held, first]);
    let settled = false;
    const insertion = second.groupFixture.create({ data: { groupId: group.id, fixtureId } }).then(
      () => { settled = true; return "admitted"; }, () => { settled = true; return "blocked"; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false); release();
    await first; expect(await insertion).toBe("blocked");
    expect(await db.fixture.findFirst({ where: { id: fixtureId, ...activeFixtureRegistrationWhere } })).toBeNull();
  });
});
