import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { redactSettledCommandDetails } from "./command-detail-redaction";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { canonicalExecutionPayloadHash, AutomationMqttConsumerService } from "../automation/automation-mqtt-consumer.service";
import { mqttTopics } from "@led-control/shared";
import { CommandSafetyDigest } from "../commands/command-safety-digest";

const enabled = process.env.COMMAND_DETAIL_REDACTION_TEST === "1";
(enabled ? describe : describe.skip)("atomic command detail redaction on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let siteId: string;
  let gatewayId: string;
  let fixtureId: string;
  let floorId: string;
  let sequence = 0n;
  let cutoff: Date;
  const originalActiveVersion = process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION;
  const originalKeys = process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
  beforeAll(async () => {
    process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = "1";
    process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = JSON.stringify({ 1: Buffer.alloc(32, 7).toString("base64url") });
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    cutoff = (await db.$queryRaw<Array<{ cutoff: Date }>>`SELECT
      (transaction_timestamp() AT TIME ZONE 'UTC') - INTERVAL '3 months' AS cutoff`)[0].cutoff;
    const org = await db.organization.create({ data: { name: "Redaction fixture" } });
    siteId = (await db.site.create({ data: { organizationId: org.id, name: "Site" } })).id;
    gatewayId = (await db.gateway.create({ data: { siteId, name: "Gateway", serialNumber: randomUUID(), firmwareVersion: "test" } })).id;
    const floor = await db.floor.create({ data: { siteId, name: "Floor", level: 1 } });
    floorId = floor.id;
    const node = await db.meshNode.create({ data: { gatewayId, deviceUuid: randomUUID(), meshAddress: "0x0100", firmwareVersion: "test" } });
    fixtureId = (await db.fixture.create({ data: { siteId, floorId: floor.id, gatewayId, meshNodeId: node.id,
      name: "Light", ratedWatt: 40, x: 1, y: 1 } })).id;
  }, 40_000);
  afterAll(async () => {
    await db?.$disconnect(); cluster?.stop();
    if (originalActiveVersion === undefined) delete process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION;
    else process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = originalActiveVersion;
    if (originalKeys === undefined) delete process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
    else process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = originalKeys;
  });

  async function seed(createdAt = new Date(cutoff.getTime() - 1)) {
    const command = await db.command.create({ data: { siteId, clientRequestId: randomUUID(),
      requestFingerprint: "private fingerprint", targetType: "fixtures", targetFixtureIds: [fixtureId],
      brightness: 73, outcome: "applied", status: "acknowledged", createdAt } });
    const dispatch = await db.commandDispatch.create({ data: { commandId: command.id, gatewayId,
      idempotencyKey: randomUUID(), sequence: ++sequence, status: "completed", completedAt: createdAt,
      destinationAddress: "0x0100", errorMessage: "private detail",
      fixtureResults: { create: { fixtureId, status: "succeeded", brightness: 73 } },
      outbox: { create: { topic: "test/command", payload: { commandId: command.id, brightness: 73 }, publishedAt: createdAt } }
    } });
    return { command, dispatch };
  }
  async function redact(id: string) {
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Command" WHERE "id" = ${id} FOR UPDATE`;
      return redactSettledCommandDetails(tx, id, cutoff);
    });
  }

  async function seedManual(legacyAlias = false) {
    const seeded = await seed();
    const override = await db.manualOverride.create({ data: { siteId, gatewayId, commandId: seeded.command.id,
      brightnessPercent: 73, startedAt: new Date(seeded.command.createdAt.getTime() - 1000),
      overrideUntil: seeded.command.createdAt, endedAt: seeded.command.createdAt,
      fixtures: { create: { fixtureId } } } });
    const event = { schemaVersion: 1 as const, gatewayId, eventId: randomUUID(), sequence: Number(++sequence),
      revision: 1, ruleId: null, occurrenceKey: null, kind: "action_result" as const,
      occurredAt: seeded.command.createdAt.toISOString(), payload: { sourceType: "manual_override" as const,
        sourceId: legacyAlias ? override.id : seeded.command.id, results: [{ fixtureId, status: "succeeded" as const,
          brightnessPercent: 73, faultCode: null, errorCode: null, occurredAt: seeded.command.createdAt.toISOString() }] } };
    const reportPayloadHash = canonicalExecutionPayloadHash(event);
    const execution = await db.automationExecution.create({ data: { siteId, gatewayId, manualOverrideId: override.id,
      eventId: event.eventId, sequence: BigInt(event.sequence), revision: 1, kind: "action_result",
      occurredAt: seeded.command.createdAt, payload: event.payload, payloadHash: reportPayloadHash,
      fixtureResults: { create: { fixtureSnapshotId: fixtureId, fixtureId, status: "succeeded",
        brightnessPercent: 73, occurredAt: seeded.command.createdAt } } } });
    const ack = { schemaVersion: 1, gatewayId, eventId: event.eventId, sequence: event.sequence,
      reportPayloadHash, ingestedAt: seeded.command.createdAt.toISOString() };
    const outbox = await db.mqttOutbox.create({ data: { gatewayId,
      applicationAckKey: `automation-execution:${gatewayId}:${event.eventId}:${event.sequence}:${reportPayloadHash}`,
      topic: mqttTopics.automationExecutionIngested(siteId, gatewayId), payload: ack,
      payloadHash: canonicalPayloadHash(ack), publishedAt: seeded.command.createdAt } });
    return { ...seeded, override, execution, event, outbox };
  }

  it("removes target/result/wire details while retaining command and dispatch dedupe identities", async () => {
    const { command, dispatch } = await seed();
    expect(await redact(command.id)).toBe("redacted");
    expect(await db.command.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({
      clientRequestId: command.clientRequestId, contentRedactedAt: expect.any(Date),
      targetFixtureIds: null, brightness: null, requestFingerprint: null, errorMessage: null
    });
    expect(await db.commandDispatch.findUniqueOrThrow({ where: { id: dispatch.id } })).toMatchObject({
      idempotencyKey: dispatch.idempotencyKey, sequence: dispatch.sequence, status: "completed",
      destinationAddress: null, errorMessage: null
    });
    expect(await db.commandFixtureResult.count({ where: { dispatchId: dispatch.id } })).toBe(0);
    expect(await db.mqttOutbox.count({ where: { dispatchId: dispatch.id } })).toBe(0);
    expect(await redact(command.id)).toBe("already_redacted");
    await expect(db.commandDispatch.update({ where: { id: dispatch.id }, data: { errorMessage: "late raw ACK" } })).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "Command" SET "contentRedactedAt" = NULL,
      "requestFingerprint" = 'restored', "targetType" = 'fixtures', "targetFixtureIds" = '[]', "brightness" = 73
      WHERE "id" = ${command.id}`).rejects.toThrow();
  });

  it("retains the exact cutoff and rolls back every copy for unresolved outcome", async () => {
    const exact = await seed(cutoff);
    await expect(redact(exact.command.id)).rejects.toMatchObject({ reasonCode: "command_not_expired" });
    const unknown = await seed();
    await db.command.update({ where: { id: unknown.command.id }, data: { outcome: "unknown" } });
    await expect(redact(unknown.command.id)).rejects.toMatchObject({ reasonCode: "command_unresolved" });
    expect(await db.command.findUniqueOrThrow({ where: { id: unknown.command.id } })).toMatchObject({ brightness: 73, contentRedactedAt: null });
    expect(await db.mqttOutbox.count({ where: { dispatchId: unknown.dispatch.id } })).toBe(1);
    expect(await db.commandFixtureResult.count({ where: { dispatchId: unknown.dispatch.id } })).toBe(1);
  });

  it.each(["pending", "lease", "hold"])("blocks %s obligations before deleting any detail", async kind => {
    const { command, dispatch } = await seed();
    if (kind === "pending") await db.commandDispatch.update({ where: { id: dispatch.id }, data: { status: "accepted" } });
    if (kind === "lease") await db.mqttOutbox.update({ where: { dispatchId: dispatch.id }, data: { lockedBy: "publisher", leaseExpiresAt: new Date() } });
    if (kind === "hold") await db.unresolvedCommandHold.create({ data: { siteId, gatewayId, originalCommandId: command.id,
      originalCreatedAt: command.createdAt, reasonCode: "outcome_unknown" } });
    await expect(redact(command.id)).rejects.toMatchObject({ reasonCode: kind === "pending" ? "dispatch_unsettled"
      : kind === "lease" ? "outbox_unsettled" : "command_hold_exists" });
    expect(await db.command.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ brightness: 73, contentRedactedAt: null });
    expect(await db.commandFixtureResult.count({ where: { dispatchId: dispatch.id } })).toBe(1);
  });

  it.each([false, true])("redacts ended manual parents and consumes exact replay without durable raw ACK (legacy alias=%s)", async legacyAlias => {
    const seeded = await seedManual(legacyAlias);
    expect(await redact(seeded.command.id)).toBe("redacted");
    expect(await db.manualOverride.findUniqueOrThrow({ where: { id: seeded.override.id } })).toMatchObject({
      commandId: seeded.command.id, brightnessPercent: null, targetCount: 0, contentRedactedAt: expect.any(Date)
    });
    expect(await db.automationExecution.findUniqueOrThrow({ where: { id: seeded.execution.id } })).toMatchObject({
      manualOverrideId: seeded.override.id, payload: null, payloadHash: null, contentRedactedAt: expect.any(Date)
    });
    expect(await db.automationExecutionFixtureResult.count({ where: { executionId: seeded.execution.id } })).toBe(0);
    expect(await db.manualOverrideFixture.count({ where: { manualOverrideId: seeded.override.id } })).toBe(0);
    expect(await db.mqttOutbox.findUnique({ where: { id: seeded.outbox.id } })).toBeNull();
    const consumer = new AutomationMqttConsumerService(db as never, {} as never, { now: () => new Date() });
    jest.spyOn(consumer as any, "lockCurrentGatewayIdentity").mockResolvedValue(true);
    expect(await consumer.onExecution({ siteId, gatewayId }, seeded.event)).toMatchObject({
      publishAfterAck: { topic: mqttTopics.automationExecutionIngested(siteId, gatewayId),
        payload: { eventId: seeded.event.eventId, reportPayloadHash: canonicalExecutionPayloadHash(seeded.event) } }
    });
    expect(await db.mqttOutbox.count({ where: { applicationAckKey: { startsWith: `automation-execution:${gatewayId}:${seeded.event.eventId}:` } } })).toBe(0);
    await expect(db.$executeRaw`UPDATE "ManualOverride" SET "brightnessPercent" = 73 WHERE "id" = ${seeded.override.id}`).rejects.toThrow();
    await expect(db.$executeRaw`UPDATE "AutomationExecution" SET "payload" = ${JSON.stringify(seeded.event.payload)}::jsonb WHERE "id" = ${seeded.execution.id}`).rejects.toThrow();
    await expect(db.manualOverrideFixture.create({ data: { manualOverrideId: seeded.override.id, fixtureId, siteId, gatewayId } })).rejects.toThrow();
  });

  it("preserves every raw copy for active override and unverifiable manual ACK", async () => {
    const seeded = await seedManual();
    await db.manualOverride.update({ where: { id: seeded.override.id }, data: { endedAt: null } });
    await expect(redact(seeded.command.id)).rejects.toMatchObject({ reasonCode: "manual_override_active" });
    await db.manualOverride.update({ where: { id: seeded.override.id }, data: { endedAt: seeded.command.createdAt } });
    await db.mqttOutbox.update({ where: { id: seeded.outbox.id }, data: { payloadHash: `sha256:${"0".repeat(64)}` } });
    await expect(redact(seeded.command.id)).rejects.toMatchObject({ reasonCode: "manual_execution_unverifiable" });
    expect(await db.command.findUniqueOrThrow({ where: { id: seeded.command.id } })).toMatchObject({ brightness: 73 });
    expect(await db.automationExecution.findUniqueOrThrow({ where: { id: seeded.execution.id } })).toMatchObject({ payload: seeded.event.payload });
  });

  it("removes linked activity sources and completed recommission snapshots atomically", async () => {
    const { command } = await seed();
    const activity = await db.monitoringActivity.create({ data: { siteId, floorId, sourceType: "command",
      sourceKey: `${command.id}:applied`, kind: "command_result", commandOutcome: "applied" } });
    const job = await db.gatewayRecommissionJob.create({ data: { siteId, gatewayId, inventoryId: randomUUID(),
      serialNumber: "past-installation", resetDigest: "retry-identity", status: "finalized", appliedAt: new Date(),
      targetSnapshot: { appliedClaimCodeHashDigest: "proof", deletionIds: { command: [command.id] } }, objectKeys: [] } });
    expect(await redact(command.id)).toBe("redacted");
    expect(await db.monitoringActivity.findUnique({ where: { id: activity.id } })).toBeNull();
    expect((await db.gatewayRecommissionJob.findUniqueOrThrow({ where: { id: job.id } })).targetSnapshot)
      .toEqual({ appliedClaimCodeHashDigest: "proof" });
  });

  it("does not guess the owner of legacy ACK hashes and leaves all details intact", async () => {
    const { command, dispatch } = await seed();
    const ledger = await db.processedGatewayEvent.create({ data: { eventId: randomUUID(), gatewayId,
      eventType: "device_status_ack", sequence: ++sequence, payloadHash: `sha256:${"a".repeat(64)}`, occurredAt: new Date() } });
    try {
      await expect(redact(command.id)).rejects.toMatchObject({ reasonCode: "legacy_ack_attribution_unverifiable" });
      expect(await db.command.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ brightness: 73, contentRedactedAt: null });
      expect(await db.mqttOutbox.count({ where: { dispatchId: dispatch.id } })).toBe(1);
    } finally { await db.processedGatewayEvent.delete({ where: { eventId: ledger.eventId } }); }
  });

  it("rolls back earlier manual receipt and detail work if a later snapshot is unverifiable", async () => {
    const seeded = await seedManual();
    const job = await db.gatewayRecommissionJob.create({ data: { siteId, gatewayId, inventoryId: randomUUID(),
      serialNumber: "in-progress", resetDigest: "retry-identity", status: "prepared",
      targetSnapshot: { command: seeded.command.id }, objectKeys: [] } });
    try {
      await expect(redact(seeded.command.id)).rejects.toMatchObject({ reasonCode: "recommission_job_active" });
      expect(await db.automationExecution.findUniqueOrThrow({ where: { id: seeded.execution.id } })).toMatchObject({ payload: seeded.event.payload });
      expect(await db.manualExecutionReplayReceipt.count({ where: { eventId: seeded.event.eventId } })).toBe(0);
    } finally { await db.gatewayRecommissionJob.delete({ where: { id: job.id } }); }
  });

  it("rejects missing proof, wrong replay, fresh late event and legacy alias without restoring detail", async () => {
    const seeded = await seedManual();
    await redact(seeded.command.id);
    const consumer = new AutomationMqttConsumerService(db as never, {} as never, { now: () => new Date() });
    jest.spyOn(consumer as any, "lockCurrentGatewayIdentity").mockResolvedValue(true);
    const wrong = { ...seeded.event, payload: { ...seeded.event.payload,
      results: [{ ...seeded.event.payload.results[0], brightnessPercent: 12 }] } };
    await expect(consumer.onExecution({ siteId, gatewayId }, wrong)).rejects.toThrow();
    for (const sourceId of [seeded.command.id, seeded.override.id]) {
      await expect(consumer.onExecution({ siteId, gatewayId }, { ...seeded.event, eventId: randomUUID(),
        payload: { ...seeded.event.payload, sourceId } })).rejects.toMatchObject({ status: 503 });
    }
    const keyring = process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
    process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = "{}";
    try { await expect(consumer.onExecution({ siteId, gatewayId }, seeded.event)).rejects.toMatchObject({ status: 503 }); }
    finally { process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = keyring; }
    await db.manualExecutionReplayReceipt.deleteMany({ where: { eventId: seeded.event.eventId } });
    await expect(consumer.onExecution({ siteId, gatewayId }, seeded.event)).rejects.toMatchObject({ status: 503 });
    expect(await db.mqttOutbox.count({ where: { applicationAckKey: { startsWith: `automation-execution:${gatewayId}:${seeded.event.eventId}:` } } })).toBe(0);
  });

  it.each(["UTC", "Asia/Seoul", "America/New_York"])("keeps the caller's UTC cutoff exact under %s session", async zone => {
    const exact = await seed(cutoff);
    const before = await seed(new Date(cutoff.getTime() - 1));
    const invoke = (id: string) => db.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
      await tx.$queryRaw`SELECT "id" FROM "Command" WHERE "id" = ${id} FOR UPDATE`;
      return redactSettledCommandDetails(tx, id, cutoff);
    });
    await expect(invoke(exact.command.id)).rejects.toMatchObject({ reasonCode: "command_not_expired" });
    expect(await invoke(before.command.id)).toBe("redacted");
  });

  it("keeps a terminal dispatch with pending fixture results and a future-ended override ineligible", async () => {
    const pending = await seed();
    await db.commandFixtureResult.update({ where: { dispatchId_fixtureId: { dispatchId: pending.dispatch.id, fixtureId } }, data: { status: "pending" } });
    await expect(redact(pending.command.id)).rejects.toMatchObject({ reasonCode: "fixture_result_unsettled" });
    const manual = await seedManual();
    const future = new Date(Date.now() + 86_400_000);
    await db.manualOverride.update({ where: { id: manual.override.id }, data: { overrideUntil: future, endedAt: future } });
    await expect(redact(manual.command.id)).rejects.toMatchObject({ reasonCode: "manual_override_active" });
  });

  it("does not lose an orphaned legacy Override-ID execution when Command cannot identify its raw alias", async () => {
    const seeded = await seedManual(true);
    await db.manualOverride.delete({ where: { id: seeded.override.id } });
    try {
      await expect(redact(seeded.command.id)).rejects.toMatchObject({ reasonCode: "manual_source_attribution_unverifiable" });
      expect(await db.command.findUniqueOrThrow({ where: { id: seeded.command.id } })).toMatchObject({ brightness: 73 });
    } finally {
      await db.automationExecution.delete({ where: { id: seeded.execution.id } });
      await db.mqttOutbox.delete({ where: { id: seeded.outbox.id } });
    }
  });

  it("does not silently leave an activity signed with an unavailable historical key", async () => {
    const { command } = await seed();
    const signed = new CommandSafetyDigest({ activeVersion: 2, keys: { 2: Buffer.alloc(32, 8).toString("base64url") } })
      .sign("monitoring-activity", [siteId, command.id, "applied"]);
    const activity = await db.monitoringActivity.create({ data: { siteId, floorId, sourceType: "command",
      sourceKey: `v2:${signed.value}`, kind: "command_result", commandOutcome: "applied" } });
    try {
      await expect(redact(command.id)).rejects.toMatchObject({ reasonCode: "activity_source_key_unavailable" });
      expect(await db.command.findUniqueOrThrow({ where: { id: command.id } })).toMatchObject({ brightness: 73 });
    } finally { await db.monitoringActivity.delete({ where: { id: activity.id } }); }
  });
});
