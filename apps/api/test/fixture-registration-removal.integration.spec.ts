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
    const deployed = cluster.deploy(url, process.env.FIXTURE_REMOVAL_REVIEW_BASELINE === "1"
      ? "20261016090000_fixture_registration_removal" : "99999999");
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
  async function createOperation(overrides: Record<string, unknown> = {}, tx: Prisma.TransactionClient = db,
    scope = { siteId, floorId, gatewayId, nodeId, fixtureId, deviceUuid }) {
    const { siteId, floorId, gatewayId, nodeId, fixtureId, deviceUuid } = scope;
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
  async function persistTerminal(row: any, terminal: any) {
    const { requestedAt: _r, expiresAt: _e, ...identity } = row.payload;
    const resultHash = canonicalPayloadHash(terminal), now = new Date();
    const ack = { ...identity, commandHash: row.commandHash, eventId: terminal.eventId, resultHash,
      ingestedAt: now.toISOString(), status: "ingested" };
    await db.$transaction(async tx => {
      await tx.fixtureRegistrationRemovalResultEvidence.create({ data: { operationId: row.operationId, siteId: row.siteId,
        eventId: terminal.eventId, terminal, terminalHash: resultHash, applicationAck: ack,
        applicationAckHash: canonicalPayloadHash(ack), receivedAt: now } });
      await tx.fixtureRegistrationRemovalOperation.update({ where: { operationId: row.operationId }, data: {
        status: "gateway_confirmed", result: terminal, resultHash, resultEventId: terminal.eventId, gatewayConfirmedAt: now,
        applicationAck: ack, applicationAckHash: canonicalPayloadHash(ack) } });
    });
    return ack;
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
  async function waitForBlocked(waiter: number, blocker: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT ${blocker}::int=ANY(pg_blocking_pids(${waiter}::int)) AS blocked`;
      if (row.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`connection ${waiter} never waited for ${blocker}`);
  }
  it.each(["metadata-first", "removal-first"])("keeps Site/Fixture metadata and removal lock order safe: %s", async order => {
    let release!: () => void, signalLocked!: () => void, signalSecond!: () => void;
    const resume = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const secondStarted = new Promise<void>(resolve => { signalSecond = resolve; });
    let firstPid = 0, secondPid = 0;
    const scope = { siteId, floorId, gatewayId, fixtureId, meshNodeId: nodeId, deviceUuid };
    // Mirror FixturesService.updateMetadata's Site -> Fixture FOR UPDATE -> UPDATE.
    const metadata = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${siteId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Fixture" WHERE id=${fixtureId} FOR UPDATE`;
    };
    const first = db.$transaction(async tx => {
      [firstPid] = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`).map(row => row.pid);
      if (order === "metadata-first") await metadata(tx);
      else { await lockFixtureRegistrationRemovalDomain(tx, scope); await createOperation({}, tx); }
      signalLocked(); await resume;
      if (order === "metadata-first") await tx.fixture.update({ where: { id: fixtureId }, data: { name: "metadata won" } });
    }, { timeout: 15000 });
    // Attach rejection handlers before forming the deliberately competing wait graph.
    const firstResult = first.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    await Promise.race([locked, first]);
    const later = second.$transaction(async tx => {
      [secondPid] = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`).map(row => row.pid);
      if (order === "metadata-first") await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      signalSecond();
      if (order === "metadata-first") { await lockFixtureRegistrationRemovalDomain(tx, scope); await createOperation({}, tx); }
      else { await metadata(tx); await tx.fixture.update({ where: { id: fixtureId }, data: { name: "must be blocked" } }); }
    }, { timeout: 15000 });
    const laterResult = later.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    try {
      await Promise.race([secondStarted, later]);
      await waitForBlocked(secondPid, firstPid);
    } finally { release(); }
    const results = await Promise.all([firstResult, laterResult]);
    expect(results[0]).toEqual({ ok: true });
    if (order === "metadata-first") expect(results[1]).toEqual({ ok: true });
    else {
      if (results[1].ok) throw new Error("pending removal admitted metadata mutation");
      expect(String(results[1].error)).toContain("removing registration identity is fenced");
    }
    expect(results.map(result => result.ok ? "ok" : String(result.error)).join("\n")).not.toContain("40P01");
    expect(await db.fixtureRegistrationRemovalOperation.count({ where: { fixtureId, status: "pending" } })).toBe(1);
    expect((await db.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).name).toBe(order === "metadata-first" ? "metadata won" : "preserved");
  }, 20000);
  it.each(["heartbeat-first", "removal-first"])("keeps Gateway heartbeat row-lock updates safe: %s", async order => {
    let release!: () => void, signalLocked!: () => void, signalSecond!: () => void;
    const resume = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const secondStarted = new Promise<void>(resolve => { signalSecond = resolve; });
    let firstPid = 0, secondPid = 0;
    const scope = { siteId, floorId, gatewayId, fixtureId, meshNodeId: nodeId, deviceUuid };
    const heartbeat = (tx: Prisma.TransactionClient) => tx.gateway.update({ where: { id: gatewayId },
      data: { lastHeartbeatAt: new Date(), lastHeartbeatSequence: 7n } });
    const first = db.$transaction(async tx => {
      [firstPid] = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`).map(row => row.pid);
      if (order === "heartbeat-first") await tx.$queryRaw`SELECT id FROM "Gateway" WHERE id=${gatewayId} FOR UPDATE`;
      else { await lockFixtureRegistrationRemovalDomain(tx, scope); await createOperation({}, tx); }
      signalLocked(); await resume;
      if (order === "heartbeat-first") await heartbeat(tx);
    }, { timeout: 15000 });
    const firstResult = first.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    await Promise.race([locked, first]);
    const later = second.$transaction(async tx => {
      [secondPid] = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`).map(row => row.pid);
      if (order === "heartbeat-first") await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      signalSecond();
      if (order === "heartbeat-first") { await lockFixtureRegistrationRemovalDomain(tx, scope); await createOperation({}, tx); }
      else { await tx.$queryRaw`SELECT id FROM "Gateway" WHERE id=${gatewayId} FOR UPDATE`; await heartbeat(tx); }
    }, { timeout: 15000 });
    const laterResult = later.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    try { await Promise.race([secondStarted, later]); await waitForBlocked(secondPid, firstPid); }
    finally { release(); }
    expect(await Promise.all([firstResult, laterResult])).toEqual([{ ok: true }, { ok: true }]);
    expect((await db.gateway.findUniqueOrThrow({ where: { id: gatewayId } })).lastHeartbeatSequence).toBe(7n);
    expect(await db.fixtureRegistrationRemovalOperation.count({ where: { fixtureId, status: "pending" } })).toBe(1);
  }, 20000);
  it("retains actual past command/energy FKs and a settled lease through staged DDL", async () => {
    const url = cluster.database();
    const previous = cluster.deploy(url, "20261015000000");
    if (previous.status !== 0) throw new Error(previous.stdout + previous.stderr);
    const legacy = new PrismaClient({ datasourceUrl: url });
    try {
      const org = await legacy.organization.create({ data: { name: "history", type: "customer" } });
      const site = await legacy.site.create({ data: { organizationId: org.id, name: "history" } });
      const floor = await legacy.floor.create({ data: { siteId: site.id, name: "history", level: 1 } });
      const gateway = randomUUID(), node = randomUUID(), fixture = randomUUID(), session = randomUUID();
      const at = new Date("2026-10-01T00:00:00.000Z");
      const hash = canonicalPayloadHash({ past: true });
      // Seed the previous schema using explicit old columns: the new Client's
      // default Fixture/MeshNode/Gateway RETURNING would include missing columns.
      await legacy.$executeRaw`INSERT INTO "Gateway" (id,"siteId",name,"serialNumber","firmwareVersion","assignmentVersion","updatedAt")
        VALUES (${gateway},${site.id},'history',${randomUUID()},'history',1,${at})`;
      await legacy.$executeRaw`INSERT INTO "MeshNode" (id,"gatewayId","deviceUuid","meshAddress","firmwareVersion","vehicleSensorProtocol","updatedAt")
        VALUES (${node},${gateway},'bio:aabbccddeeff','0x0100','history','bio_usb_pulse',${at})`;
      await legacy.$executeRaw`INSERT INTO "Fixture" (id,"floorId","meshNodeId",name,"ratedWatt",x,y,"updatedAt")
        VALUES (${fixture},${floor.id},${node},'history',20,0,0,${at})`;
      const command = await legacy.command.create({ data: { siteId: site.id, clientRequestId: randomUUID(), requestFingerprint: hash, targetType: "fixtures",
        targetFixtureIds: [fixture], brightness: 73, outcome: "applied", status: "acknowledged", createdAt: at } });
      const dispatch = await legacy.commandDispatch.create({ data: { commandId: command.id, gatewayId: gateway,
        idempotencyKey: randomUUID(), sequence: 1n, status: "completed", completedAt: at, destinationAddress: "0x0100",
        fixtureResults: { create: { fixtureId: fixture, status: "succeeded", brightness: 73, occurredAt: at } } } });
      await legacy.energyUsage.create({ data: { fixtureId: fixture, source: "state_based_estimate", period: "2026-10-01", kwh: "1.2345", cost: "123.45", createdAt: at } });
      await legacy.temporaryControlLease.create({ data: { fixtureId: fixture, liveFixtureId: fixture, siteId: site.id,
        gatewayId: gateway, meshNodeId: node, nativeUuid: "aabbccddeeff", logicalAddress: "0x0100" } });
      await legacy.$executeRaw`INSERT INTO "TemporaryControlSession" (id,"siteId","gatewayId","actorId","assignmentVersion","admissionRevision","originSequence","originCommandHash","startedAt","endsAt",brightness,"durationMinutes")
        VALUES (${session},${site.id},${gateway},${randomUUID()},1,0,1,${hash},${at},${new Date(at.getTime()+60000)},60,1)`;
      await legacy.$executeRaw`INSERT INTO "TemporaryControlTarget" ("sessionId","fixtureId","siteId","gatewayId","meshNodeId","nativeUuid","logicalAddress","applyGeneration","releaseGeneration")
        VALUES (${session},${fixture},${site.id},${gateway},${node},'aabbccddeeff','0x0100',1,2)`;
      await legacy.$executeRaw`UPDATE "TemporaryControlSession" SET "sessionRevision"=2,"releaseIntentAt"=${at} WHERE id=${session}`;
      await legacy.$executeRaw`UPDATE "TemporaryControlTarget" SET "resolvedAt"=${at},"unchangedConfirmed"=true WHERE "sessionId"=${session}`;
      await legacy.$executeRaw`UPDATE "TemporaryControlLease" SET "ownerSessionId"=NULL WHERE "fixtureId"=${fixture}`;
      await legacy.$executeRaw`UPDATE "TemporaryControlSession" SET state='cancelled',"terminalAt"=${at} WHERE id=${session}`;
      const snapshot = () => legacy.$queryRaw`SELECT jsonb_build_object(
        'fixture',(SELECT to_jsonb(f)-'retiredAt' FROM "Fixture" f WHERE id=${fixture}),
        'node',(SELECT to_jsonb(n)-'retiredAt' FROM "MeshNode" n WHERE id=${node}),
        'command',(SELECT to_jsonb(c) FROM "Command" c WHERE id=${command.id}),
        'dispatch',(SELECT to_jsonb(d) FROM "CommandDispatch" d WHERE id=${dispatch.id}),
        'result',(SELECT to_jsonb(r) FROM "CommandFixtureResult" r WHERE "dispatchId"=${dispatch.id} AND "fixtureId"=${fixture}),
        'energy',(SELECT to_jsonb(e) FROM "EnergyUsage" e WHERE "fixtureId"=${fixture}),
        'lease',(SELECT to_jsonb(l) FROM "TemporaryControlLease" l WHERE "fixtureId"=${fixture}),
        'session',(SELECT to_jsonb(s) FROM "TemporaryControlSession" s WHERE id=${session}),
        'target',(SELECT to_jsonb(t) FROM "TemporaryControlTarget" t WHERE "sessionId"=${session})
      ) AS value`;
      const before = await snapshot();
      const deployed = cluster.deploy(url);
      if (deployed.status !== 0) throw new Error(deployed.stdout + deployed.stderr);
      expect(await snapshot()).toEqual(before);
      expect(await legacy.commandFixtureResult.findUniqueOrThrow({ where: { dispatchId_fixtureId: { dispatchId: dispatch.id, fixtureId: fixture } },
        include: { fixture: true } })).toMatchObject({ status: "succeeded", fixture: { id: fixture, retiredAt: null } });
      expect(await legacy.energyUsage.findFirstOrThrow({ where: { fixtureId: fixture }, include: { fixture: true } }))
        .toMatchObject({ fixture: { id: fixture, meshNodeId: node } });
      expect(await legacy.temporaryControlLease.findUniqueOrThrow({ where: { fixtureId: fixture }, include: { liveFixture: true } }))
        .toMatchObject({ ownerSessionId: null, lastGeneration: 2n, releaseTombstoneGeneration: 2n, liveFixture: { id: fixture } });
    } finally { await legacy.$disconnect(); }
  }, 60000);
  it.each(["completed", "rejected"])("only actual parent Site deletion cascades %s removal and past history", async status => {
    const org = await db.organization.create({ data: { name: "delete whole site", type: "customer" } });
    const site = await db.site.create({ data: { organizationId: org.id, name: "delete whole site" } });
    const floor = await db.floor.create({ data: { siteId: site.id, name: "delete whole site", level: 1 } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, name: "delete whole site", serialNumber: randomUUID(), firmwareVersion: "test", assignmentVersion: 1 } });
    const node = await db.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid: "bio:aabbccddeeff", meshAddress: "0x0100", firmwareVersion: "test", vehicleSensorProtocol: "bio_usb_pulse" } });
    const fixture = await db.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "delete whole site", ratedWatt: 20, x: 0, y: 0 } });
    const command = await db.command.create({ data: { siteId: site.id, clientRequestId: randomUUID(), requestFingerprint: canonicalPayloadHash({ history: true }),
      targetType: "fixtures", targetFixtureIds: [fixture.id], brightness: 73, outcome: "applied", status: "acknowledged" } });
    const dispatch = await db.commandDispatch.create({ data: { commandId: command.id, gatewayId: gateway.id, idempotencyKey: randomUUID(), sequence: 1n,
      status: "completed", fixtureResults: { create: { fixtureId: fixture.id, status: "succeeded", brightness: 73 } } } });
    await db.energyUsage.create({ data: { fixtureId: fixture.id, source: "state_based_estimate", period: "2026-10-01", kwh: "1.2345", cost: "123.45" } });
    const row = await createOperation({}, db, { siteId: site.id, floorId: floor.id, gatewayId: gateway.id, nodeId: node.id, fixtureId: fixture.id, deviceUuid: node.deviceUuid! });
    if (status === "rejected") {
      await db.fixtureRegistrationRemovalOperation.update({ where: { operationId: row.operationId }, data: { status, errorCode: "SERVER_REJECTED" } });
    } else {
      const terminal = { ...row.payload, commandHash: row.commandHash, eventId: randomUUID(), occurredAt: row.requestedAt.toISOString(), status: "removed", errorCode: null };
      await persistTerminal(row, terminal);
      await db.$transaction(async tx => {
        await tx.meshNode.update({ where: { id: node.id }, data: { retiredAt: new Date(), deviceUuid: null } });
        await tx.fixture.update({ where: { id: fixture.id }, data: { retiredAt: new Date() } });
        await tx.fixtureRegistrationRemovalOperation.update({ where: { operationId: row.operationId }, data: { status, completedAt: new Date() } });
      });
    }
    await expect(db.fixtureRegistrationRemovalOperation.delete({ where: { operationId: row.operationId } })).rejects.toThrow();
    await expect(db.fixture.delete({ where: { id: fixture.id } })).rejects.toThrow();
    await expect(db.meshNode.delete({ where: { id: node.id } })).rejects.toThrow();
    expect(await db.commandFixtureResult.count({ where: { dispatchId: dispatch.id, fixtureId: fixture.id } })).toBe(1);
    expect(await db.energyUsage.count({ where: { fixtureId: fixture.id } })).toBe(1);
    await db.site.delete({ where: { id: site.id } });
    expect(await db.fixtureRegistrationRemovalOperation.count({ where: { operationId: row.operationId } })).toBe(0);
    expect(await db.fixture.count({ where: { id: fixture.id } })).toBe(0);
    expect(await db.meshNode.count({ where: { id: node.id } })).toBe(0);
    expect(await db.command.count({ where: { id: command.id } })).toBe(0);
    expect(await db.commandFixtureResult.count({ where: { dispatchId: dispatch.id } })).toBe(0);
    expect(await db.energyUsage.count({ where: { fixtureId: fixture.id } })).toBe(0);
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
    const ack = await persistTerminal(row, terminal);
    await expect(db.$executeRaw`UPDATE "FixtureRegistrationRemovalOperation" SET "resultHash"=${canonicalPayloadHash({})} WHERE "operationId"=${row.operationId}`).rejects.toThrow();
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
    await persistTerminal(row, result);
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
    await persistTerminal(row, terminal);
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
