import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID, createHash } from "node:crypto";
import { disposablePostgres } from "./support/disposable-postgres";
import { SiteAccessService } from "../src/access/site-access.service";
import { CommandDbClockHealth } from "../src/mqtt/command-db-clock-health.service";
import type { AuthenticatedUser } from "../src/auth/auth.types";
import { bioRegistrationRevalidationCanonicalJson } from "@led-control/shared";
import { canonicalPayloadHash } from "../src/automation/automation-payload-hash";

const enabled = process.env.BIO_REGISTRATION_REVALIDATION_DISPOSABLE_POSTGRES === "1";
(enabled ? describe : describe.skip)("BIO registration revalidation schema/create/get", () => {
  jest.setTimeout(60_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient; let service: any; let user: AuthenticatedUser;
  let ids: Record<string, string>;
  const hash = (value: unknown) => `sha256:${createHash("sha256").update(bioRegistrationRevalidationCanonicalJson(value)).digest("hex")}`;
  const request = () => ({ siteId: ids.site, gatewayId: ids.gateway, fixtureId: ids.fixture,
    expectedAssignmentVersion: 2, clientRequestId: randomUUID() });
  const operations = () => (db as any).bioRegistrationRevalidationOperation;
  let clock: CommandDbClockHealth;
  beforeAll(async () => {
    cluster = await disposablePostgres(); const url = cluster.database();
    const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(deployed.stderr + deployed.stdout);
    console.info("BIO revalidation disposable migration deploy exit=0");
    cluster.sql(url, `ALTER DATABASE "${new URL(url).pathname.slice(1)}" SET TimeZone TO 'Asia/Seoul'`);
    db = new PrismaClient({ datasourceUrl: url });
    const { BioRegistrationRevalidationService } = require("../src/registration/bio-registration-revalidation.service");
    // Synthetic evidence exists only in this self-owned DB test, never in DI.
    clock = new CommandDbClockHealth({ read: async () => {
      const [row] = await db.$queryRaw<any[]>`SELECT clock_timestamp() AS now, pg_postmaster_start_time() AS started,
        inet_server_addr()::text AS address, inet_server_port() AS port`;
      return { issuedAt: row.now, offsetMs: 0, stepGeneration: 0, clearedStepGeneration: 0,
        failoverGeneration: 0, clearedFailoverGeneration: 0,
        primary: { startedAt: row.started, address: row.address, port: row.port } };
    } });
    service = new BioRegistrationRevalidationService(db, new SiteAccessService(db as never), clock);
  });
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  async function seedRegisteredGraph({ status = "discovered", fixtureNodeIdsDiffer = true } = {}) {
    ids = Object.fromEntries(["org", "actor", "site", "floor", "gateway", "inventory", "cert", "fixture", "node", "session", "command"].map(key => [key, randomUUID()]));
    if (!fixtureNodeIdsDiffer) ids.node = ids.fixture;
    const now = new Date();
    await db.organization.create({ data: { id: ids.org, name: ids.org, type: "customer" } });
    await db.user.create({ data: { id: ids.actor, organizationId: ids.org, name: "Disposable", loginId: ids.actor, passwordHash: "test-only", role: "admin" } });
    user = { id: ids.actor, organizationId: ids.org, organizationType: "customer", loginId: ids.actor,
      name: "Disposable", role: "admin", status: "active", mustChangePassword: false };
    await db.site.create({ data: { id: ids.site, organizationId: ids.org, adminUserId: ids.actor, name: ids.site } });
    await db.floor.create({ data: { id: ids.floor, siteId: ids.site, name: "B1", level: -1 } });
    await db.gateway.create({ data: { id: ids.gateway, siteId: ids.site, name: ids.gateway, serialNumber: ids.gateway, firmwareVersion: "test", claimedAt: now, assignmentVersion: 2 } });
    await db.gatewayInventory.create({ data: { id: ids.inventory, serialNumber: ids.inventory, claimedGatewayId: ids.gateway, claimedAt: now } });
    await db.gatewayCertificate.create({ data: { id: ids.cert, inventoryId: ids.inventory, gatewayId: ids.gateway,
      purpose: "mqtt", certificateSerial: ids.cert, fingerprint: ids.cert, issuer: "test-only", status: "active",
      notBefore: new Date(now.getTime() - 60_000), notAfter: new Date(now.getTime() + 600_000) } });
    await db.provisioningSession.create({ data: { id: ids.session, siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway,
      requestedBy: ids.actor, scanStatus: "completed" } });
    await db.discoveredMeshNode.create({ data: { id: ids.fixture, sessionId: ids.session, deviceUuid: "bio:aabbccddeeff",
      serialNumber: "test-only", rssi: -60, oobCapability: "none", firmwareVersion: "test", status: status as never,
      identifyState: "confirmed", meshAddress: "0x0100" } });
    await db.meshNode.create({ data: { id: ids.node, gatewayId: ids.gateway, deviceUuid: "bio:aabbccddeeff",
      meshAddress: "0x0100", firmwareVersion: "test" } });
    await db.fixture.create({ data: { id: ids.fixture, meshNodeId: ids.node, floorId: ids.floor,
      name: "B", ratedWatt: 40, x: 12, y: 25, brightness: 35, powerOn: true } });
    await db.fixtureGroup.create({ data: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway, name: "Preserved group",
      groupFixtures: { create: { fixtureId: ids.fixture } } } });
    await db.command.create({ data: { siteId: ids.site, requestedBy: ids.actor, clientRequestId: randomUUID(),
      requestFingerprint: `sha256:${"a".repeat(64)}`, targetFixtureIds: [ids.fixture],
      targetType: "fixture", targetId: ids.fixture, brightness: 35 } });
    await db.provisioningDeviceOutbox.create({ data: { id: ids.command, sessionId: ids.session, nodeId: ids.fixture,
      topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/provisioning/provision-device`, publishedAt: now,
      payload: { siteId: ids.site, gatewayId: ids.gateway, commandId: ids.command, sessionId: ids.session,
        nodeId: ids.fixture, deviceUuid: "bio:aabbccddeeff", meshAddress: "0x0100", requestedAt: now.toISOString() } } });
  }
  beforeEach(async () => {
    // Cleanup is limited to this helper's private disposable database.
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    await db.auditLog.deleteMany();
    await seedRegisteredGraph();
  });
  async function readProtectedFixtureState() {
    return { fixture: await db.fixture.findUnique({ where: { id: ids.fixture } }), node: await db.meshNode.findUnique({ where: { id: ids.node } }),
      candidate: await db.discoveredMeshNode.findUnique({ where: { id: ids.fixture } }),
      commands: await db.provisioningDeviceOutbox.findMany({ where: { sessionId: ids.session } }),
      controlCommands: await db.command.findMany({ where: { siteId: ids.site } }),
      session: await db.provisioningSession.findUnique({ where: { id: ids.session } }),
      groups: await db.fixtureGroup.findMany({ where: { siteId: ids.site }, include: { groupFixtures: true } }),
      ledger: await db.processedGatewayEvent.findMany({ where: { gatewayId: ids.gateway } }),
      audits: await db.auditLog.findMany({ where: { siteId: ids.site } }) };
  }
  it("create stores immutable query, exact distinct node binding and fixed UTC deadlines while preserving graph/output", async () => {
    const before = await readProtectedFixtureState(); const input = request();
    const created = await service.create(user, input); const row = await operations().findUniqueOrThrow({ where: { commandId: created.commandId } });
    expect(created).toMatchObject({ status: "pending", observedMode: null, appliedAt: null });
    expect(row.expiresAt.getTime() - row.requestedAt.getTime()).toBe(30_000);
    expect(row.applyDeadlineAt.getTime() - row.requestedAt.getTime()).toBe(120_000);
    expect(row.payload).toMatchObject({ purpose: "bio_registration_revalidation", operation: "query", fixtureId: ids.fixture, nodeId: ids.node });
    expect(row.bindingSnapshot).toMatchObject({ originalProvisionCommandId: ids.command, nodeId: ids.node });
    expect(row.payloadHash).toBe(hash(row.payload)); expect(row.bindingHash).toBe(hash(row.bindingSnapshot));
    expect(await service.create(user, input)).toEqual(created);
    expect(await service.get(user, created.commandId)).toEqual(created);
    expect(await readProtectedFixtureState()).toEqual(before);
    expect(JSON.stringify(created)).not.toMatch(/bio:|payload|binding|certificate|deviceIdentityHash/);
  });
  it("create supersedes only unconsumed operations and retains retry deadlines", async () => {
    const input = request(); const first = await service.create(user, input);
    const second = await service.create(user, request());
    expect(second.commandId).not.toBe(first.commandId);
    expect((await service.create(user, input)).commandId).toBe(first.commandId);
    expect((await operations().findUniqueOrThrow({ where: { commandId: first.commandId } })).supersededAt).not.toBeNull();
    await expect(service.create(user, { ...input, fixtureId: randomUUID() })).rejects.toThrow();
  });
  it.each(["actor", "site", "role", "assignment", "expired", "not-started", "revoked", "disabled", "unclaimed", "address", "native", "confirmed", "identify", "command-scope", "busy"])("create rejects current %s mismatch", async reason => {
    const input = request(); let actor = user;
    if (reason === "actor") actor = { ...user, id: randomUUID() };
    if (reason === "site") input.siteId = randomUUID();
    if (reason === "role") actor = { ...user, role: "operator" };
    if (reason === "assignment") input.expectedAssignmentVersion++;
    if (reason === "expired") await db.gatewayCertificate.update({ where: { id: ids.cert }, data: { notAfter: new Date(0) } });
    if (reason === "not-started") await db.gatewayCertificate.update({ where: { id: ids.cert }, data: { notBefore: new Date(Date.now() + 60_000) } });
    if (reason === "revoked") await db.gatewayCertificate.update({ where: { id: ids.cert }, data: { revokedAt: new Date() } });
    if (reason === "disabled") await db.gatewayInventory.update({ where: { id: ids.inventory }, data: { disabledAt: new Date() } });
    if (reason === "unclaimed") await db.gateway.update({ where: { id: ids.gateway }, data: { claimedAt: null } });
    if (reason === "address") await db.meshNode.update({ where: { id: ids.node }, data: { meshAddress: "0x0101" } });
    if (reason === "native") await db.meshNode.update({ where: { id: ids.node }, data: { deviceUuid: "bio:000000000001" } });
    if (reason === "confirmed") await db.discoveredMeshNode.update({ where: { id: ids.fixture }, data: { identifyState: "idle" } });
    if (reason === "busy") await db.discoveredMeshNode.update({ where: { id: ids.fixture }, data: { status: "provisioning" } });
    if (reason === "identify" || reason === "command-scope") {
      const cmd = await db.provisioningDeviceOutbox.findUniqueOrThrow({ where: { id: ids.command } });
      await db.provisioningDeviceOutbox.update({ where: { id: ids.command }, data: { payload: { ...(cmd.payload as object),
        ...(reason === "identify" ? { operation: "identify" } : { siteId: randomUUID() }) } } });
    }
    const before = await readProtectedFixtureState();
    await expect(service.create(actor, input)).rejects.toThrow();
    expect(await operations().count({ where: { siteId: ids.site } })).toBe(0);
    expect(await readProtectedFixtureState()).toEqual(before);
  });
  it("create refuses a production clock without attestor", async () => {
    const { BioRegistrationRevalidationService } = require("../src/registration/bio-registration-revalidation.service");
    await expect(new BioRegistrationRevalidationService(db, new SiteAccessService(db as never), new CommandDbClockHealth()).create(user, request())).rejects.toThrow("clock");
  });
  it("get and create retry reauthorize requester and current binding", async () => {
    const input = request(); const created = await service.create(user, input);
    await expect(service.get({ ...user, id: randomUUID() }, created.commandId)).rejects.toThrow();
    await db.gateway.update({ where: { id: ids.gateway }, data: { assignmentVersion: 3 } });
    await expect(service.get(user, created.commandId)).rejects.toThrow();
    await expect(service.create(user, input)).rejects.toThrow();
  });
  async function addReceipt() {
    const eventId = randomUUID();
    const payload = { siteId: ids.site, gatewayId: ids.gateway, sessionId: ids.session, nodeId: ids.fixture,
      commandId: ids.command, deviceUuid: "bio:aabbccddeeff", meshAddress: "0x0100", eventId, sequence: 3,
      ingestedAt: new Date().toISOString() };
    await db.processedGatewayEvent.create({ data: { eventId, gatewayId: ids.gateway, eventType: "provisioning_device_terminal",
      sequence: 3n, payloadHash: `sha256:${"a".repeat(64)}`, occurredAt: new Date() } });
    return db.mqttOutbox.create({ data: { gatewayId: ids.gateway,
      applicationAckKey: `provisioning-device-terminal:${ids.gateway}:${ids.command}`,
      topic: `sites/${ids.site}/gateways/${ids.gateway}/acks/provisioning/device-terminal-ingested`,
      payload, payloadHash: canonicalPayloadHash(payload) } });
  }
  it.each(["exact", "ack-hash", "ack-scope", "ledger-missing", "ledger-sequence"])("create checks preserved receipt/ledger %s", async reason => {
    const receipt = await addReceipt(); const eventId = (receipt.payload as any).eventId;
    if (reason === "ack-hash") await db.mqttOutbox.update({ where: { id: receipt.id }, data: { payloadHash: `sha256:${"f".repeat(64)}` } });
    if (reason === "ack-scope") {
      const payload = { ...(receipt.payload as object), nodeId: randomUUID() };
      await db.mqttOutbox.update({ where: { id: receipt.id }, data: { payload, payloadHash: canonicalPayloadHash(payload) } });
    }
    if (reason === "ledger-missing") await db.processedGatewayEvent.delete({ where: { eventId } });
    if (reason === "ledger-sequence") await db.processedGatewayEvent.update({ where: { eventId }, data: { sequence: 4n } });
    const before = await readProtectedFixtureState();
    if (reason === "exact") await expect(service.create(user, request())).resolves.toMatchObject({ status: "pending" });
    else await expect(service.create(user, request())).rejects.toThrow();
    expect(await readProtectedFixtureState()).toEqual(before);
  });
  async function persistObserved(commandId: string) {
    const row = await operations().findUniqueOrThrow({ where: { commandId } });
    const { requestedAt: _requested, expiresAt: _expires, ...identity } = row.payload;
    const acceptedAt = new Date(row.requestedAt.getTime() + 10);
    const result = { ...identity, eventId: randomUUID(), sequence: 1, occurredAt: row.requestedAt.toISOString(),
      status: "observed", evidence: "mode_get", observedMode: "force-off" };
    await operations().update({ where: { commandId }, data: { status: "observed", result,
      resultHash: hash(result), resultEventId: result.eventId, proofAcceptedAt: acceptedAt } });
    return { row, result, acceptedAt };
  }
  async function pendingResult(mode = "force-off") {
    const created = await service.create(user, request());
    const row = await operations().findUniqueOrThrow({ where: { commandId: created.commandId } });
    const { requestedAt: _requested, expiresAt: _expires, ...identity } = row.payload;
    return { row, result: { ...identity, eventId: randomUUID(), sequence: 7, occurredAt: row.requestedAt.toISOString(),
      status: "observed", evidence: "mode_get", observedMode: mode },
      topic: `sites/${ids.site}/gateways/${ids.gateway}/events/bio-registration-revalidation-result` };
  }
  async function observedOperation() {
    const pending = await pendingResult();
    await service.ingest(pending.topic, pending.result, new Date(pending.row.requestedAt.getTime() + 10));
    return pending.row.commandId;
  }
  function classification() {
    const { BioClassificationReconciliationService } = require("../src/registration/bio-classification-reconciliation.service");
    const { AuditService } = require("../src/audit/audit.service");
    return new BioClassificationReconciliationService(db, new SiteAccessService(db as never), new AuditService(db), { now: () => new Date() });
  }
  const classificationRequest = (fixtureIds = [ids.fixture]) => ({ siteId: ids.site, gatewayId: ids.gateway,
    expectedAssignmentVersion: 2, fixtureIds, requestId: randomUUID() });
  async function trackRepairWrites() {
    await db.$executeRawUnsafe('CREATE TABLE "BioRepairWriteTest" (kind text NOT NULL)');
    await db.$executeRawUnsafe(`CREATE FUNCTION count_repair_writes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_TABLE_NAME = 'AuditLog' THEN
        IF NEW.action='bio_registration_current_revalidated' THEN INSERT INTO "BioRepairWriteTest" VALUES (TG_TABLE_NAME); END IF;
      ELSE INSERT INTO "BioRepairWriteTest" VALUES (TG_TABLE_NAME); END IF; RETURN NEW; END $$`);
    for (const table of ["DiscoveredMeshNode", "BioRegistrationRevalidationOperation", "AuditLog"]) {
      await db.$executeRawUnsafe(`CREATE TRIGGER count_repair_writes BEFORE ${table === "AuditLog" ? "INSERT" : "UPDATE"}
        ON "${table}" FOR EACH ROW EXECUTE FUNCTION count_repair_writes()`);
    }
    return {
      counts: () => db.$queryRaw<Array<{ kind: string; count: number }>>`SELECT kind, count(*)::int AS count FROM "BioRepairWriteTest" GROUP BY kind ORDER BY kind`,
      async stop() {
        for (const table of ["DiscoveredMeshNode", "BioRegistrationRevalidationOperation", "AuditLog"]) {
          await db.$executeRawUnsafe(`DROP TRIGGER count_repair_writes ON "${table}"`);
        }
        await db.$executeRawUnsafe('DROP FUNCTION count_repair_writes()'); await db.$executeRawUnsafe('DROP TABLE "BioRepairWriteTest"');
      }
    };
  }
  it("apply atomically changes candidate status only, and expired retry retains original completion with no writes", async () => {
    const commandId = await observedOperation(); const before = await readProtectedFixtureState();
    const tracker = await trackRepairWrites(); const beforeAckCount = await db.mqttOutbox.count();
    try {
    const applied = await service.apply(user, commandId);
    const row = await operations().findUniqueOrThrow({ where: { commandId } });
    const after = await readProtectedFixtureState();
    expect(after.candidate).toEqual({ ...before.candidate, status: "provisioned", updatedAt: after.candidate!.updatedAt });
    expect({ ...after, candidate: before.candidate, audits: before.audits }).toEqual(before);
    expect(row.appliedAt).not.toBeNull(); expect(row.auditId).not.toBeNull();
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ action: "bio_registration_current_revalidated", targetId: ids.fixture,
      metadata: { evidenceKind: "current_device_revalidation", bindingHash: row.bindingHash,
        bindingSnapshot: row.bindingSnapshot, revalidationCommandId: commandId, revalidationResultHash: row.resultHash,
        originalProvisionCommandId: ids.command, beforeStatus: "discovered", afterStatus: "provisioned" } });
    const sample = jest.spyOn(clock, "assertHealthy").mockResolvedValue(new Date(row.applyDeadlineAt.getTime() + 1));
    try { expect(await service.apply(user, commandId)).toEqual(applied); } finally { sample.mockRestore(); }
    expect(await operations().findUniqueOrThrow({ where: { commandId } })).toEqual(row);
    expect(await readProtectedFixtureState()).toEqual(after);
    expect(await tracker.counts()).toEqual([{ kind: "AuditLog", count: 1 }, { kind: "BioRegistrationRevalidationOperation", count: 1 },
      { kind: "DiscoveredMeshNode", count: 1 }]);
    expect(await db.mqttOutbox.count()).toBe(beforeAckCount);
    } finally { await tracker.stop(); }
  });
  it.each(["unknown", "superseded", "deadline", "requester", "permission", "cert", "assignment", "graph", "scan", "pending-registration", "clock"])
  ("apply rejects %s without repair/audit/operation consumption", async reason => {
    const unknown = reason === "unknown" ? await pendingResult() : null;
    const commandId = unknown?.row.commandId ?? await observedOperation();
    if (unknown) {
      const { evidence: _evidence, observedMode: _mode, ...identity } = unknown.result;
      await service.ingest(unknown.topic, { ...identity, status: "unknown", errorCode: "MODE_GET_UNCONFIRMED" },
        new Date(unknown.row.requestedAt.getTime() + 10));
      expect((await operations().findUniqueOrThrow({ where: { commandId } })).status).toBe("unknown");
    }
    let actor = user; let selectedService = service; let sample: jest.SpyInstance | undefined;
    if (reason === "superseded") await service.create(user, request());
    if (reason === "deadline") {
      const row = await operations().findUniqueOrThrow({ where: { commandId } });
      sample = jest.spyOn(clock, "assertHealthy").mockResolvedValue(row.applyDeadlineAt);
    }
    if (reason === "requester") actor = { ...user, id: randomUUID() };
    if (reason === "permission") await db.site.update({ where: { id: ids.site }, data: { adminUserId: null } });
    if (reason === "cert") await db.gatewayCertificate.update({ where: { id: ids.cert }, data: { notAfter: new Date(0) } });
    if (reason === "assignment") await db.gateway.update({ where: { id: ids.gateway }, data: { assignmentVersion: 3 } });
    if (reason === "graph") await db.meshNode.update({ where: { id: ids.node }, data: { meshAddress: "0x0101" } });
    if (reason === "scan") await db.provisioningSession.update({ where: { id: ids.session }, data: { scanStatus: "pending" } });
    if (reason === "pending-registration") {
      const original = await db.provisioningDeviceOutbox.findUniqueOrThrow({ where: { id: ids.command } });
      const id = randomUUID();
      await db.provisioningDeviceOutbox.create({ data: { id, sessionId: ids.session, nodeId: ids.fixture,
        topic: original.topic, payload: { ...(original.payload as object), commandId: id }, createdAt: new Date(0) } });
    }
    if (reason === "clock") {
      const { BioRegistrationRevalidationService } = require("../src/registration/bio-registration-revalidation.service");
      selectedService = new BioRegistrationRevalidationService(db, new SiteAccessService(db as never), new CommandDbClockHealth());
    }
    const before = await readProtectedFixtureState(); const row = await operations().findUniqueOrThrow({ where: { commandId } });
    try { await expect(selectedService.apply(actor, commandId)).rejects.toThrow(); } finally { sample?.mockRestore(); }
    expect(await readProtectedFixtureState()).toEqual(before);
    expect(await operations().findUniqueOrThrow({ where: { commandId } })).toEqual(row);
  });
  it("apply preserves retained completed registration metadata and accepts its original unpublished provision command", async () => {
    await db.discoveredMeshNode.update({ where: { id: ids.fixture }, data: { pendingFixtureName: "Retained historical name",
      pendingFixtureX: 10, pendingFixtureY: 20, pendingFixtureSize: 24, pendingRatedWatt: 40 } });
    // Completed terminal can arrive before PUBACK persistence; original command
    // dispatch metadata alone cannot turn this exact confirmed graph into busy.
    await db.provisioningDeviceOutbox.update({ where: { id: ids.command }, data: { publishedAt: null } });
    const commandId = await observedOperation(); const before = await readProtectedFixtureState();
    await expect(service.apply(user, commandId)).resolves.toMatchObject({ appliedAt: expect.any(String) });
    const after = await readProtectedFixtureState();
    expect(after.candidate).toEqual({ ...before.candidate, status: "provisioned", updatedAt: after.candidate!.updatedAt });
    expect({ ...after, candidate: before.candidate, audits: before.audits }).toEqual(before);
    expect(after.audits).toHaveLength(1);
  });
  it("apply mandatory audit insert fault rolls back candidate and operation", async () => {
    const commandId = await observedOperation(); const before = await readProtectedFixtureState();
    const row = await operations().findUniqueOrThrow({ where: { commandId } });
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_repair_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='bio_registration_current_revalidated' THEN RAISE EXCEPTION 'injected repair audit failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER fail_repair_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_repair_audit()');
    try { await expect(service.apply(user, commandId)).rejects.toThrow("injected repair audit failure"); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER fail_repair_audit ON "AuditLog"'); await db.$executeRawUnsafe('DROP FUNCTION fail_repair_audit()'); }
    expect(await readProtectedFixtureState()).toEqual(before);
    expect(await operations().findUniqueOrThrow({ where: { commandId } })).toEqual(row);
  });
  it("apply race consumes the same operation once and emits one mandatory repair audit", async () => {
    const commandId = await observedOperation();
    const tracker = await trackRepairWrites();
    const first = instrumentedClient("bio-apply-race-first", true); const second = instrumentedClient("bio-apply-race-second");
    try {
    const firstResult = applyService(first.client).apply(user, commandId);
    await first.entered.promise;
    const secondResult = applyService(second.client).apply(user, commandId);
    try { await awaitActualBlockedTransaction("bio-apply-race-second"); } finally { first.release.resolve(); }
    const results = await Promise.all([firstResult, secondResult]); expect(results[0]).toEqual(results[1]);
    expect((await db.discoveredMeshNode.findUniqueOrThrow({ where: { id: ids.fixture } })).status).toBe("provisioned");
    expect(await db.auditLog.count({ where: { action: "bio_registration_current_revalidated" } })).toBe(1);
    expect(await tracker.counts()).toEqual([{ kind: "AuditLog", count: 1 }, { kind: "BioRegistrationRevalidationOperation", count: 1 },
      { kind: "DiscoveredMeshNode", count: 1 }]);
    } finally { first.release.resolve(); await tracker.stop(); }
  });
  it("classification records applied current device evidence, preserving output/qualification and repair audit", async () => {
    const commandId = await observedOperation(); await service.apply(user, commandId);
    const before = await readProtectedFixtureState();
    expect(await classification().reconcile(user, classificationRequest())).toEqual({ changedFixtureIds: [ids.fixture], unchangedFixtureIds: [] });
    const after = await readProtectedFixtureState();
    expect(after.node).toEqual({ ...before.node, vehicleSensorProtocol: "bio_usb_pulse", updatedAt: after.node!.updatedAt });
    expect({ ...after, node: before.node, audits: before.audits }).toEqual(before);
    const row = await operations().findUniqueOrThrow({ where: { commandId } });
    expect(after.audits.find(audit => audit.action === "bio_classification_reconciled")?.metadata).toMatchObject({
      evidenceKind: "current_device_revalidation", revalidationCommandId: commandId,
      revalidationResultHash: row.resultHash, repairAuditId: row.auditId });
  });
  it("classification rejects malformed applied audit without falling back to historical graph evidence", async () => {
    const commandId = await observedOperation(); await service.apply(user, commandId);
    const row = await operations().findUniqueOrThrow({ where: { commandId } });
    await db.auditLog.update({ where: { id: row.auditId }, data: { metadata: { evidenceKind: "legacy_completed_graph_command" } } });
    const before = await readProtectedFixtureState();
    await expect(classification().reconcile(user, classificationRequest())).rejects.toThrow();
    expect(await readProtectedFixtureState()).toEqual(before);
  });
  async function additionalHistoricalFixture() {
    const fixtureId = randomUUID(), nodeId = randomUUID(), commandId = randomUUID(), deviceUuid = "bio:001122334455";
    await db.discoveredMeshNode.create({ data: { id: fixtureId, sessionId: ids.session, deviceUuid,
      serialNumber: "A", rssi: -60, oobCapability: "none", firmwareVersion: "test", status: "provisioned",
      identifyState: "confirmed", meshAddress: "0x0101" } });
    await db.meshNode.create({ data: { id: nodeId, gatewayId: ids.gateway, deviceUuid, meshAddress: "0x0101", firmwareVersion: "test" } });
    await db.fixture.create({ data: { id: fixtureId, meshNodeId: nodeId, floorId: ids.floor, name: "A", ratedWatt: 40,
      brightness: 73, powerOn: false, x: 5, y: 8 } });
    await db.provisioningDeviceOutbox.create({ data: { id: commandId, sessionId: ids.session, nodeId: fixtureId,
      topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/provisioning/provision-device`, publishedAt: new Date(),
      payload: { siteId: ids.site, gatewayId: ids.gateway, commandId, sessionId: ids.session,
        nodeId: fixtureId, deviceUuid, meshAddress: "0x0101", requestedAt: new Date().toISOString() } } });
    return { fixtureId, nodeId };
  }
  it.each([false, true])("classification A/B remains atomic with invalid second row=%s and separate repair history", async invalid => {
    const a = await additionalHistoricalFixture(); const commandId = await observedOperation(); await service.apply(user, commandId);
    if (invalid) await db.discoveredMeshNode.update({ where: { id: ids.fixture }, data: { identifyState: "idle" } });
    const beforeNodes = await db.meshNode.findMany({ orderBy: { id: "asc" } });
    const beforeFixtures = await db.fixture.findMany({ orderBy: { id: "asc" } });
    const input = classificationRequest([a.fixtureId, ids.fixture]);
    if (invalid) {
      await expect(classification().reconcile(user, input)).rejects.toThrow();
      expect(await db.meshNode.findMany({ orderBy: { id: "asc" } })).toEqual(beforeNodes);
      expect(await db.auditLog.count({ where: { action: "bio_classification_reconciled" } })).toBe(0);
    } else {
      expect(await classification().reconcile(user, input)).toEqual({ changedFixtureIds: input.fixtureIds, unchangedFixtureIds: [] });
      expect(await db.meshNode.findMany({ orderBy: { id: "asc" } })).toEqual(beforeNodes.map(node => ({ ...node,
        vehicleSensorProtocol: "bio_usb_pulse", updatedAt: expect.any(Date) })));
      const audits = await db.auditLog.findMany({ where: { action: "bio_classification_reconciled" } });
      expect(audits).toHaveLength(2);
      expect(audits.find(audit => audit.targetId === a.nodeId)?.metadata).toMatchObject({ evidenceKind: "legacy_completed_graph_command" });
      expect(audits.find(audit => audit.targetId === ids.node)?.metadata).toMatchObject({ evidenceKind: "current_device_revalidation" });
    }
    expect(await db.fixture.findMany({ orderBy: { id: "asc" } })).toEqual(beforeFixtures);
    expect(await db.auditLog.count({ where: { action: "bio_registration_current_revalidated" } })).toBe(1);
  });

  function deferred() {
    let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  function instrumentedClient(label: string, holdFloor = false) {
    const entered = deferred(), release = deferred(); const queries: string[] = []; let held = false;
    const client = new Proxy(db, { get(target, key) {
      if (key === "$transaction") return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
        target.$transaction(async tx => {
          await tx.$executeRaw`SELECT set_config('application_name', ${label}, true)`;
          const instrumented = new Proxy(tx, { get(transaction, property) {
            if (property === "$queryRaw") return async (...args: any[]) => {
              const text = Array.isArray(args[0]) ? args[0].join(" ") : args[0].sql;
              queries.push(text);
              const result = await (transaction.$queryRaw as any)(...args);
              if (holdFloor && !held && text.includes('FROM "Floor"') && text.includes("FOR UPDATE")) {
                held = true; entered.resolve(); await release.promise;
              }
              return result;
            };
            const value = (transaction as any)[property]; return typeof value === "function" ? value.bind(transaction) : value;
          } });
          return callback(instrumented);
        }, options);
      const value = (target as any)[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
    return { client, entered, release, queries };
  }
  async function awaitActualBlockedTransaction(label: string) {
    const deadline = Date.now() + 3_000;
    do {
      const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT cardinality(pg_blocking_pids(pid))>0 AS blocked
        FROM pg_stat_activity WHERE application_name=${label} AND wait_event_type='Lock'`;
      if (rows.some(row => row.blocked)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error(`no actual PostgreSQL lock wait observed for ${label}`);
  }
  function applyService(client: any) {
    const { BioRegistrationRevalidationService } = require("../src/registration/bio-registration-revalidation.service");
    return new BioRegistrationRevalidationService(client, new SiteAccessService(client), clock);
  }
  function registrationService(client: any) {
    const { RegistrationService } = require("../src/registration/registration.service");
    const { RegistrationAllocationService } = require("../src/registration/registration-allocation.service");
    const { MeshControlGroupService } = require("../src/mesh-control-groups/mesh-control-group.service");
    return new RegistrationService(client, {}, new SiteAccessService(client), new RegistrationAllocationService(), new MeshControlGroupService());
  }
  it.each(["scan", "registration"].flatMap(operation => ["domain-first", "apply-first"].map(order => [operation, order])))
  ("apply race barrier serializes actual %s %s transactions", async (operation, order) => {
    const correlation = randomUUID();
    await db.provisioningSession.update({ where: { id: ids.session }, data: { scanCorrelationId: correlation, scanAttempt: 1 } });
    await db.discoveredMeshNode.update({ where: { id: ids.fixture }, data: { scanCorrelationId: correlation, scanAttempt: 1 } });
    const commandId = await observedOperation(); const before = await readProtectedFixtureState();
    const first = instrumentedClient(`bio-${operation}-${order}-first`, true);
    const secondLabel = `bio-${operation}-${order}-second`; const second = instrumentedClient(secondLabel);
    const domainOperation = (client: any) => {
      const registration = registrationService(client);
      return operation === "scan" ? registration.retryScan(user, ids.session) : registration.registerNode(user, ids.session, ids.fixture,
        { fixtureName: "replacement", x: 10, y: 10 });
    };
    const settled = (promise: Promise<any>) => promise.then(value => ({ value }), error => ({ error }));
    const firstResult = settled(order === "apply-first" ? applyService(first.client).apply(user, commandId) : domainOperation(first.client));
    await first.entered.promise;
    const secondResult = settled(order === "apply-first" ? domainOperation(second.client) : applyService(second.client).apply(user, commandId));
    try { await awaitActualBlockedTransaction(secondLabel); } finally { first.release.resolve(); }
    const [one, two]: any[] = await Promise.all([firstResult, secondResult]);
    if (operation === "scan" && order === "domain-first") {
      expect(one.error).toBeUndefined(); expect(two.error).toBeDefined();
      expect((await operations().findUniqueOrThrow({ where: { commandId } })).appliedAt).toBeNull();
      expect(await db.auditLog.count()).toBe(0);
      expect((await db.discoveredMeshNode.findUniqueOrThrow({ where: { id: ids.fixture } })).status).toBe("discovered");
    } else {
      const applyResult = order === "apply-first" ? one : two; expect(applyResult.error).toBeUndefined();
      expect(await db.auditLog.count({ where: { action: "bio_registration_current_revalidated" } })).toBe(1);
      expect((await db.discoveredMeshNode.findUniqueOrThrow({ where: { id: ids.fixture } })).status).toBe("provisioned");
    }
    expect(await db.fixture.findUnique({ where: { id: ids.fixture } })).toEqual(before.fixture);
    expect(await db.meshNode.findUnique({ where: { id: ids.node } })).toEqual(before.node);
    expect(await db.provisioningDeviceOutbox.findMany({ where: { sessionId: ids.session } })).toEqual(before.commands);
    const applyQueries = order === "apply-first" ? first.queries : second.queries;
    expect(applyQueries.findIndex(query => query.includes('FROM "Floor"'))).toBeLessThan(
      applyQueries.findIndex(query => query.includes('JOIN "GatewayCertificate"')));
    expect(applyQueries.findIndex(query => query.includes('JOIN "GatewayCertificate"'))).toBeLessThan(
      applyQueries.findIndex(query => query.includes('FROM "ProvisioningSession"')));
  });
  it.each(["sensor", "force-on", "force-off"])("ingest accepts fresh %s and atomically retains the exact ACK without projection writes", async mode => {
    const { row, result, topic } = await pendingResult(mode); const before = await readProtectedFixtureState();
    const receivedAt = new Date(row.requestedAt.getTime() + 100);
    const ack = await service.ingest(topic, result, receivedAt);
    expect(ack).toMatchObject({ purpose: "bio_registration_revalidation", status: "ingested", eventId: result.eventId, payloadHash: hash(result) });
    const stored = await operations().findUniqueOrThrow({ where: { commandId: row.commandId } });
    expect(stored).toMatchObject({ status: "observed", result, resultHash: hash(result), resultEventId: result.eventId, proofAcceptedAt: receivedAt });
    expect(await service.get(user, row.commandId)).toMatchObject({ observedMode: mode });
    const receipt = await db.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: `bio-registration-revalidation:${ids.gateway}:${row.commandId}:${result.eventId}` } });
    expect(receipt.payload).toEqual(ack); expect(receipt.payloadHash).toBe(hash(ack));
    expect(receipt.topic).toBe(`sites/${ids.site}/gateways/${ids.gateway}/acks/bio-registration-revalidation-result`);
    expect(await readProtectedFixtureState()).toEqual(before);
  });
  it.each(["sensor", "force-on", "force-off"].flatMap(mode => ["before", "after", "future", "receipt", "superseded", "binding", "timed-out", "clock"].map(reason => [mode, reason])))
  ("ingest stores %s %s as immutable stale audit with no exposed proof", async (mode, reason) => {
    const { row, result, topic } = await pendingResult(mode); let receivedAt = new Date(row.requestedAt.getTime() + 100);
    if (reason === "before") result.occurredAt = new Date(row.requestedAt.getTime() - 1).toISOString();
    if (reason === "after") result.occurredAt = new Date(row.expiresAt.getTime() + 1).toISOString();
    if (reason === "future") result.occurredAt = new Date(receivedAt.getTime() + 1001).toISOString();
    if (reason === "receipt") receivedAt = row.expiresAt;
    if (reason === "superseded") await service.create(user, request());
    if (reason === "binding") await db.meshNode.update({ where: { id: ids.node }, data: { meshAddress: "0x0101" } });
    if (reason === "timed-out") await service.expire(row.expiresAt);
    const { BioRegistrationRevalidationService } = require("../src/registration/bio-registration-revalidation.service");
    const ingest = reason === "clock" ? new BioRegistrationRevalidationService(db, new SiteAccessService(db as never), new CommandDbClockHealth()) : service;
    const before = await readProtectedFixtureState();
    expect(await ingest.ingest(topic, result, receivedAt)).toMatchObject({ status: "stale_checkpoint" });
    const stored = await operations().findUniqueOrThrow({ where: { commandId: row.commandId } });
    expect(stored.result).toEqual(result); expect(stored.proofAcceptedAt).toBeNull(); expect(stored.status).not.toBe("observed");
    if (reason !== "binding") expect(await service.get(user, row.commandId)).toMatchObject({ observedMode: null });
    expect(await readProtectedFixtureState()).toEqual(before);
  });
  it("ingest accepts exact duplicate only; altered full hash or event preserves original and revives ACK", async () => {
    const { row, result, topic } = await pendingResult(); const received = new Date(row.requestedAt.getTime() + 100);
    await service.ingest(topic, result, received);
    const original = await operations().findUniqueOrThrow({ where: { commandId: row.commandId } });
    const key = `bio-registration-revalidation:${ids.gateway}:${row.commandId}:${result.eventId}`;
    await db.mqttOutbox.update({ where: { applicationAckKey: key }, data: { publishedAt: new Date(), deadLetteredAt: new Date(), attempts: 10 } });
    expect(await service.ingest(topic, result, row.expiresAt)).toMatchObject({ status: "duplicate", payloadHash: hash(result) });
    for (const changed of [{ ...result, observedMode: "sensor" }, { ...result, eventId: randomUUID() }]) {
      await expect(service.ingest(topic, changed, received)).rejects.toThrow();
    }
    expect(await operations().findUniqueOrThrow({ where: { commandId: row.commandId } })).toEqual(original);
    expect(await db.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: key } })).toMatchObject({ publishedAt: null, deadLetteredAt: null, attempts: 0 });
  });
  it.each(["assignment", "cert", "requester", "purpose", "topic", "identity", "old-ack"])("ingest rejects current %s before result or ACK writes", async reason => {
    const { row, result, topic } = await pendingResult(); let value: any = result; let channel = topic;
    if (reason === "assignment") await db.gateway.update({ where: { id: ids.gateway }, data: { assignmentVersion: 3 } });
    if (reason === "cert") await db.gatewayCertificate.update({ where: { id: ids.cert }, data: { revokedAt: new Date() } });
    if (reason === "requester") {
      await db.site.update({ where: { id: ids.site }, data: { adminUserId: null } });
      await db.user.update({ where: { id: ids.actor }, data: { status: "disabled" } });
    }
    if (reason === "purpose") value = { ...result, purpose: "sensor_mode" };
    if (reason === "topic") channel = topic.replace("bio-registration-revalidation-result", "bio-sensor-mode-result");
    if (reason === "identity") value = { ...result, nodeId: randomUUID() };
    if (reason === "old-ack") value = { fixtureId: ids.fixture, eventId: result.eventId, sequence: 7, status: "ingested" };
    await expect(service.ingest(channel, value, new Date(row.requestedAt.getTime() + 100))).rejects.toThrow();
    expect((await operations().findUniqueOrThrow({ where: { commandId: row.commandId } })).resultHash).toBeNull();
    expect(await db.mqttOutbox.count({ where: { gatewayId: ids.gateway } })).toBe(0);
  });
  it("ingest ACK insert failure rolls back proof, and cross-command event collision rolls back everything", async () => {
    const { row, result, topic } = await pendingResult();
    const key = `bio-registration-revalidation:${ids.gateway}:${row.commandId}:${result.eventId}`;
    // A preexisting unrelated key is an integrity collision, never permission to overwrite its ACK.
    await db.mqttOutbox.create({ data: { gatewayId: ids.gateway, applicationAckKey: key, topic: "wrong", payload: {}, payloadHash: hash({}) } });
    await expect(service.ingest(topic, result, new Date(row.requestedAt.getTime() + 100))).rejects.toThrow();
    expect((await operations().findUniqueOrThrow({ where: { commandId: row.commandId } })).resultHash).toBeNull();
    await db.mqttOutbox.delete({ where: { applicationAckKey: key } });
    await service.ingest(topic, result, new Date(row.requestedAt.getTime() + 100));
    const second = await pendingResult(); second.result.eventId = result.eventId;
    await expect(service.ingest(topic, second.result, new Date(second.row.requestedAt.getTime() + 100))).rejects.toMatchObject({ code: "P2002" });
    expect((await operations().findUniqueOrThrow({ where: { commandId: second.row.commandId } })).resultHash).toBeNull();
    expect(await db.mqttOutbox.count({ where: { gatewayId: ids.gateway } })).toBe(1);
  });
  it("expiry makes only pending operations timed_out without synthetic result or audit", async () => {
    const { row } = await pendingResult(); const before = await readProtectedFixtureState();
    await service.expire(new Date(row.expiresAt.getTime() - 1));
    expect((await operations().findUniqueOrThrow({ where: { commandId: row.commandId } })).status).toBe("pending");
    await service.expire(row.expiresAt);
    expect(await operations().findUniqueOrThrow({ where: { commandId: row.commandId } })).toMatchObject({ status: "timed_out", resultHash: null, resultEventId: null, proofAcceptedAt: null });
    expect(await readProtectedFixtureState()).toEqual(before);
  });
  function publisher(publishTopic: (...args: any[]) => Promise<void>, selectedClock = clock) {
    const { BioRegistrationRevalidationPublisherService } = require("../src/mqtt/bio-registration-revalidation-publisher.service");
    return new BioRegistrationRevalidationPublisherService(db, { publishTopic }, service, selectedClock);
  }
  it("publish commits canonical validation before network, retries identical payload, and PUBACK never observes", async () => {
    const { row } = await pendingResult(); const before = await readProtectedFixtureState(); const sent: any[] = [];
    const worker = publisher(async (topic, payload, options) => {
      // A separate transaction must acquire the domain/operation rows during network I/O.
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'");
        await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id"=${ids.floor} FOR UPDATE`;
        await tx.$queryRaw`SELECT "commandId" FROM "BioRegistrationRevalidationOperation" WHERE "commandId"=${row.commandId} FOR UPDATE`;
      });
      sent.push({ topic, payload, options }); if (sent.length === 1) throw new Error("PUBACK lost");
    });
    await worker.processBatch();
    let stored = await operations().findUniqueOrThrow({ where: { commandId: row.commandId } });
    expect(stored).toMatchObject({ status: "pending", resultHash: null, publishedAt: null, lockedBy: null, attempts: 1 });
    await operations().update({ where: { commandId: row.commandId }, data: { nextAttemptAt: new Date(0) } });
    await worker.processBatch(); stored = await operations().findUniqueOrThrow({ where: { commandId: row.commandId } });
    expect(stored).toMatchObject({ status: "pending", proofAcceptedAt: null, resultHash: null, attempts: 2 }); expect(stored.publishedAt).not.toBeNull();
    expect(sent).toHaveLength(2); expect(sent[0].payload).toEqual(row.payload); expect(sent[1].payload).toEqual(row.payload);
    expect(sent[0].topic).toBe(`sites/${ids.site}/gateways/${ids.gateway}/commands/bio-registration-revalidation`);
    expect(sent[0].options.timeoutMs).toBeLessThanOrEqual(2000); expect(sent[0].options.retain).toBe(false);
    expect(await readProtectedFixtureState()).toEqual(before);
  });
  it.each(["requester", "cert", "assignment", "binding", "clock", "expired", "superseded"])("publish refuses current %s and leaves no proof", async reason => {
    const { row } = await pendingResult(); let selectedClock = clock;
    if (reason === "requester") {
      await db.site.update({ where: { id: ids.site }, data: { adminUserId: null } });
      await db.user.update({ where: { id: ids.actor }, data: { status: "disabled" } });
    }
    if (reason === "cert") await db.gatewayCertificate.update({ where: { id: ids.cert }, data: { notAfter: new Date(0) } });
    if (reason === "assignment") await db.gateway.update({ where: { id: ids.gateway }, data: { assignmentVersion: 3 } });
    if (reason === "binding") await db.meshNode.update({ where: { id: ids.node }, data: { meshAddress: "0x0101" } });
    if (reason === "clock") selectedClock = new CommandDbClockHealth();
    if (reason === "expired") await service.expire(row.expiresAt);
    if (reason === "superseded") await service.create(user, request());
    let sends = 0; await publisher(async () => { sends++; }, selectedClock).processBatch();
    expect(sends).toBe(reason === "superseded" ? 1 : 0); // Only the replacement command is eligible.
    const stored = await operations().findUniqueOrThrow({ where: { commandId: row.commandId } });
    expect(stored.proofAcceptedAt).toBeNull(); expect(stored.publishedAt).toBeNull();
    if (!["superseded", "expired"].includes(reason)) expect(stored.status).toBe("unknown");
  });
  it("publish lease replacement fences old completion and concurrent workers cannot both own one query", async () => {
    const { row } = await pendingResult(); let sends = 0;
    const worker = publisher(async () => {
      sends++; await publisher(async () => { sends++; }).processBatch();
      await operations().update({ where: { commandId: row.commandId }, data: { lockedBy: "successor", leaseExpiresAt: new Date(Date.now() + 10_000) } });
    });
    await worker.processBatch();
    expect(sends).toBe(1);
    expect(await operations().findUniqueOrThrow({ where: { commandId: row.commandId } })).toMatchObject({ lockedBy: "successor", publishedAt: null, attempts: 1 });
  });
  it("publish refuses when final authorization delay exceeds the remaining lease budget", async () => {
    const { row } = await pendingResult(); let sends = 0; let clockSamples = 0; let finalSampleReached = false;
    const binding = require("../src/registration/bio-registration-revalidation-binding");
    const realAuthorize = binding.authorizeBioRegistrationGateway;
    const realClock = clock.assertHealthy.bind(clock);
    const clockSpy = jest.spyOn(clock, "assertHealthy").mockImplementation(async tx => {
      const now = await realClock(tx);
      if (++clockSamples !== 2) return now;
      const claimed = await tx.bioRegistrationRevalidationOperation.findUniqueOrThrow({ where: { commandId: row.commandId } });
      finalSampleReached = true;
      // Synthetic trusted sample: 100ms of the actual claimed lease remains.
      // Its command TTL remains longer, so the smaller lease budget must govern.
      return new Date(claimed.leaseExpiresAt!.getTime() - 100);
    });
    const authorizationSpy = jest.spyOn(binding, "authorizeBioRegistrationGateway").mockImplementation(async (...args: unknown[]) => {
      await realAuthorize(...args);
      // Keep real authority checks; emulate the last SQL round trip taking
      // longer than the budget, without sleeping through a 10-second lease.
      if (finalSampleReached) await new Promise(resolve => setTimeout(resolve, 150));
    });
    try {
      await publisher(async () => { sends++; }).processBatch();
      expect(sends).toBe(0);
      expect(await operations().findUniqueOrThrow({ where: { commandId: row.commandId } })).toMatchObject({ publishedAt: null, resultHash: null, proofAcceptedAt: null });
    } finally { authorizationSpy.mockRestore(); clockSpy.mockRestore(); }
  });
  it("get permits the current provisioned graph for an applied row; new create retains the consumed operation/audit", async () => {
    const input = request(); const created = await service.create(user, input);
    const { acceptedAt } = await persistObserved(created.commandId);
    const audit = await db.auditLog.create({ data: { siteId: ids.site, actorId: user.id, action: "test-only-repair",
      targetType: "DiscoveredMeshNode", targetId: ids.fixture, outcome: "changed" } });
    await operations().update({ where: { commandId: created.commandId }, data: { appliedAt: acceptedAt, auditId: audit.id } });
    await db.discoveredMeshNode.update({ where: { id: ids.fixture }, data: { status: "provisioned" } });
    expect(await service.get(user, created.commandId)).toMatchObject({ status: "observed", observedMode: "force-off", appliedAt: acceptedAt.toISOString() });
    expect((await service.create(user, input)).commandId).toBe(created.commandId);
    // A following request targets discovered again; the consumed row remains immutable history.
    await db.discoveredMeshNode.update({ where: { id: ids.fixture }, data: { status: "discovered" } });
    await service.create(user, request());
    expect((await operations().findUniqueOrThrow({ where: { commandId: created.commandId } })).supersededAt).toBeNull();
    await expect(db.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow();
    await operations().delete({ where: { commandId: created.commandId } });
    expect(await db.auditLog.findUnique({ where: { id: audit.id } })).not.toBeNull();
  });
  it("schema enforces requester request/event uniqueness and write-once proof", async () => {
    const input = request(); const first = await service.create(user, input);
    const { row, result } = await persistObserved(first.commandId);
    const { createdAt: _created, updatedAt: _updated, ...data } = row;
    const commandId = randomUUID(); const payload = { ...data.payload, commandId };
    await expect(operations().create({ data: { ...data, result: Prisma.DbNull, commandId, payload, payloadHash: hash(payload) } })).rejects.toMatchObject({ code: "P2002" });
    const second = await service.create(user, request());
    const secondRow = await operations().findUniqueOrThrow({ where: { commandId: second.commandId } });
    const duplicate = { ...result, commandId: second.commandId, occurredAt: secondRow.requestedAt.toISOString() };
    await expect(operations().update({ where: { commandId: second.commandId }, data: { status: "observed", result: duplicate,
      resultHash: hash(duplicate), resultEventId: result.eventId, proofAcceptedAt: new Date(secondRow.requestedAt.getTime() + 10) } })).rejects.toMatchObject({ code: "P2002" });
    await expect(operations().update({ where: { commandId: first.commandId }, data: { proofAcceptedAt: new Date(row.requestedAt.getTime() + 20) } })).rejects.toThrow();
  });
  it.each(["status", "assignment", "hash", "address", "result", "observed", "audit", "deadline", "immutable"])("schema rejects %s forgery", async reason => {
    const created = await service.create(user, request());
    const data: Record<string, unknown> = { status: "invented" };
    if (reason === "assignment") Object.assign(data, { status: "pending", assignmentVersion: 0 });
    if (reason === "hash") Object.assign(data, { status: "pending", bindingHash: "bad" });
    if (reason === "address") Object.assign(data, { status: "pending", meshAddress: "0x8000" });
    if (reason === "result") Object.assign(data, { status: "unknown", result: {} });
    if (reason === "observed") Object.assign(data, { status: "observed" });
    if (reason === "audit") Object.assign(data, { status: "pending", appliedAt: new Date() });
    if (reason === "deadline") Object.assign(data, { status: "pending", applyDeadlineAt: new Date(0) });
    if (reason === "immutable") Object.assign(data, { status: "pending", payload: {} });
    if (reason === "immutable") {
      await expect(operations().update({ where: { commandId: created.commandId }, data })).rejects.toThrow();
    } else {
      const row = await operations().findUniqueOrThrow({ where: { commandId: created.commandId } });
      const { createdAt: _created, updatedAt: _updated, ...original } = row;
      const commandId = randomUUID(); const payload = { ...row.payload, commandId };
      await expect(operations().create({ data: { ...original, result: Prisma.DbNull, commandId, clientRequestId: randomUUID(),
        payload, payloadHash: hash(payload), ...data } })).rejects.toThrow();
    }
  });
});
