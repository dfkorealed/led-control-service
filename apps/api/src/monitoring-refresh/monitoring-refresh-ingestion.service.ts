import { Injectable } from "@nestjs/common";
import { Prisma, type MonitoringRefresh, type MonitoringRefreshBatch, type MonitoringRefreshFixture } from "@prisma/client";
import {
  fixtureUnreachableV1Schema, fixturePresenceCheckCompletedV1Schema, mqttTopicsV2,
  type ApplicationStateIngestedAckV2, type FixtureUnreachableV1, type FixturePresenceCheckCompletedV1
} from "@led-control/shared";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { isMonitoringGatewayOnline, type MonitoringPolicy } from "../monitoring-incidents/monitoring-conditions";
import { gatewayEventIsTooFarInFuture, gatewayEventMaxFutureSkewMs } from "../mqtt/gateway-event-time";
import { PrismaService } from "../prisma/prisma.service";
import { compareAndAdvanceGatewayEvent } from "../retention/gateway-event-watermark";
import { finalizeResolvedMonitoringRefresh } from "./monitoring-refresh-state";

type Correlation = { siteId: string; gatewayId: string; refreshId: string; batchId: string };
type FixtureCorrelation = Correlation & { fixtureId: string };
type Context = { refresh: MonitoringRefresh; batch: MonitoringRefreshBatch; child: MonitoringRefreshFixture };
type Observation = FixtureUnreachableV1 | FixturePresenceCheckCompletedV1;
type Status = ApplicationStateIngestedAckV2["status"];

/** Caller already owns Site → Gateway → Fixture; never acquire these locks in reverse. */
export async function lockRefreshObservation(tx: Prisma.TransactionClient, input: FixtureCorrelation, floorId: string): Promise<Context> {
  const { refresh, batch } = await lockBatch(tx, input);
  const [child] = await tx.$queryRaw<MonitoringRefreshFixture[]>(Prisma.sql`
    SELECT * FROM "MonitoringRefreshFixture"
    WHERE "refreshId" = ${input.refreshId} AND "fixtureId" = ${input.fixtureId} FOR UPDATE
  `);
  if (refresh.floorId !== floorId || !targets(batch).includes(input.fixtureId) || !child ||
      child.siteId !== input.siteId || child.batchId !== input.batchId || child.refreshId !== input.refreshId ||
      child.fixtureId !== input.fixtureId) throw new Error("monitoring refresh scope rejected");
  return { refresh, batch, child };
}

export async function resolveRefreshObservation(tx: Prisma.TransactionClient, context: Context | null, receivedAt: Date) {
  if (!context || !active(context) || receivedAt >= context.refresh.deadlineAt) return;
  await resolveChild(tx, context, "online", receivedAt);
}

@Injectable()
export class MonitoringRefreshIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  async ingestUnreachable(topic: string, raw: unknown, receivedAt = new Date()) {
    const event = fixtureUnreachableV1Schema.parse(raw);
    if (topic !== mqttTopicsV2.fixtureUnreachable(event.siteId, event.gatewayId)) throw new Error("monitoring refresh topic scope rejected");
    const now = new Date(receivedAt);
    return this.prisma.$transaction(async (tx) => {
      const { site, gateway } = await lockParents(tx, event);
      const [fixture] = await tx.$queryRaw<Array<{ id: string; floorId: string; lastSeenAt: Date | null; lastUnreachableAt: Date | null }>>(Prisma.sql`
        SELECT f."id", f."floorId", f."lastSeenAt", f."lastUnreachableAt" FROM "Fixture" f
        INNER JOIN "MeshNode" mn ON mn."id" = f."meshNodeId"
        WHERE f."id" = ${event.fixtureId} AND f."siteId" = ${event.siteId} AND mn."gatewayId" = ${event.gatewayId}
        FOR UPDATE OF f
      `);
      if (!fixture) throw new Error("monitoring refresh scope rejected");
      const context = await lockRefreshObservation(tx, event, fixture.floorId);
      const ordering = await recordEvent(tx, event, "fixture_unreachable", event.fixtureId, now);
      if (ordering !== "ingested") return stateResult(event, ordering);
      if (!active(context) || context.child.status !== "pending") return stateResult(event, "ingested");
      if (now >= context.refresh.deadlineAt || !isMonitoringGatewayOnline(gateway.lastHeartbeatAt, site, now)) {
        await resolveChild(tx, context, "unverified", now, now >= context.refresh.deadlineAt ? "refresh_deadline_exceeded" : "gateway_offline");
      } else if (fixture.lastSeenAt && fixture.lastSeenAt >= context.refresh.createdAt) {
        await resolveChild(tx, context, "online", now);
      } else if (new Date(event.occurredAt) < context.refresh.createdAt ||
          (fixture.lastUnreachableAt && fixture.lastUnreachableAt >= context.refresh.createdAt)) {
        // A previous/newer refresh may already have established reachability. An
        // older command's delayed receipt must not extend its offline timestamp.
        await resolveChild(tx, context, "unverified", now, "stale_observation");
      } else {
        await tx.fixture.update({ where: { id: fixture.id },
          data: { lastUnreachableAt: now, status: "offline", statusReason: "fixture_stale" } });
        await resolveChild(tx, context, "offline", now, event.reason);
      }
      return stateResult(event, "ingested");
    }, { maxWait: 2000, timeout: 10_000 });
  }

  async completeBatch(topic: string, raw: unknown, receivedAt = new Date()) {
    const event = fixturePresenceCheckCompletedV1Schema.parse(raw);
    if (topic !== mqttTopicsV2.fixturePresenceCheckCompleted(event.siteId, event.gatewayId)) throw new Error("monitoring refresh topic scope rejected");
    const now = new Date(receivedAt);
    return this.prisma.$transaction(async (tx) => {
      await lockParents(tx, event);
      const { refresh, batch } = await lockBatch(tx, event);
      if (!sameTargets(targets(batch), event.targetFixtureIds)) throw new Error("monitoring refresh snapshot scope rejected");
      // Completion only reads child truth after the parent lock. It never writes
      // Fixture, so expiry (which starts at the parent) cannot form an inverse wait.
      const children = await tx.monitoringRefreshFixture.findMany({ where: { refreshId: event.refreshId, batchId: event.batchId } });
      if (!sameTargets(children.map((child) => child.fixtureId), event.targetFixtureIds) ||
          children.some((child) => child.siteId !== event.siteId)) throw new Error("monitoring refresh child scope rejected");
      // A valid early completion must release the MQTT parser so later fixture results can arrive.
      // No application ACK: the Gateway's durable completion publisher retries independently.
      if (children.some((child) => child.status === "pending")) {
        await existingEventStatus(tx, event, "fixture_presence_check_completed", event.batchId);
        return { ack: null };
      }
      const ordering = await recordEvent(tx, event, "fixture_presence_check_completed", event.batchId, now);
      // A completion ACK removes the Gateway journal. Reject stale/future results
      // without that ACK; they are not evidence that this exact batch committed.
      if (ordering !== "ingested" && ordering !== "duplicate") throw new Error("monitoring refresh completion ordering rejected");
      if (ordering === "ingested") {
        if (refresh.status === "pending" && ["pending", "published"].includes(batch.status)) {
          // A Gateway can finish before the publisher persists its broker PUBACK.
          // The validated completion proves delivery by this server receipt time;
          // fill only a missing publication time under the shared Refresh lock.
          await tx.monitoringRefreshBatch.update({ where: { id: batch.id }, data: {
            status: "completed", publishedAt: batch.publishedAt ?? now, completedAt: now
          } });
          const remaining = await tx.monitoringRefreshBatch.count({ where: { refreshId: refresh.id, status: { in: ["pending", "published"] } } });
          if (remaining === 0) await finalizeResolvedMonitoringRefresh(tx, refresh.id, now, "failed");
        }
        await tx.mqttOutbox.deleteMany({ where: { monitoringRefreshBatchId: batch.id } });
      }
      // Expiry may already have made every child durably unverified. An exact,
      // validated completion (including its replay) may then retire the Gateway
      // journal without reopening expired state. Pending/invalid results above
      // throw before this ACK so delivery remains retryable/fail-closed.
      return { ack: { siteId: event.siteId, gatewayId: event.gatewayId, refreshId: event.refreshId, batchId: event.batchId } };
    }, { maxWait: 2000, timeout: 10_000 });
  }
}

async function lockParents(tx: Prisma.TransactionClient, input: Correlation) {
  const [site] = await tx.$queryRaw<Array<MonitoringPolicy>>(Prisma.sql`
    SELECT "id", "gatewayOfflineAfterSeconds", "fixtureStaleAfterSeconds" FROM "Site" WHERE "id" = ${input.siteId} FOR KEY SHARE
  `);
  const [gateway] = await tx.$queryRaw<Array<{ lastHeartbeatAt: Date | null }>>(Prisma.sql`
    SELECT "id", "lastHeartbeatAt" FROM "Gateway" WHERE "id" = ${input.gatewayId} AND "siteId" = ${input.siteId} FOR SHARE
  `);
  if (!site || !gateway) throw new Error("monitoring refresh scope rejected");
  return { site, gateway };
}

async function lockBatch(tx: Prisma.TransactionClient, input: Correlation) {
  const [refresh] = await tx.$queryRaw<MonitoringRefresh[]>(Prisma.sql`
    SELECT * FROM "MonitoringRefresh" WHERE "id" = ${input.refreshId} FOR UPDATE
  `);
  const [batch] = await tx.$queryRaw<MonitoringRefreshBatch[]>(Prisma.sql`
    SELECT * FROM "MonitoringRefreshBatch" WHERE "id" = ${input.batchId} FOR UPDATE
  `);
  if (!refresh || refresh.siteId !== input.siteId || !batch || batch.siteId !== input.siteId ||
      batch.refreshId !== input.refreshId || batch.gatewayId !== input.gatewayId) throw new Error("monitoring refresh scope rejected");
  return { refresh, batch };
}

function targets(batch: MonitoringRefreshBatch): string[] {
  const value = batch.targetFixtureIds;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 || value.some((id) => typeof id !== "string") ||
      new Set(value).size !== value.length) throw new Error("monitoring refresh snapshot scope rejected");
  return value as string[];
}

function sameTargets(a: string[], b: string[]) { return a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]); }
function active(context: Context) { return context.refresh.status === "pending" && ["pending", "published"].includes(context.batch.status); }
function resolveChild(tx: Prisma.TransactionClient, context: Context, status: "online" | "offline" | "unverified", observedAt: Date, errorCode: string | null = null) {
  return tx.monitoringRefreshFixture.update({ where: { refreshId_fixtureId: { refreshId: context.refresh.id, fixtureId: context.child.fixtureId } },
    data: { status, errorCode, observedAt } });
}
function stateResult(event: FixtureUnreachableV1, status: Status) { return { eventId: event.eventId, sequence: event.sequence, fixtureId: event.fixtureId, status }; }

async function existingEventStatus(tx: Prisma.TransactionClient, event: Observation, eventType: string, scopeKey: string): Promise<Status | null> {
  const payloadHash = canonicalPayloadHash(event), occurredAt = new Date(event.occurredAt);
  const existing = await tx.processedGatewayEvent.findUnique({ where: { eventId: event.eventId } });
  if (existing) {
    if (existing.gatewayId !== event.gatewayId || existing.eventType !== eventType || existing.scopeKey !== scopeKey ||
        existing.sequence !== BigInt(event.sequence) || existing.occurredAt.getTime() !== occurredAt.getTime() ||
        existing.payloadHash !== payloadHash) throw new Error("monitoring refresh event identity conflict");
    return existing.ingestionStatus === "rejected_future_timestamp" ? "rejected_future_timestamp" : "duplicate";
  }
  return null;
}

async function recordEvent(tx: Prisma.TransactionClient, event: Observation, eventType: string, scopeKey: string, receivedAt: Date): Promise<Status> {
  const existing = await existingEventStatus(tx, event, eventType, scopeKey);
  if (existing) return existing;
  const payloadHash = canonicalPayloadHash(event), occurredAt = new Date(event.occurredAt);
  let status: Status = "ingested";
  if (gatewayEventIsTooFarInFuture(occurredAt, receivedAt, gatewayEventMaxFutureSkewMs())) status = "rejected_future_timestamp";
  else {
    // Hold the same ordering lock as the shared helper before reading time, so
    // reverse-time packets cannot advance its watermark or bypass hash checks.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gateway-event:${event.gatewayId}:${eventType}`}, 0))`);
    const key = { gatewayId: event.gatewayId, eventType, scopeKey };
    const current = await tx.gatewayEventWatermark.findUnique({ where: { gatewayId_eventType_scopeKey: key } });
    if (current?.lastEventId === event.eventId && current.lastSequence !== BigInt(event.sequence)) {
      throw new Error("monitoring refresh event identity conflict");
    }
    if (current && occurredAt < current.lastOccurredAt && BigInt(event.sequence) > current.lastSequence) {
      const collision = await tx.gatewayEventWatermark.findFirst({ where: { lastEventId: event.eventId } });
      if (collision || current.lastEventId === event.eventId) throw new Error("monitoring refresh event identity conflict");
      status = "stale_sequence";
    } else {
      const ordering = await compareAndAdvanceGatewayEvent(tx, { ...key, sequence: BigInt(event.sequence), eventId: event.eventId, payloadHash, occurredAt });
      if (ordering === "conflict") throw new Error("monitoring refresh event identity conflict");
      if (ordering === "duplicate") return "duplicate";
      if (ordering === "stale") status = "stale_sequence";
    }
  }
  await tx.processedGatewayEvent.create({ data: { eventId: event.eventId, gatewayId: event.gatewayId,
    fixtureId: "fixtureId" in event ? event.fixtureId : null, sequence: BigInt(event.sequence), eventType, scopeKey, payloadHash,
    occurredAt, receivedAt, ingestionStatus: status === "rejected_future_timestamp" ? status : "accepted" } });
  return status;
}
