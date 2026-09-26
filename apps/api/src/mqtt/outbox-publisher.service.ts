import { Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { CommandDispatchKind, Prisma } from "@prisma/client";
import {
  createGatewayCommandExpiry,
  GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS,
  GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS,
  GatewayDimmingCommandDraftV2,
  GatewayDimmingCommandPublishedV2,
  GatewayDimmingCommandEpochPublishedV2,
  gatewayDimmingCommandEpochPublishedV2Schema,
  gatewayDimmingCommandDraftV2CompatibilitySchema,
  gatewayDimmingCommandDraftV2Schema,
  gatewayDimmingCommandPublishedV2Schema,
  gatewayDimmingCommandV2CompatibilitySchema,
  GatewayStatusCheckCommandDraftV2,
  GatewayStatusCheckCommandPublishedV2,
  gatewayStatusCheckCommandDraftV2Schema,
  gatewayStatusCheckCommandPublishedV2Schema,
  remainingGatewayCommandMessageExpiry
} from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PrismaService } from "../prisma/prisma.service";
import { AutomationClock } from "../automation/automation-clock";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { MqttService } from "./mqtt.service";
import { CommandSetMqttService } from "./command-set-mqtt.service";
import { CommandPublishEpochService } from "./command-publish-epoch.service";
import { CommandDbClockHealth } from "./command-db-clock-health.service";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";

const LEASE_MS = 30_000;
const MQTT_PUBLISH_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 10;
const MAX_AGE_MS = 15 * 60_000;
// The future purge worker must take the exclusive variant of this same global
// permit before quiescing a generation. It must release its automation lock
// before waiting for the permit, preserving automation -> permit ordering.
export const COMMAND_PUBLISH_PERMIT_KEY = 8052026092501n;
const PUBLISH_PERMIT_TRANSACTION_TIMEOUT_MS = MQTT_PUBLISH_TIMEOUT_MS + 5_000;

type PublisherOptions = {
  workerId?: string;
  random?: () => number;
  pollMs?: number;
  clock?: () => Date;
  deliveryGeneration?: () => string;
};

@Injectable()
export class OutboxPublisherService implements OnModuleInit {
  private readonly logger = new Logger(this.constructor.name);
  private readonly workerId: string;
  private readonly random: () => number;
  private readonly pollMs: number;
  private readonly clock: () => Date;
  private readonly deliveryGeneration: () => string;
  private timer: NodeJS.Timeout | null = null;
  private activeBatch: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;

  protected get dispatchKind(): CommandDispatchKind { return "dimming"; }

  get publishWorkerId() { return this.workerId; }

  private get epochEnabled() {
    return this.dispatchKind === "dimming" && (process.env.COMMAND_RETENTION_PUBLISH_FENCE === "1" ||
      process.env.COMMAND_SET_EGRESS_ENABLED === "1");
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    @Optional() options: PublisherOptions = {},
    @Optional() private readonly automationSnapshot: AutomationSnapshotService = new AutomationSnapshotService(new AutomationClock()),
    @Optional() private readonly commandSetMqtt?: CommandSetMqttService,
    @Optional() private readonly epochs: CommandPublishEpochService = new CommandPublishEpochService(),
    @Optional() private readonly dbClockHealth: CommandDbClockHealth = new CommandDbClockHealth()
  ) {
    this.workerId = options.workerId ?? (this.dispatchKind === "dimming" ? process.env.MQTT_API_INSTANCE_ID?.trim() : undefined) ?? randomUUID();
    this.random = options.random ?? Math.random;
    this.pollMs = options.pollMs ?? Number(process.env.MQTT_OUTBOX_POLL_MS ?? 1000);
    this.clock = options.clock ?? (() => new Date());
    this.deliveryGeneration = options.deliveryGeneration ?? randomUUID;
  }

  onModuleInit() {
    this.stopped = false;
    void this.runScheduledBatch();
    this.timer = setInterval(() => void this.runScheduledBatch(), this.pollMs);
  }

  stopAndDrain() {
    if (!this.stopPromise) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.stopPromise = this.activeBatch ?? Promise.resolve();
    }
    return this.stopPromise;
  }

  private runScheduledBatch() {
    // setInterval does not await asynchronous callbacks, so one stalled DB transaction must retain the worker slot.
    if (this.stopped || this.activeBatch) return this.activeBatch ?? Promise.resolve();

    const batch = this.processBatch()
      .catch((error) => {
        this.logger.error(`mqtt command outbox batch failed (worker=${this.workerId}, error=${this.errorKind(error)})`);
      })
      .finally(() => {
        this.activeBatch = null;
      });
    this.activeBatch = batch;
    return batch;
  }

  private errorKind(error: unknown) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^P\d{4}$/.test(error.code)
    ) return error.code;
    return "UNEXPECTED_ERROR";
  }

  async claimBatch(now = this.clock()) {
    if (this.stopped) return [];
    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      if (this.epochEnabled) {
        try { now = (await this.admitSet(tx)).now; }
        catch (error) { if (error instanceof SetAdmissionError) return []; throw error; }
      }
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "MqttOutbox"
        WHERE "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND "dispatchId" IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM "CommandDispatch" AS dispatch
            WHERE dispatch."id" = "MqttOutbox"."dispatchId"
              AND dispatch."kind" = ${this.dispatchKind}::"CommandDispatchKind"
          )
          -- Prisma DateTime columns are UTC-naive TIMESTAMP; compare them to a
          -- UTC timestamp so a non-UTC PostgreSQL session cannot reclaim a live lease.
          AND "nextAttemptAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= (${now}::timestamptz AT TIME ZONE 'UTC'))
          AND NOT EXISTS (
            SELECT 1 FROM "CommandDispatch" AS dispatch
            JOIN "Command" AS command ON command."id" = dispatch."commandId"
            JOIN "GatewayRecommissionJob" AS job
              ON job."siteId" = command."siteId" AND job."gatewayId" = dispatch."gatewayId"
            WHERE dispatch."id" = "MqttOutbox"."dispatchId"
              AND job."status" IN ('mqtt_revocation_pending', 'mqtt_revoked')
          )
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 50
      `);
      const ids = rows.map((row) => row.id);
      if (ids.length === 0) return [];

      await tx.mqttOutbox.updateMany({
        where: { id: { in: ids }, dispatch: { kind: this.dispatchKind },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        data: { lockedBy: this.workerId, lockedAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
      });
      const records = await tx.mqttOutbox.findMany({
        where: { id: { in: ids }, dispatchId: { not: null }, dispatch: { kind: this.dispatchKind }, lockedBy: this.workerId },
        include: {
          dispatch: {
            select: {
              commandId: true,
              kind: true,
              gatewayId: true,
              deliveryMode: true,
              destinationAddress: true,
              meshControlGroupId: true,
              meshControlGroupVersion: true
            }
          }
        },
        orderBy: { createdAt: "asc" }
      });
      if (process.env.COMMAND_RETENTION_PUBLISH_CUTOFF === "1") {
        // Claim old rows for terminal convergence, never for a renewed Set/Get
        // delivery generation. Missing parent identity is an integrity failure.
        const commandIds = records.map((record) => record.dispatch?.commandId).filter((id): id is string => !!id);
        const commands = await tx.command.findMany({ where: { id: { in: commandIds } }, select: { id: true, createdAt: true } });
        if (commands.length !== new Set(commandIds).size) throw new Error("command outbox parent missing at claim");
      }
      return records.map((record) => {
        // The command publisher owns only the dispatch-backed MqttOutbox variant; keep the lease update transactional if DB integrity is broken.
        if (record.dispatchId === null || record.dispatch === null) {
          throw new Error("command outbox row is missing its dispatch relation");
        }
        return { ...record, dispatchId: record.dispatchId, dispatch: record.dispatch };
      });
    });
  }

  async processBatch(now = this.clock()) {
    const records = await this.claimBatch(now);
    for (const record of records) {
      // Shutdown waits for a publish already in progress but must not start later records while dependencies are closing.
      if (this.stopped) return;
      await this.publishClaimed(record);
    }
  }

  async publishClaimed(
    record: {
      id: string;
      dispatchId: string;
      topic: string;
      payload: Prisma.JsonValue;
      attempts: number;
      createdAt: Date;
      deliveryAttemptedAt?: Date | null;
      dispatch: {
        commandId: string;
        kind?: CommandDispatchKind;
        gatewayId: string;
        deliveryMode: string;
        destinationAddress: string | null;
        meshControlGroupId: string | null;
        meshControlGroupVersion: number | null;
      };
    }
  ) {
    if (this.stopped) return;
    if ((record.dispatch.kind ?? "dimming") !== this.dispatchKind) return;
    try {
      if (!this.epochEnabled) await this.assertRetainedCommand(this.prisma, record.dispatch.commandId, this.clock());
      const stored = parseStoredCommand(record.payload, record.dispatch.kind);
      if (record.topic !== `sites/${stored.draft.siteId}/gateways/${stored.draft.gatewayId}/commands/${this.dispatchKind === "dimming" ? "dimming" : "status-check"}`) return;
      const prepared = await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        const admission = this.epochEnabled ? await this.admitSet(tx) : null;
        await this.assertRetainedCommand(tx, record.dispatch.commandId, admission?.now ?? this.clock());
        if (stored.kind === "dimming") await this.assertMeshGroupSnapshot(tx, record, stored.draft);
        // Snapshot validation can wait on another transaction; sample again so
        // it cannot refresh an expired lease using a pre-wait timestamp.
        const preparedAt = admission ? (await this.admitSet(tx)).now : this.clock();
        const leaseExpiresAt = new Date(preparedAt.getTime() + LEASE_MS);
        const payload = stored.payload ?? (stored.kind === "status_check"
          ? createPublishedStatusCheckCommand(stored.draft, preparedAt, this.deliveryGeneration())
          : createPublishedDimmingCommand(stored.draft, preparedAt, this.deliveryGeneration(), admission?.generation));
        if (admission) this.assertPayloadEpoch(payload, admission.generation);
        const updated = await tx.mqttOutbox.updateMany({
          where: {
            id: record.id,
            dispatch: { kind: this.dispatchKind },
            lockedBy: this.workerId,
            publishedAt: null,
            deadLetteredAt: null,
            leaseExpiresAt: { gt: preparedAt }
          },
          data: {
            leaseExpiresAt,
            // Compatibility normalization must be durable even if an existing
            // delivery generation is already expired and will never be published.
            payload
          }
        });
        return updated.count === 1 ? { payload, leaseExpiresAt } : null;
      });
      if (!prepared) return;

      const publishable = await this.prisma.mqttOutbox.count({
        where: {
          id: record.id,
          dispatch: { kind: this.dispatchKind },
          lockedBy: this.workerId,
          publishedAt: null,
          deadLetteredAt: null
        }
      });
      if (publishable !== 1) return;

      if (!this.epochEnabled) {
        const publishAt = this.clock();
        if (prepared.leaseExpiresAt.getTime() <= publishAt.getTime() + MQTT_PUBLISH_TIMEOUT_MS) return;
        currentMessageExpiry(prepared.payload, publishAt);
      }

      const attempted = await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        const admission = this.epochEnabled ? await this.admitSet(tx) : null;
        const attemptedAt = admission?.now ?? this.clock();
        await this.assertRetainedCommand(tx, record.dispatch.commandId, attemptedAt);
        currentMessageExpiry(prepared.payload, attemptedAt);
        if (admission) {
          this.assertPayloadEpoch(prepared.payload, admission.generation);
          const eligible = await tx.mqttOutbox.findFirst({ where: {
            id: record.id, dispatch: { kind: "dimming" }, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null,
            leaseExpiresAt: { gt: new Date(attemptedAt.getTime() + MQTT_PUBLISH_TIMEOUT_MS) }
          } });
          if (!eligible || !isDeepStrictEqual(eligible.payload, prepared.payload)) return { count: 0 };
          // The immutable envelope must be inserted BEFORE the old attempt marker:
          // the DB guard refuses retrofitting unknown legacy Set attempts.
          await tx.commandPublishAttempt.create({ data: { id: randomUUID(), generation: admission.generation,
            workerId: this.workerId, dispatchId: record.dispatchId, expiresAt: new Date(prepared.payload.expiresAt) } });
        }
        // Persist before calling MQTT: a lost PUBACK cannot tell whether the broker
        // accepted the Set. A crash after this commit but before the call deliberately
        // remains unknown. Keep the first attempt across reclaims of this generation.
        return tx.mqttOutbox.updateMany({
          where: { id: record.id, dispatch: { kind: this.dispatchKind }, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null,
            leaseExpiresAt: { gt: new Date(attemptedAt.getTime() + MQTT_PUBLISH_TIMEOUT_MS) } },
          data: { deliveryAttemptedAt: record.deliveryAttemptedAt ?? attemptedAt }
        });
      });
      if (attempted.count !== 1) return;
      if (this.epochEnabled) {
        if (!await this.publishUnderRetentionPermit(record, prepared.payload)) return;
      } else {
        const messageExpiryInterval = currentMessageExpiry(prepared.payload, this.clock());
        // The legacy path remains available while all app instances transition.
        // Physical purge must stay OFF until every publisher uses the DB permit.
        await this.assertRetainedCommand(this.prisma, record.dispatch.commandId, this.clock());
        await this.publishWire(record.topic, prepared.payload, messageExpiryInterval);
      }
      const publishedAt = this.clock();
      await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        const released = await tx.mqttOutbox.updateMany({
          where: { id: record.id, dispatch: { kind: this.dispatchKind }, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
          data: {
            payload: prepared.payload,
            publishedAt,
            lastError: null,
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null
          }
        });
        if (released.count !== 1) return;
        await tx.commandDispatch.updateMany({
          where: { id: record.dispatchId, status: "pending" },
          data: { status: "published", publishedAt }
        });
      });
    } catch (error) {
      const failedAt = this.clock();
      const message = error instanceof Error ? error.message : "unknown MQTT publish error";
      const attempts = record.attempts + 1;
      if (error instanceof SetAdmissionError) {
        // Refusal is not an MQTT attempt and must not manufacture legacy attempt
        // evidence or a fresh delivery window. Quiesce/clock loss leaves the row
        // for explicit epoch recovery; already persisted attempt markers survive.
        await this.prisma.mqttOutbox.updateMany({ where: { id: record.id, dispatch: { kind: this.dispatchKind },
          lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null }, data: {
          lockedBy: null, lockedAt: null, leaseExpiresAt: null, lastError: error.message
        } });
        return;
      }
      if (error instanceof StaleMeshGroupError) {
        await this.moveToTerminalFailure(record, attempts, message, failedAt, "MESH_GROUP_STALE");
        return;
      }
      if (error instanceof CommandDeliveryExpiredError) {
        await this.moveToTerminalFailure(record, attempts, message, failedAt, "COMMAND_DELIVERY_EXPIRED");
        return;
      }
      try {
        await this.assertRetainedCommand(this.prisma, record.dispatch.commandId, failedAt);
      } catch (cutoffError) {
        if (!(cutoffError instanceof CommandDeliveryExpiredError)) throw cutoffError;
        await this.moveToTerminalFailure(record, attempts, message, failedAt, "COMMAND_DELIVERY_EXPIRED");
        return;
      }
      const exhausted = attempts >= MAX_ATTEMPTS || failedAt.getTime() - record.createdAt.getTime() >= MAX_AGE_MS;
      if (exhausted) {
        await this.moveToDeadLetter(record, attempts, message, failedAt);
        return;
      }

      const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
      const jitter = Math.floor(delay * 0.2 * this.random());
      await this.prisma.$transaction(async (tx) => {
        await this.automationSnapshot.lockMutation(tx);
        await tx.mqttOutbox.updateMany({
          where: { id: record.id, dispatch: { kind: this.dispatchKind }, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
          data: {
            attempts,
            nextAttemptAt: new Date(failedAt.getTime() + delay + jitter),
            lastError: message,
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null
          }
        });
      });
    }
  }

  private async assertRetainedCommand(db: Pick<Prisma.TransactionClient, "command">, commandId: string, now: Date) {
    if (process.env.COMMAND_RETENTION_PUBLISH_CUTOFF !== "1") return;
    const command = await db.command.findUnique({ where: { id: commandId }, select: { createdAt: true } });
    if (!command || command.createdAt < threeCalendarMonthsBefore(now)) {
      throw new CommandDeliveryExpiredError("command retention cutoff reached");
    }
  }

  private async publishWire(topic: string, payload: unknown, expirySeconds: number) {
    if (this.dispatchKind === "dimming" && process.env.COMMAND_SET_EGRESS_ENABLED === "1") {
      const generation = (payload as { publishEpoch?: number }).publishEpoch;
      if (!generation || !this.commandSetMqtt) throw new Error("command Set epoch egress unavailable");
      this.commandSetMqtt.assertPublisherIdentity(this.workerId, generation);
      await this.commandSetMqtt.publish(generation, topic, payload, expirySeconds);
      return;
    }
    await this.mqtt.publishTopic(topic, payload, { messageExpiryInterval: expirySeconds, timeoutMs: MQTT_PUBLISH_TIMEOUT_MS });
  }

  private async publishUnderRetentionPermit(
    record: { id: string; dispatchId: string; topic: string; dispatch: { commandId: string; gatewayId: string } },
    payload: GatewayDimmingCommandPublishedV2 | GatewayDimmingCommandEpochPublishedV2 | GatewayStatusCheckCommandPublishedV2
  ) {
    // A flag mismatch cannot publish an unchecked Set during a staged rollout.
    if (process.env.COMMAND_RETENTION_PUBLISH_CUTOFF !== "1") {
      throw new Error("command retention publisher cutoff is not enabled");
    }
    return this.prisma.$transaction(async (tx) => {
      const admission = await this.admitSet(tx);
      this.assertPayloadEpoch(payload, admission.generation);
      // Ordinary SELECTs hold no row locks while MQTT waits for PUBACK, so an
      // ACK writer can still resolve the dispatch. The permit closes the normal
      // cross-instance read-to-publish gap; purge also needs durable generation
      // quiescence and a DB-disconnect/wire-expiry guard before activation.
      const now = admission.now;
      await this.assertRetainedCommand(tx, record.dispatch.commandId, now);
      const outbox = await tx.mqttOutbox.findUnique({
        where: { id: record.id },
        select: {
          dispatchId: true, lockedBy: true, leaseExpiresAt: true, publishedAt: true,
          deadLetteredAt: true, deliveryAttemptedAt: true, payload: true
        }
      });
      if (
        !outbox || outbox.dispatchId !== record.dispatchId || outbox.lockedBy !== this.workerId ||
        outbox.publishedAt || outbox.deadLetteredAt || !outbox.deliveryAttemptedAt ||
        !outbox.leaseExpiresAt || outbox.leaseExpiresAt.getTime() <= now.getTime() + MQTT_PUBLISH_TIMEOUT_MS ||
        !isDeepStrictEqual(outbox.payload, payload)
      ) return;
      if (!await tx.commandPublishAttempt.findFirst({ where: { dispatchId: record.dispatchId,
        generation: admission.generation, workerId: this.workerId, expiresAt: new Date(payload.expiresAt) } })) {
        throw new SetAdmissionError("command publish attempt envelope unavailable");
      }
      if (await tx.gatewayRecommissionJob.count({
        where: {
          siteId: payload.siteId,
          gatewayId: record.dispatch.gatewayId,
          status: { in: ["mqtt_revocation_pending", "mqtt_revoked"] }
        }
      }) !== 0) return;

      // Recheck against DB time immediately before enqueue. A skewed app clock
      // cannot extend the ten-second wire generation into a later purge window.
      const publishAt = (await this.admitSet(tx)).now;
      await this.assertRetainedCommand(tx, record.dispatch.commandId, publishAt);
      if (Date.parse(payload.deliveryGeneratedAt) > publishAt.getTime() + GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS ||
        Date.parse(payload.expiresAt) > publishAt.getTime() + GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS + GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS) {
        throw new CommandDeliveryExpiredError("publisher clock is ahead of database clock");
      }
      if (outbox.leaseExpiresAt.getTime() <= publishAt.getTime() + MQTT_PUBLISH_TIMEOUT_MS) return;
      const messageExpiryInterval = currentMessageExpiry(
        payload, new Date(publishAt.getTime() + GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS)
      );
      await this.publishWire(record.topic, payload, messageExpiryInterval);
      return true;
    }, { maxWait: 2_000, timeout: PUBLISH_PERMIT_TRANSACTION_TIMEOUT_MS });
  }

  private async admitSet(tx: Prisma.TransactionClient) {
    try {
      if (process.env.COMMAND_RETENTION_PUBLISH_CUTOFF !== "1" || process.env.COMMAND_SET_EGRESS_ENABLED !== "1") {
        throw new Error("command Set epoch cutoff/egress configuration unavailable");
      }
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock_shared(${COMMAND_PUBLISH_PERMIT_KEY})`);
      const generation = await this.epochs.currentForSet(tx);
      if (!this.commandSetMqtt) throw new Error("command Set epoch egress unavailable");
      this.commandSetMqtt.assertPublisherIdentity(this.workerId, generation);
      const member = await tx.commandPublishMember.findFirst({ where: { generation, workerId: this.workerId,
        brokerIdentity: `command-set-${generation}`, quiesceAckAt: null } });
      if (!member) throw new Error("command Set epoch member unavailable");
      const now = await this.dbClockHealth.assertHealthy(tx, generation);
      return { generation, now };
    } catch (error) {
      throw new SetAdmissionError(error instanceof Error ? error.message : "command Set epoch admission unavailable");
    }
  }

  private assertPayloadEpoch(payload: unknown, generation: number) {
    const wire = gatewayDimmingCommandEpochPublishedV2Schema.safeParse(payload);
    if (!wire.success || wire.data.publishEpoch !== generation) {
      throw new SetAdmissionError("command Set epoch payload unavailable or stale");
    }
  }

  private async assertMeshGroupSnapshot(
    tx: Prisma.TransactionClient,
    record: {
      dispatch: {
        gatewayId: string;
        deliveryMode: string;
        destinationAddress: string | null;
        meshControlGroupId: string | null;
        meshControlGroupVersion: number | null;
      };
    },
    draft: GatewayDimmingCommandDraftV2
  ) {
    if (draft.deliveryMode !== "mesh_group") return;

    const dispatch = record.dispatch;
    if (
      dispatch.deliveryMode !== draft.deliveryMode ||
      dispatch.gatewayId !== draft.gatewayId ||
      dispatch.destinationAddress !== draft.destinationAddress ||
      dispatch.meshControlGroupId !== draft.meshControlGroupId ||
      dispatch.meshControlGroupVersion !== draft.meshControlGroupVersion
    ) {
      throw new StaleMeshGroupError("dispatch snapshot mismatch");
    }

    const group = await tx.meshControlGroup.findUnique({
      where: { id: draft.meshControlGroupId },
      select: { gatewayId: true, groupAddress: true, configurationVersion: true, status: true }
    });
    if (!group) throw new StaleMeshGroupError("group missing");
    if (group.gatewayId !== draft.gatewayId) throw new StaleMeshGroupError("gateway mismatch");
    if (group.groupAddress !== draft.destinationAddress) throw new StaleMeshGroupError("address mismatch");
    if (group.configurationVersion !== draft.meshControlGroupVersion) {
      throw new StaleMeshGroupError("configuration version mismatch");
    }
    if (group.status === "configuring") throw new MeshGroupConfiguringError();
    if (group.status !== "ready") throw new StaleMeshGroupError("group is not ready");
  }

  private async moveToDeadLetter(
    record: { id: string; dispatchId: string; dispatch: { commandId: string; kind?: CommandDispatchKind } },
    attempts: number,
    message: string,
    now: Date
  ) {
    await this.moveToTerminalFailure(record, attempts, message, now, "MQTT_DEAD_LETTER");
  }

  private async moveToTerminalFailure(
    record: { id: string; dispatchId: string; dispatch: { commandId: string; kind?: CommandDispatchKind } },
    attempts: number,
    message: string,
    now: Date,
    errorCode: "MQTT_DEAD_LETTER" | "MESH_GROUP_STALE" | "COMMAND_DELIVERY_EXPIRED"
  ) {
    await this.prisma.$transaction(async (tx) => {
      // Match ACK, verification and overlap writers: the global lock always comes
      // before outbox/dispatch/command rows, including terminal delivery failures.
      await this.automationSnapshot.lockMutation(tx);
      const released = await tx.mqttOutbox.updateMany({
        where: { id: record.id, dispatch: { kind: this.dispatchKind }, lockedBy: this.workerId, publishedAt: null, deadLetteredAt: null },
        data: {
          attempts,
          deadLetteredAt: now,
          lastError: message,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null
        }
      });
      if (released.count !== 1) return;
      const outbox = await tx.mqttOutbox.findUnique({ where: { id: record.id }, select: { deliveryAttemptedAt: true } });
      const uncertain = outbox?.deliveryAttemptedAt != null;
      const terminalStatus = uncertain ? "timed_out" : "failed";
      const closed = await tx.commandDispatch.updateMany({
        where: { id: record.dispatchId, status: { in: ["pending", "published", "accepted"] } },
        data: { status: terminalStatus, completedAt: now, errorCode, errorMessage: message }
      });
      // A conclusive ACK can arrive during MQTT's pending PUBACK. Closing the outbox
      // is still valid, but losing the dispatch transition forbids result/parent writes.
      if (closed.count !== 1) return;
      await tx.commandFixtureResult.updateMany({
        where: { dispatchId: record.dispatchId, status: "pending" },
        data: { status: terminalStatus, occurredAt: now, errorMessage: message }
      });
      // A failed observation closes only its dispatch; it cannot establish the original Set outcome.
      if (record.dispatch.kind === "status_check") return;
      const command = await tx.command.findUnique({ where: { id: record.dispatch.commandId }, select: { outcome: true } });
      const legacy = command?.outcome === null;
      await tx.command.updateMany({
        where: { id: record.dispatch.commandId, status: "pending", outcome: legacy ? null : "pending" },
        data: { status: "failed", errorMessage: message,
          ...(legacy ? {} : { outcome: uncertain ? "unknown" : "not_applied" }) }
      });
    });
  }
}

function parseStoredCommand(payload: Prisma.JsonValue, kind: CommandDispatchKind = "dimming") {
  if (kind === "status_check") {
    return { kind, ...parseStoredStatusCheckCommand(payload) } as const;
  }
  return { kind, ...parseStoredDimmingCommand(payload) } as const;
}

function parseStoredStatusCheckCommand(payload: Prisma.JsonValue): {
  draft: GatewayStatusCheckCommandDraftV2;
  payload?: GatewayStatusCheckCommandPublishedV2;
} {
  const published = gatewayStatusCheckCommandPublishedV2Schema.safeParse(payload);
  if (published.success) {
    const { expiresAt, deliveryGeneration, deliveryGeneratedAt, deliveryWindowMs, ...draft } = published.data;
    return { draft, payload: published.data };
  }
  return { draft: gatewayStatusCheckCommandDraftV2Schema.parse(payload) };
}

function createPublishedStatusCheckCommand(
  draft: GatewayStatusCheckCommandDraftV2,
  generatedAt: Date,
  deliveryGeneration: string
) {
  const { messageExpiryInterval: _messageExpiryInterval, ...delivery } =
    createGatewayCommandExpiry(generatedAt, deliveryGeneration);
  return gatewayStatusCheckCommandPublishedV2Schema.parse({ ...draft, ...delivery });
}

function parseStoredDimmingCommand(payload: Prisma.JsonValue): {
  draft: GatewayDimmingCommandDraftV2;
  payload?: GatewayDimmingCommandPublishedV2 | GatewayDimmingCommandEpochPublishedV2;
} {
  const epochPublished = gatewayDimmingCommandEpochPublishedV2Schema.safeParse(payload);
  if (epochPublished.success) return { draft: toDimmingDraft(epochPublished.data), payload: epochPublished.data };
  const published = gatewayDimmingCommandPublishedV2Schema.safeParse(payload);
  if (published.success) return { draft: toDimmingDraft(published.data), payload: published.data };

  const draft = gatewayDimmingCommandDraftV2CompatibilitySchema.safeParse(payload);
  if (draft.success) return { draft: toDimmingDraft(draft.data) };

  const compatible = gatewayDimmingCommandV2CompatibilitySchema.safeParse(payload);
  if (!compatible.success) throw draft.error;
  if ("deliveryGeneration" in compatible.data) {
    // A lost PUBACK can leave an already-published legacy wire in the outbox.
    // Scrub only compatibility fields: recreating delivery metadata renews freshness.
    const normalized = { ...compatible.data } as Record<string, unknown>;
    delete normalized.overrideUntil;
    delete normalized.overrideRemainingMs;
    delete normalized.requestedBy;
    return {
      draft: toDimmingDraft(compatible.data),
      payload: gatewayDimmingCommandPublishedV2Schema.parse(normalized)
    };
  }
  return { draft: toDimmingDraft(compatible.data) };
}

function toDimmingDraft(payload: Record<string, unknown>): GatewayDimmingCommandDraftV2 {
  const draft = { ...payload };
  delete draft.expiresAt;
  delete draft.deliveryGeneration;
  delete draft.deliveryGeneratedAt;
  delete draft.deliveryWindowMs;
  delete draft.publishEpoch;
  delete draft.overrideUntil;
  delete draft.overrideRemainingMs;
  // Historical rows can contain requester PII. Compatibility parsing accepts
  // the old wire, but every newly persisted/published generation omits it.
  delete draft.requestedBy;
  return gatewayDimmingCommandDraftV2Schema.parse(draft);
}

function createPublishedDimmingCommand(
  draft: GatewayDimmingCommandDraftV2,
  generatedAt: Date,
  deliveryGeneration: string,
  publishEpoch?: number
) {
  const { messageExpiryInterval: _messageExpiryInterval, ...delivery } =
    createGatewayCommandExpiry(generatedAt, deliveryGeneration);
  return publishEpoch === undefined ? gatewayDimmingCommandPublishedV2Schema.parse({ ...draft, ...delivery })
    : gatewayDimmingCommandEpochPublishedV2Schema.parse({ ...draft, ...delivery, publishEpoch });
}

function currentMessageExpiry(payload: { expiresAt: string }, now: Date) {
  try {
    return remainingGatewayCommandMessageExpiry(payload, now);
  } catch (error) {
    throw new CommandDeliveryExpiredError(error);
  }
}

class SetAdmissionError extends Error {}

class MeshGroupConfiguringError extends Error {
  constructor() {
    super("mesh control group configuration is not ready");
  }
}

class StaleMeshGroupError extends Error {
  constructor(reason: string) {
    super(`Mesh 그룹 명령 스냅샷이 만료되었습니다: ${reason}`);
  }
}

class CommandDeliveryExpiredError extends Error {
  constructor(cause: unknown) {
    super("gateway command delivery generation expired before MQTT publish", { cause });
    this.name = "CommandDeliveryExpiredError";
  }
}
