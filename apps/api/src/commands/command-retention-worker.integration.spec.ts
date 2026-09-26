import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { CommandSafetyDigest } from "./command-safety-digest";
import { runDisposableProtectedCommandRetentionBatch } from "./command-retention-worker";
import { CommandPurgeBarrier, storeDisposableBarrierEvidence } from "./command-purge-barrier.service";
import { performance } from "node:perf_hooks";
import { RecoveryOutboxPublisherService } from "../mqtt/recovery-outbox-publisher.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { gatewayStatusCheckCommandPublishedV2Schema } from "@led-control/shared";

const enabled = process.env.COMMAND_RETENTION_TEST === "1";
jest.setTimeout(60000);

(enabled ? describe : describe.skip)("bounded protected Command retention on disposable PostgreSQL", () => {
  it("defers one blocked original, deletes the later safe one, and denies direct role DELETE", async () => {
    const cluster = await disposablePostgres();
    let owner: PrismaClient | undefined;
    let worker: PrismaClient | undefined;
    let otherWorker: PrismaClient | undefined;
    try {
      const url = cluster.database();
      expect(cluster.deploy(url).status).toBe(0);
      const token = randomUUID();
      cluster.sql(url, `CREATE TABLE command_protected.disposable_purge_proof ("token" TEXT PRIMARY KEY)`);
      owner = new PrismaClient({ datasourceUrl: url });
      await owner.$executeRaw`INSERT INTO command_protected.disposable_purge_proof ("token") VALUES (${token})`;
      await owner.$executeRaw`INSERT INTO command_protected.manual_source_key ("keyVersion", "secret", "active")
        VALUES (1, ${randomBytes(32)}, true)`;
      for (const name of ["manual-override-guarded-detach.sql", "manual-execution-retirement.sql",
        "command-retention-protected-delete.sql"]) {
        cluster.sql(url, readFileSync(join(__dirname, "../../prisma/cutovers", name), "utf8"));
      }
      cluster.sql(url, `
        CREATE ROLE retention_test_runtime LOGIN NOINHERIT;
        CREATE ROLE retention_test_worker LOGIN INHERIT;
        GRANT command_retention_worker TO retention_test_worker;
        GRANT USAGE ON SCHEMA public TO retention_test_runtime;
        GRANT SELECT ON public."Command" TO retention_test_runtime;
        GRANT SELECT ON command_protected.disposable_purge_proof TO command_retention_worker;
      `);
      const workerUrl = new URL(url);
      workerUrl.username = "retention_test_worker";
      const runtimeUrl = new URL(url);
      runtimeUrl.username = "retention_test_runtime";
      worker = new PrismaClient({ datasourceUrl: workerUrl.toString() });
      otherWorker = new PrismaClient({ datasourceUrl: workerUrl.toString() });
      const org = await owner.organization.create({ data: { name: "Retention worker" } });
      const site = await owner.site.create({ data: { organizationId: org.id, name: "Site" } });
      const user = await owner.user.create({ data: { organizationId: org.id,
        name: "Operator", loginId: randomUUID(), passwordHash: "unused", role: "viewer" } });
      const gateway = await owner.gateway.create({ data: { siteId: site.id, name: "Gateway",
        serialNumber: randomUUID(), firmwareVersion: "test" } });
      const floor = await owner.floor.create({ data: { siteId: site.id, name: "Floor", level: 1 } });
      const node = await owner.meshNode.create({ data: { gatewayId: gateway.id,
        deviceUuid: randomUUID(), meshAddress: "0x0100", firmwareVersion: "test" } });
      const fixture = await owner.fixture.create({ data: { siteId: site.id, floorId: floor.id,
        gatewayId: gateway.id, meshNodeId: node.id, name: "Fixture", ratedWatt: "40", x: 1, y: 1 } });
      const createdAt = new Date("2026-01-31T00:00:00.000Z");
      await owner.commandPublishEpoch.create({ data: { generation: 1 } });
      await owner.commandPublishMember.create({ data: { generation: 1, workerId: "publisher",
        brokerIdentity: "publisher-generation-1" } });
      const seed = async (index: number, published: boolean) => {
        const command = await owner!.command.create({ data: { siteId: site.id, requestedBy: user.id,
          clientRequestId: randomUUID(), requestFingerprint: "old", targetType: "fixtures",
          targetFixtureIds: [fixture.id], brightness: 70, status: "failed", outcome: "unknown",
          createdAt: new Date(createdAt.getTime() + index) } });
        const dispatch = await owner!.commandDispatch.create({ data: { commandId: command.id,
          gatewayId: gateway.id, idempotencyKey: randomUUID(), sequence: BigInt(index + 11),
          status: "pending", errorCode: "STATUS_TIMEOUT",
          fixtureResults: { create: { fixtureId: fixture.id, status: "timed_out" } } } });
        await owner!.mqttOutbox.create({ data: { dispatchId: dispatch.id,
          topic: `sites/${site.id}/gateways/${gateway.id}/commands/dimming`,
          payload: { commandId: command.id, dispatchId: dispatch.id, targetFixtureIds: [fixture.id], brightness: 70 },
          } });
        if ((await owner!.commandPublishEpoch.findUniqueOrThrow({ where: { generation: 1 } })).status === "active") {
          await owner!.commandPublishAttempt.create({ data: { generation: 1, workerId: "publisher",
            dispatchId: dispatch.id, expiresAt: new Date("2026-01-31T00:00:10.000Z") } });
        }
        await owner!.commandDispatch.update({ where: { id: dispatch.id }, data: { status: "timed_out" } });
        if (published) await owner!.mqttOutbox.update({ where: { dispatchId: dispatch.id },
          data: { publishedAt: new Date("2026-01-31T00:00:01.000Z") } });
        return { command, dispatch };
      };
      const blocked = await seed(0, false);
      const eligible = await seed(1, true);
      const concurrentEligible = await seed(2, true);
      await owner.command.update({ where: { id: concurrentEligible.command.id }, data: { createdAt: new Date() } });
      await owner.commandPublishEpoch.update({ where: { generation: 1 }, data: { status: "quiescing" } });
      await owner.commandPublishMember.update({ where: { generation_workerId: { generation: 1, workerId: "publisher" } },
        data: { quiesceAckAt: new Date() } });
      await owner.commandPublishEpoch.update({ where: { generation: 1 }, data: { status: "fenced" } });
      const signer = { workerId: "retention_test_worker", keyVersion: 1, secret: randomBytes(32) };
      await owner.$executeRaw`INSERT INTO command_protected.purge_barrier_verify_key ("keyVersion", "secret")
        VALUES (1, ${signer.secret})`;
      const refreshClock = async () => {
        await owner!.$executeRaw`INSERT INTO command_protected.purge_clock_attestation
          ("generation", "primaryId", "continuityId", "clockDigest", "healthy", "observedAt", "validUntil")
          VALUES (1, pg_postmaster_start_time()::text, 'continuity-1', ${"a".repeat(64)}, true,
            clock_timestamp(), clock_timestamp() + interval '1 second')
          ON CONFLICT ("generation") DO UPDATE SET "observedAt" = clock_timestamp(),
            "validUntil" = clock_timestamp() + interval '1 second'`;
      };
      // Explicit disposable evidence model. Real stock broker / Gateway software
      // counters cannot supply a physical RF certificate or enable production.
      const barrier = new CommandPurgeBarrier({ broker: { verifyRetired: async generation => {
        await refreshClock(); const now = performance.now();
        return { status: "verified", scope: "disposable", productionPurgeAllowed: false,
          generation, inventoryRevision: "broker-1", nodeIds: ["test-node"], nonce: randomUUID(),
          digest: "b".repeat(64), verifiedAtMonotonicMs: now, expiresAtMonotonicMs: now + 1000 };
      } }, gateways: { verify: async generation => { const now = performance.now();
        return { status: "verified", generation, inventoryRevision: "gateway-1", digest: "c".repeat(64),
          productionPurgeAllowed: false, submitToRfUpperBoundMs: 1,
          verifiedAtMonotonicMs: now, expiresAtMonotonicMs: now + 1000 };
      } } });
      const barrierOptions = { generation: 1, service: barrier, signer };
      expect(await owner.mqttOutbox.findFirstOrThrow({ where: { dispatchId: eligible.dispatch.id } }))
        .toMatchObject({ publishedAt: expect.any(Date), lockedBy: null, lockedAt: null,
          leaseExpiresAt: null, deadLetteredAt: null, supersededAt: null });
      const key = randomBytes(32).toString("base64url");
      const digest = new CommandSafetyDigest({ activeVersion: 1, keys: { 1: key } });
      await owner.$executeRaw`INSERT INTO command_protected.command_safety_verify_key
        ("keyVersion", "secret") VALUES (1, ${Buffer.from(key, "base64url")})`;
      process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
      process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({ 1: key });
      process.env.COMMAND_RUNTIME_DB_ROLE = "retention_test_runtime";
      let reportLocked!: () => void;
      let releaseLock!: () => void;
      const locked = new Promise<void>(resolve => { reportLocked = resolve; });
      const released = new Promise<void>(resolve => { releaseLock = resolve; });
      const rowLock = worker.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Command" WHERE "id" = ${blocked.command.id} FOR UPDATE`;
        await tx.$executeRawUnsafe("SAVEPOINT retention_row_lock_proof");
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT retention_row_lock_proof");
        reportLocked();
        await released;
      }, { timeout: 10_000 });
      await locked;
      try {
        const skipped = await otherWorker.$transaction(tx => tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Command" WHERE "id" = ${blocked.command.id}
          FOR UPDATE SKIP LOCKED`);
        expect(skipped).toEqual([]);
      } finally {
        releaseLock();
        await rowLock;
      }
      const missing = await runDisposableProtectedCommandRetentionBatch(worker, digest,
        { maxCandidates: 2, disposableToken: token });
      expect(missing).toMatchObject({ deleted: 0, blockedByReason: { drain_evidence_unavailable: 2 } });
      expect(await owner.command.count({ where: { id: eligible.command.id } })).toBe(1);
      await owner.commandRetentionAttempt.deleteMany();
      await barrier.refresh(1);
      expect(await worker.$queryRaw`SELECT * FROM command_protected.purge_barrier_snapshot(1)`)
        .toEqual([expect.objectContaining({ healthy: true })]);
      expect(await worker.$transaction(tx => barrier.assertReady(tx, 1))).toMatchObject({
        ready: false, reason: "drain_wait_pending" });
      await new Promise(resolve => setTimeout(resolve, 10100));
      await barrier.refresh(1);
      // The test alone grants the read-only verifier so rejection cannot be
      // accidentally attributed to another candidate/hold safety check.
      cluster.sql(url, `GRANT EXECUTE ON FUNCTION command_protected.valid_purge_barrier(TEXT,INTEGER,TEXT)
        TO command_retention_worker`);
      const boundaryId = await worker.$transaction(async tx => {
        const ready = await barrier.assertReady(tx, 1);
        expect(ready.ready).toBe(true);
        if (!ready.ready) throw new Error("barrier fixture unavailable");
        const evidenceId = await storeDisposableBarrierEvidence(tx, ready.evidence.proof, signer);
        expect(await tx.$queryRaw`SELECT command_protected.valid_purge_barrier(${evidenceId}, 1,
          ${barrier.workerBootId}) AS valid`).toEqual([{ valid: true }]);
        expect(await tx.$queryRaw`SELECT command_protected.valid_purge_barrier(${evidenceId}, 2,
          ${barrier.workerBootId}) AS valid`).toEqual([{ valid: false }]);
        expect(await tx.$queryRaw`SELECT command_protected.valid_purge_barrier(${evidenceId}, 1,
          ${randomUUID()}) AS valid`).toEqual([{ valid: false }]);
        const forged = await storeDisposableBarrierEvidence(tx, ready.evidence.proof,
          { ...signer, secret: randomBytes(32) });
        expect(await tx.$queryRaw`SELECT command_protected.valid_purge_barrier(${forged}, 1,
          ${barrier.workerBootId}) AS valid`).toEqual([{ valid: false }]);
        const boundary = await owner!.command.create({ data: { siteId: site.id, requestedBy: user.id,
          clientRequestId: randomUUID(), requestFingerprint: "boundary", targetType: "fixtures",
          targetFixtureIds: [fixture.id], brightness: 70, createdAt: new Date(ready.evidence.proof.cutoff) } });
        await tx.$queryRaw`SELECT set_config('command.purge_evidence', ${evidenceId}, true),
          set_config('command.purge_generation', '1', true),
          set_config('command.purge_boot', ${barrier.workerBootId}, true)`;
        expect(await tx.$queryRaw`SELECT command_protected.delete_expired_command_candidate(${boundary.id}, NULL)
          AS deleted`).toEqual([{ deleted: false }]);
        expect(await tx.command.count({ where: { id: boundary.id } })).toBe(1);
        return boundary.id;
      });
      // Keep this boundary fixture outside later transactions' moving cutoff.
      await owner.command.update({ where: { id: boundaryId }, data: { createdAt: new Date() } });
      const result = await runDisposableProtectedCommandRetentionBatch(worker, digest,
        { maxCandidates: 2, disposableToken: token, barrier: barrierOptions });
      expect(result.blockedByReason).toEqual({ command_outbox_not_settled: 1 });
      expect(result).toMatchObject({ examined: 2, deleted: 1, overdueCount: 1,
        blockedByReason: { command_outbox_not_settled: 1 } });
      expect(await owner.command.count({ where: { id: blocked.command.id } })).toBe(1);
      expect(await owner.unresolvedCommandHold.count({ where: { originalCommandId: blocked.command.id } })).toBe(0);
      expect(await owner.command.count({ where: { id: eligible.command.id } })).toBe(0);
      expect(await owner.commandDispatch.count({ where: { id: eligible.dispatch.id } })).toBe(0);
      expect(await owner.unresolvedCommandHold.count({ where: { originalCommandId: eligible.command.id } })).toBe(1);
      const hold = await owner.unresolvedCommandHold.findUniqueOrThrow({ where: { originalCommandId: eligible.command.id } });
      const recovery = await owner.recoveryDispatch.create({ data: { holdId: hold.id, gatewayId: gateway.id,
        sequence: 80n, idempotencyKey: randomUUID(), verificationAttempt: 1, chunkIndex: 0,
        targets: { create: { fixtureId: fixture.id } } } });
      const recoveryTopic = `sites/${site.id}/gateways/${gateway.id}/commands/status-check`;
      await owner.recoveryOutbox.create({ data: { dispatchId: recovery.id, topic: recoveryTopic,
        payload: { siteId: site.id, gatewayId: gateway.id, commandId: eligible.command.id,
          originalCommandId: eligible.command.id, dispatchId: recovery.id, idempotencyKey: recovery.idempotencyKey,
          sequence: 80, targetFixtureIds: [fixture.id], expectedBrightness: 70,
          verificationAttempt: 1, requestedAt: new Date().toISOString() } } });
      const published: Array<{ topic: string; payload: unknown }> = [];
      const recoveryPublisher = new RecoveryOutboxPublisherService(owner as never,
        { publishTopic: async (topic: string, payload: unknown) => { published.push({ topic, payload }); } } as never,
        new AutomationSnapshotService({ now: () => new Date() } as never));
      process.env.COMMAND_RECOVERY_PUBLISHER_READY = "1";
      await recoveryPublisher.processBatch();
      delete process.env.COMMAND_RECOVERY_PUBLISHER_READY;
      expect(published).toHaveLength(1);
      expect(published[0].topic).toBe(recoveryTopic);
      expect(gatewayStatusCheckCommandPublishedV2Schema.parse(published[0].payload))
        .toMatchObject({ originalCommandId: eligible.command.id, dispatchId: recovery.id });
      expect(await owner.recoveryDispatch.findUniqueOrThrow({ where: { id: recovery.id } }))
        .toMatchObject({ status: "published" });
      expect(await owner.commandReplayFence.count({ where: { siteId: site.id } })).toBe(1);
      expect(await owner.commandRetentionAttempt.findUniqueOrThrow({ where: {
        commandId: blocked.command.id } })).toMatchObject({ reasonCode: "command_outbox_not_settled",
          attemptCount: 1 });
      const retry = await runDisposableProtectedCommandRetentionBatch(otherWorker, digest,
        { maxCandidates: 2, disposableToken: token });
      expect(retry).toMatchObject({ examined: 0, deleted: 0, overdueCount: 1 });
      await owner.command.update({ where: { id: concurrentEligible.command.id },
        data: { createdAt: new Date(createdAt.getTime() + 2) } });
      const concurrent = await Promise.all([worker, otherWorker].map(client =>
        runDisposableProtectedCommandRetentionBatch(client, digest,
          { maxCandidates: 1, disposableToken: token, barrier: barrierOptions })));
      expect(concurrent.reduce((sum, row) => sum + row.deleted, 0)).toBe(1);
      expect(await owner.command.count({ where: { id: concurrentEligible.command.id } })).toBe(0);
      expect(await owner.recoveryDispatch.count({ where: { id: recovery.id } })).toBe(1);
      expect(await owner.unresolvedCommandHold.count({ where: {
        originalCommandId: concurrentEligible.command.id } })).toBe(1);
      const unrelated = await seed(3, true);
      const victim = await seed(4, true);
      await owner.command.update({ where: { id: victim.command.id }, data: {
        status: "acknowledged", outcome: "applied" } });
      const unrelatedKey = digest.sign("set-replay", [site.id, user.id,
        unrelated.command.clientRequestId]);
      await owner.commandReplayFence.create({ data: { siteId: site.id,
        principalSnapshot: user.id, domain: "set-replay",
        keyDigest: unrelatedKey.value, keyVersion: unrelatedKey.keyVersion } });
      const forgedDirectDelete = await worker.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT command_protected.delete_expired_command_candidate(${victim.command.id}, NULL)
          AS deleted`;
      expect(forgedDirectDelete).toEqual([{ deleted: false }]);
      expect(await owner.command.count({ where: { id: victim.command.id } })).toBe(1);
      await owner.commandReplayFence.create({ data: { siteId: site.id,
        principalSnapshot: user.id, domain: "set-replay",
        keyDigest: `hmac-sha256:${"0".repeat(64)}`, keyVersion: 1 } });
      expect(await worker.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT command_protected.delete_expired_command_candidate(${victim.command.id}, NULL)
          AS deleted`).toEqual([{ deleted: false }]);
      const exactSet = digest.sign("set-replay", [site.id, user.id, victim.command.clientRequestId]);
      await owner.commandReplayFence.create({ data: { siteId: site.id,
        principalSnapshot: user.id, domain: "set-replay",
        keyDigest: exactSet.value, keyVersion: exactSet.keyVersion } });
      const legacyRequestId = randomUUID();
      const legacy = await owner.commandDispatch.create({ data: { commandId: victim.command.id,
        gatewayId: gateway.id, kind: "status_check", verificationAttempt: 1,
        clientRequestId: legacyRequestId, idempotencyKey: randomUUID(), sequence: 99n,
        status: "accepted", fixtureResults: { create: { fixtureId: fixture.id } } } });
      await owner.mqttOutbox.create({ data: { dispatchId: legacy.id,
        topic: `sites/${site.id}/gateways/${gateway.id}/commands/status-check`,
        payload: { commandId: victim.command.id, dispatchId: legacy.id,
          targetFixtureIds: [fixture.id], expectedBrightness: 70 },
        publishedAt: new Date("2026-01-31T00:00:02.000Z") } });
      const wrongGlobal = digest.sign("legacy-status-check-global", [randomUUID()]);
      await owner.commandReplayFence.create({ data: { siteId: site.id,
        principalSnapshot: "__legacy_global__", domain: "legacy-status-check-global",
        keyDigest: wrongGlobal.value, keyVersion: wrongGlobal.keyVersion } });
      const wrongDispatch = digest.sign("legacy-status-check-dispatch", [unrelated.dispatch.id]);
      await owner.legacyStatusCheckDispatchFence.create({ data: { siteId: site.id,
        dispatchDigest: wrongDispatch.value, keyVersion: wrongDispatch.keyVersion } });
      expect(await worker.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT command_protected.delete_expired_command_candidate(${victim.command.id}, NULL)
          AS deleted`).toEqual([{ deleted: false }]);
      expect(await owner.command.count({ where: { id: victim.command.id } })).toBe(1);
      const manualVictim = await seed(5, true);
      await owner.command.update({ where: { id: manualVictim.command.id }, data: {
        status: "acknowledged", outcome: "applied" } });
      const manualFence = digest.sign("set-replay", [site.id, user.id,
        manualVictim.command.clientRequestId]);
      await owner.commandReplayFence.create({ data: { siteId: site.id,
        principalSnapshot: user.id, domain: "set-replay",
        keyDigest: manualFence.value, keyVersion: manualFence.keyVersion } });
      const manualOverride = await owner.manualOverride.create({ data: { siteId: site.id,
        gatewayId: gateway.id, commandId: manualVictim.command.id, requestedById: user.id,
        brightnessPercent: 70, startedAt: createdAt, overrideUntil: null,
        fixtures: { create: { fixtureId: fixture.id } } } });
      const manualCopy = await owner.automationExecution.create({ data: { siteId: site.id,
        gatewayId: gateway.id, eventId: randomUUID(), sequence: 101n, revision: 1,
        manualOverrideId: manualOverride.id, kind: "action_result", occurredAt: createdAt,
        payload: { sourceType: "manual_override", sourceId: manualOverride.id, results: [] } } });
      expect(await worker.$queryRaw<Array<{ detached: boolean }>>`
        SELECT command_protected.detach_expired_manual_source(${manualOverride.id}) AS detached`)
        .toEqual([{ detached: true }]);
      expect((await owner.manualOverride.findUniqueOrThrow({ where: { id: manualOverride.id } }))
        .commandId).toBeNull();
      expect(await worker.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT command_protected.delete_expired_command_candidate(${manualVictim.command.id}, NULL)
          AS deleted`).toEqual([{ deleted: false }]);
      expect(await worker.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT command_protected.delete_expired_command_candidate(
          ${manualVictim.command.id}, ${randomUUID()}) AS deleted`).toEqual([{ deleted: false }]);
      expect(await worker.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT command_protected.delete_expired_command_candidate(
          ${manualVictim.command.id}, ${manualOverride.id}) AS deleted`).toEqual([{ deleted: false }]);
      expect(await owner.command.count({ where: { id: manualVictim.command.id } })).toBe(1);
      expect(await owner.automationExecution.count({ where: { id: manualCopy.id } })).toBe(1);
      const exactGlobal = digest.sign("legacy-status-check-global", [legacyRequestId]);
      await owner.commandReplayFence.create({ data: { siteId: site.id,
        principalSnapshot: "__legacy_global__", domain: "legacy-status-check-global",
        keyDigest: exactGlobal.value, keyVersion: exactGlobal.keyVersion } });
      expect(await worker.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT command_protected.delete_expired_command_candidate(${victim.command.id}, NULL)
          AS deleted`).toEqual([{ deleted: false }]);
      const exactDispatch = digest.sign("legacy-status-check-dispatch", [legacy.id]);
      await owner.legacyStatusCheckDispatchFence.create({ data: { siteId: site.id,
        dispatchDigest: exactDispatch.value, keyVersion: exactDispatch.keyVersion } });
      await owner.$executeRaw`DELETE FROM command_protected.command_safety_verify_key
        WHERE "keyVersion" = 1`;
      expect(await worker.$queryRaw<Array<{ deleted: boolean }>>`
        SELECT command_protected.delete_expired_command_candidate(${victim.command.id}, NULL)
          AS deleted`).toEqual([{ deleted: false }]);
      expect(await owner.command.count({ where: { id: victim.command.id } })).toBe(1);
      await owner.$executeRaw`INSERT INTO command_protected.command_safety_verify_key
        ("keyVersion", "secret") VALUES (1, ${Buffer.from(key, "base64url")})`;
      for (const [credential, statement] of [
        [runtimeUrl.toString(), `DELETE FROM public."Command" WHERE "id"='${blocked.command.id}'`],
        [runtimeUrl.toString(), `SELECT command_protected.delete_expired_command_candidate('${blocked.command.id}',NULL)`],
        [workerUrl.toString(), `DELETE FROM public."Command" WHERE "id"='${blocked.command.id}'`],
        [workerUrl.toString(), `SELECT * FROM command_protected.manual_source_key`],
        [workerUrl.toString(), `SELECT * FROM command_protected.retired_manual_source_proof`],
        [workerUrl.toString(), `SELECT * FROM command_protected.command_safety_verify_key`],
        [workerUrl.toString(), `SELECT * FROM command_protected.purge_barrier_verify_key`],
        [runtimeUrl.toString(), `INSERT INTO public."CommandPurgeBarrierEvidence" ("id") VALUES ('forged')`],
        [workerUrl.toString(), `SELECT command_protected.matches_exact_command_digest('set-replay',ARRAY['x'],'x',1)`],
        [workerUrl.toString(), `TRUNCATE public."Command"`]
      ]) {
        const attempt = spawnSync("psql", [credential, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", statement],
          { encoding: "utf8", timeout: 30_000 });
        expect(attempt.status).not.toBe(0);
        expect(attempt.stderr).toMatch(/permission denied/);
      }
      expect(cluster.sql(url, `SELECT command_protected.three_calendar_months_before_utc(
        '2026-05-31T12:00:00Z')`)).toBe("2026-02-28 12:00:00");
      expect(cluster.sql(url, `SELECT command_protected.three_calendar_months_before_utc(
        '2026-02-28T12:00:00Z')`)).toBe("2025-11-28 12:00:00");
      expect(cluster.sql(url, `SELECT command_protected.three_calendar_months_before_utc(
        '2026-01-31T12:00:00Z')`)).toBe("2025-10-31 12:00:00");
      await owner.$executeRaw`UPDATE command_protected.purge_clock_attestation SET "healthy" = false WHERE "generation" = 1`;
      await expect(owner.$executeRaw`UPDATE command_protected.purge_clock_attestation SET "healthy" = true WHERE "generation" = 1`)
        .rejects.toThrow("continuity");
      await expect(owner.$executeRaw`UPDATE command_protected.purge_clock_attestation SET "primaryId" = 'changed' WHERE "generation" = 1`)
        .rejects.toThrow("continuity");
    } finally {
      delete process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION;
      delete process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
      delete process.env.COMMAND_RUNTIME_DB_ROLE;
      delete process.env.COMMAND_RECOVERY_PUBLISHER_READY;
      await otherWorker?.$disconnect();
      await worker?.$disconnect();
      await owner?.$disconnect();
      cluster.stop();
    }
  });
});
