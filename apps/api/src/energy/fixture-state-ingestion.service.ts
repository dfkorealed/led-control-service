import { Prisma } from "@prisma/client";
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  fixtureStateV2Schema,
  mapHealthFaults,
  statusFromHealth,
  type ApplicationStateIngestedAckV2,
  type FixtureStateV2
} from "@led-control/shared";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { gatewayEventIsTooFarInFuture, gatewayEventMaxFutureSkewMs } from "../mqtt/gateway-event-time";
import { reconcileLegacyGatewayEventReplay } from "../mqtt/legacy-gateway-event-replay";
import { PrismaService } from "../prisma/prisma.service";
import { compareAndAdvanceGatewayEvent } from "../retention/gateway-event-watermark";
import { recordMonitoringActivities, type MonitoringActivityInput } from "../monitoring-activity/monitoring-activity.projection";
import { assertRefreshWatermarkIdentity, lockRefreshObservation, resolveRefreshObservation } from "../monitoring-refresh/monitoring-refresh-ingestion.service";
import {
  aggregateFixtureStateTransition,
  closeFixtureEnergyCheckpoint,
  createInitialFixtureEnergyCheckpoint,
  type FixtureEnergyCheckpoint,
  type FixtureEnergySnapshot
} from "./energy-aggregation";

type IngestionStatus = ApplicationStateIngestedAckV2["status"];

interface LockedFixtureRow {
  id: string;
  name: string;
  floorId: string;
  status: "online" | "offline" | "fault";
  healthFaultCodes: Prisma.JsonValue | null;
  lastUnreachableAt: Date | null;
  lastSeenAt: Date | null;
  energyFixtureId: string;
  siteId: string;
  gatewayId: string;
  ratedWatt: Prisma.Decimal;
  brightness: number;
  powerOn: boolean | null;
  energyTrackingStartedAt: Date;
  firstStateOccurredAt: Date | null;
  lastStateEventId: string | null;
  lastStateSequence: bigint | null;
  lastStateOccurredAt: Date | null;
  timeZone: string;
  tariffKwhRate: Prisma.Decimal;
}

interface LockedSiteFixtureRow {
  id: string;
  energyFixtureId: string | null;
  ratedWatt: Prisma.Decimal;
  brightness: number;
  powerOn: boolean | null;
  energyTrackingStartedAt: Date;
  firstStateOccurredAt: Date | null;
  lastStateEventId: string | null;
  lastStateSequence: bigint | null;
  lastStateOccurredAt: Date | null;
  cursorAggregatedThrough: Date | null;
  cursorObservedStateOccurredAt: Date | null;
  cursorBrightness: number | null;
  cursorPowerOn: boolean | null;
  cursorRatedWatt: Prisma.Decimal | null;
  cursorDurationRemainders: Prisma.JsonValue | null;
}

interface SiteCheckpointClosure {
  fixtureId: string;
  energyFixtureId: string;
  closed: ReturnType<typeof closeFixtureEnergyCheckpoint>;
}

const ENERGY_WRITE_BATCH_SIZE = 500;

export interface FixtureStateIngestionResult {
  eventId: string;
  sequence: number;
  fixtureId: string;
  status: IngestionStatus;
}

@Injectable()
export class FixtureStateIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(gatewayId: string, input: FixtureStateV2, receivedAt = new Date()): Promise<FixtureStateIngestionResult> {
    const state = fixtureStateV2Schema.parse(input);
    const frozenReceivedAt = new Date(receivedAt.getTime());
    const maxFutureSkewMs = gatewayEventMaxFutureSkewMs();
    const payloadHash = canonicalPayloadHash(state);
    try {
      return await this.prisma.$transaction(
        async (tx) => this.ingestInTransaction(tx, gatewayId, state, frozenReceivedAt, maxFutureSkewMs, payloadHash),
        { timeout: 10_000 }
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.prisma.processedGatewayEvent.findUnique({ where: { eventId: state.eventId } });
      if (!duplicate || !sameProcessedEvent(duplicate, gatewayId, state, payloadHash)) throw new Error("fixture state sequence conflict");
      return resultFrom(state, duplicate.ingestionStatus === "rejected_future_timestamp" ? "rejected_future_timestamp" : "duplicate");
    }
  }

  private async ingestInTransaction(
    tx: Prisma.TransactionClient,
    gatewayId: string,
    state: FixtureStateV2,
    receivedAt: Date,
    maxFutureSkewMs: number,
    payloadHash: string
  ) {
    if (gatewayId !== state.gatewayId) throw new Error("fixture state scope rejected");
    const existing = await tx.processedGatewayEvent.findUnique({ where: { eventId: state.eventId } });
    // A null legacy hash must be reconciled only after current ownership and its row lock.
    if (existing && existing.payloadHash !== null) {
      if (!sameProcessedEvent(existing, gatewayId, state, payloadHash)) throw new Error("fixture state event identity conflict");
      return resultFrom(state, existing.ingestionStatus === "rejected_future_timestamp" ? "rejected_future_timestamp" : "duplicate");
    }

    const [site] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Site"
      WHERE "id" = ${state.siteId}
      FOR KEY SHARE
    `);
    if (!site) throw new Error("fixture state scope rejected");
    if (state.refreshId) {
      const [gateway] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "Gateway" WHERE "id" = ${gatewayId} AND "siteId" = ${state.siteId} FOR KEY SHARE
      `);
      if (!gateway) throw new Error("fixture state scope rejected");
    }
    const [fixture] = await tx.$queryRaw<LockedFixtureRow[]>(Prisma.sql`
      SELECT
        f."id",
        f."name", f."floorId", f."status", f."healthFaultCodes", f."lastUnreachableAt", f."lastSeenAt",
        energy_fixture."id" AS "energyFixtureId",
        fl."siteId" AS "siteId",
        mn."gatewayId" AS "gatewayId",
        f."ratedWatt",
        f."brightness",
        f."powerOn",
        f."energyTrackingStartedAt",
        f."firstStateOccurredAt",
        f."lastStateEventId",
        f."lastStateSequence",
        f."lastStateOccurredAt",
        s."timeZone",
        s."tariffKwhRate"
      FROM "Fixture" f
      INNER JOIN "Floor" fl ON fl."id" = f."floorId"
      INNER JOIN "Site" s ON s."id" = fl."siteId"
      INNER JOIN "MeshNode" mn ON mn."id" = f."meshNodeId"
      INNER JOIN "EnergyFixtureIdentity" energy_fixture ON energy_fixture."fixtureId" = f."id"
      WHERE f."id" = ${state.fixtureId}
        AND fl."siteId" = ${state.siteId}
        AND mn."gatewayId" = ${gatewayId}
        AND mn."gatewayId" = ${state.gatewayId}
      FOR UPDATE OF f
    `);
    const refreshContext = state.refreshId && state.batchId
      ? await lockRefreshObservation(tx, { ...state, refreshId: state.refreshId, batchId: state.batchId }, fixture?.floorId)
      : null;
    // Retired results must not revive output, freshness, or energy after aggregate retention.
    if (state.refreshId && !refreshContext) {
      if (existing && !sameProcessedEventIdentity(existing, gatewayId, state)) throw new Error("fixture state event identity conflict");
      await assertRefreshWatermarkIdentity(tx, state, "fixture_state", state.fixtureId);
      return resultFrom(state, "duplicate");
    }
    if (!fixture) throw new Error("fixture state scope rejected");

    // A concurrent exact replay can read an empty ledger before waiting on this fixture lock.
    // Re-read after the lock is acquired so the first transaction's committed terminal result wins.
    const committedDuringFixtureLock = await tx.processedGatewayEvent.findUnique({ where: { eventId: state.eventId } });
    if (committedDuringFixtureLock) {
      const replay = await reconcileLegacyGatewayEventReplay(
        tx, committedDuringFixtureLock, payloadHash, (event) => sameProcessedEventIdentity(event, gatewayId, state)
      );
      if (!replay) {
        throw new Error("fixture state event identity conflict");
      }
      return resultFrom(
        state,
        replay.ingestionStatus === "rejected_future_timestamp"
          ? "rejected_future_timestamp"
          : "duplicate"
      );
    }

    const occurredAt = new Date(state.occurredAt);
    if (gatewayEventIsTooFarInFuture(occurredAt, receivedAt, maxFutureSkewMs)) {
      await tx.processedGatewayEvent.create({
        data: {
          eventId: state.eventId,
          gatewayId,
          fixtureId: state.fixtureId,
          sequence: BigInt(state.sequence),
          eventType: "fixture_state",
          payloadHash,
          scopeKey: state.fixtureId,
          occurredAt,
          receivedAt,
          ingestionStatus: "rejected_future_timestamp"
        }
      });
      return resultFrom(state, "rejected_future_timestamp");
    }

    const ordering = await compareAndAdvanceGatewayEvent(tx, {
      gatewayId,
      eventType: "fixture_state",
      scopeKey: state.fixtureId,
      sequence: BigInt(state.sequence),
      eventId: state.eventId,
      payloadHash,
      occurredAt
    });
    if (ordering === "conflict") throw new Error("fixture state event identity conflict");
    if (ordering === "duplicate") return resultFrom(state, "duplicate");

    await tx.processedGatewayEvent.create({
      data: {
        eventId: state.eventId,
        gatewayId,
        fixtureId: state.fixtureId,
        sequence: BigInt(state.sequence),
        eventType: "fixture_state",
        payloadHash,
        scopeKey: state.fixtureId,
        occurredAt,
        receivedAt,
        ingestionStatus: "accepted"
      }
    });
    if (ordering === "stale") return resultFrom(state, "stale_sequence");

    const snapshot = toSnapshot(fixture);
    const storedCursor = await tx.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: fixture.id } });
    const checkpoint = storedCursor ? toCheckpoint(storedCursor) : createInitialFixtureEnergyCheckpoint(snapshot);
    const transition = aggregateFixtureStateTransition({
      snapshot,
      checkpoint,
      event: {
        eventId: state.eventId,
        sequence: BigInt(state.sequence),
        occurredAt,
        brightness: state.brightness,
        powerOn: state.powerOn
      },
      timeZone: fixture.timeZone,
      tariffKwhRate: new Prisma.Decimal(fixture.tariffKwhRate)
    });

    if (transition.status !== "accepted") return resultFrom(state, transition.status);

    await persistDailyDeltas(tx, fixture.id, fixture.energyFixtureId, transition.dailyDeltas);
    await persistHourlyDeltas(tx, fixture.energyFixtureId, transition.hourlyDeltas);
    await persistCheckpoint(tx, fixture.id, transition.nextCheckpoint);

    const health = state.health
      ? { faultCodes: mapHealthFaults(state.health.faultCodes), observedAt: new Date(state.health.observedAt) }
      : null;
    const nextStatus = fixture.lastUnreachableAt && receivedAt <= fixture.lastUnreachableAt
      ? "offline" as const : health ? statusFromHealth(health.faultCodes) : state.status;
    await tx.fixture.update({
      where: { id: fixture.id },
      data: {
        brightness: state.brightness,
        powerOn: state.powerOn,
        status: health ? statusFromHealth(health.faultCodes) : state.status,
        statusReason: state.statusReason ?? "reported",
        // Retain the accepted report independently of fixed operational sweeps.
        // Monitoring applies Site policy and the Health snapshot when reading.
        reportedStatus: state.status,
        reportedStatusReason: state.statusReason ?? "reported",
        ...(health ? { healthFaultCodes: health.faultCodes, healthLastSeenAt: health.observedAt } : {}),
        rssi: state.rssi,
        hopCount: state.hopCount,
        lastSeenAt: fixture.lastSeenAt && fixture.lastSeenAt > receivedAt ? fixture.lastSeenAt : receivedAt,
        ...(!fixture.lastUnreachableAt || receivedAt > fixture.lastUnreachableAt
          ? { lastUnreachableAt: null }
          : { status: "offline", statusReason: "fixture_stale" }),
        firstStateOccurredAt: transition.nextSnapshot.firstStateOccurredAt,
        lastStateEventId: state.eventId,
        lastStateSequence: BigInt(state.sequence),
        lastStateOccurredAt: occurredAt
      }
    });
    const activityBase = { siteId: fixture.siteId, floorId: fixture.floorId, fixtureId: fixture.id,
      displayName: fixture.name, sourceType: "fixture_state" as const, observedAt: occurredAt };
    const activities: MonitoringActivityInput[] = [];
    if (fixture.status !== nextStatus) activities.push({ ...activityBase, sourceKey: `${state.eventId}:status`,
      kind: "fixture_status_changed", status: nextStatus });
    if (fixture.brightness !== state.brightness) activities.push({ ...activityBase,
      sourceKey: `${state.eventId}:brightness`, kind: "fixture_brightness_changed", brightnessPercent: state.brightness });
    if (health && JSON.stringify(fixture.healthFaultCodes) !== JSON.stringify(health.faultCodes)) {
      activities.push({ ...activityBase, sourceKey: `${state.eventId}:health`, kind: "fixture_health_changed", status: nextStatus });
    }
    if (activities.length) await recordMonitoringActivities(tx, activities);
    if (!fixture.lastUnreachableAt || receivedAt > fixture.lastUnreachableAt) {
      await resolveRefreshObservation(tx, refreshContext, receivedAt);
    }
    return resultFrom(state, "ingested");
  }
}

export async function closeFixtureEnergyForRatedWattChange(
  tx: Prisma.TransactionClient,
  fixtureId: string,
  nextRatedWatt: Prisma.Decimal,
  closedAt: Date
) {
  const [fixture] = await tx.$queryRaw<LockedFixtureRow[]>(Prisma.sql`
    SELECT
      f."id",
      energy_fixture."id" AS "energyFixtureId",
      fl."siteId" AS "siteId",
      mn."gatewayId" AS "gatewayId",
      f."ratedWatt",
      f."brightness",
      f."powerOn",
      f."energyTrackingStartedAt",
      f."firstStateOccurredAt",
      f."lastStateEventId",
      f."lastStateSequence",
      f."lastStateOccurredAt",
      s."timeZone",
      s."tariffKwhRate"
    FROM "Fixture" f
    INNER JOIN "Floor" fl ON fl."id" = f."floorId"
    INNER JOIN "Site" s ON s."id" = fl."siteId"
    LEFT JOIN "MeshNode" mn ON mn."id" = f."meshNodeId"
    INNER JOIN "EnergyFixtureIdentity" energy_fixture ON energy_fixture."fixtureId" = f."id"
    WHERE f."id" = ${fixtureId}
    FOR UPDATE OF f
  `);
  if (!fixture) throw new Error("fixture energy checkpoint scope rejected");
  if (new Prisma.Decimal(fixture.ratedWatt).eq(nextRatedWatt)) return false;

  const snapshot = toSnapshot(fixture);
  const storedCursor = await tx.fixtureEnergyStateCursor.findUnique({ where: { fixtureId } });
  const checkpoint = storedCursor ? toCheckpoint(storedCursor) : createInitialFixtureEnergyCheckpoint(snapshot);
  const closed = closeFixtureEnergyCheckpoint({
    snapshot,
    checkpoint,
    closedAt,
    nextRatedWatt,
    timeZone: fixture.timeZone,
    tariffKwhRate: new Prisma.Decimal(fixture.tariffKwhRate)
  });
  await persistDailyDeltas(tx, fixtureId, fixture.energyFixtureId, closed.dailyDeltas);
  await persistHourlyDeltas(tx, fixture.energyFixtureId, closed.hourlyDeltas);
  await persistCheckpoint(tx, fixtureId, closed.nextCheckpoint);
  return true;
}

export async function closeSiteEnergyForSettingsChange(
  tx: Prisma.TransactionClient,
  input: { siteId: string; timeZone: string; tariffKwhRate: Prisma.Decimal }
) {
  // Site settings lock the parent first; every bulk fixture path then takes child locks in ID order.
  const fixtures = await tx.$queryRaw<LockedSiteFixtureRow[]>(Prisma.sql`
    SELECT
      f."id",
      energy_fixture."id" AS "energyFixtureId",
      f."ratedWatt",
      f."brightness",
      f."powerOn",
      f."energyTrackingStartedAt",
      f."firstStateOccurredAt",
      f."lastStateEventId",
      f."lastStateSequence",
      f."lastStateOccurredAt",
      cursor."aggregatedThrough" AS "cursorAggregatedThrough",
      cursor."observedStateOccurredAt" AS "cursorObservedStateOccurredAt",
      cursor."brightness" AS "cursorBrightness",
      cursor."powerOn" AS "cursorPowerOn",
      cursor."ratedWatt" AS "cursorRatedWatt",
      cursor."durationRemainders" AS "cursorDurationRemainders"
    FROM "Fixture" f
    LEFT JOIN "EnergyFixtureIdentity" energy_fixture ON energy_fixture."fixtureId" = f."id"
    LEFT JOIN "FixtureEnergyStateCursor" cursor ON cursor."fixtureId" = f."id"
    WHERE f."siteId" = ${input.siteId}
    ORDER BY f."id"
    FOR UPDATE OF f
  `);
  const closedAt = new Date();
  const closures = fixtures.map((fixture): SiteCheckpointClosure => {
    if (!fixture.energyFixtureId) throw new Error("fixture energy identity is missing");
    const snapshot = toSnapshot(fixture);
    const checkpoint = fixture.cursorAggregatedThrough === null
      ? createInitialFixtureEnergyCheckpoint(snapshot)
      : toCheckpoint({
          aggregatedThrough: fixture.cursorAggregatedThrough,
          observedStateOccurredAt: fixture.cursorObservedStateOccurredAt,
          brightness: fixture.cursorBrightness!,
          powerOn: fixture.cursorPowerOn,
          ratedWatt: fixture.cursorRatedWatt!,
          durationRemainders: fixture.cursorDurationRemainders
        });
    return {
      fixtureId: fixture.id,
      energyFixtureId: fixture.energyFixtureId,
      closed: closeFixtureEnergyCheckpoint({
        snapshot,
        checkpoint,
        closedAt,
        nextRatedWatt: new Prisma.Decimal(fixture.ratedWatt),
        timeZone: input.timeZone,
        tariffKwhRate: new Prisma.Decimal(input.tariffKwhRate)
      })
    };
  });

  await persistSiteDailyDeltas(tx, closures);
  await persistSiteHourlyDeltas(tx, closures);
  await persistSiteCheckpoints(tx, closures);
  return closedAt;
}

@Injectable()
export class FixtureEnergyCheckpointService {
  closeRatedWattInterval(
    tx: Prisma.TransactionClient,
    fixtureId: string,
    nextRatedWatt: Prisma.Decimal,
    closedAt: Date
  ) {
    return closeFixtureEnergyForRatedWattChange(tx, fixtureId, nextRatedWatt, closedAt);
  }

  closeSiteSettingsIntervals(
    tx: Prisma.TransactionClient,
    input: { siteId: string; timeZone: string; tariffKwhRate: Prisma.Decimal }
  ) {
    return closeSiteEnergyForSettingsChange(tx, input);
  }
}

async function persistSiteDailyDeltas(tx: Prisma.TransactionClient, closures: SiteCheckpointClosure[]) {
  const rows = closures.flatMap(({ fixtureId, energyFixtureId, closed }) =>
    closed.dailyDeltas.map((delta) => ({ fixtureId, energyFixtureId, delta }))
  );
  for (const batch of batches(rows, ENERGY_WRITE_BATCH_SIZE)) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "FixtureEnergyDailyAggregate" (
        "id", "fixtureId", "energyFixtureId", "localDate", "estimatedKwh", "estimatedCost",
        "knownSeconds", "unknownSeconds", "createdAt", "updatedAt"
      )
      VALUES ${Prisma.join(batch.map(({ fixtureId, energyFixtureId, delta }) => Prisma.sql`(
        ${randomUUID()}, ${fixtureId}, ${energyFixtureId}, CAST(${localDateString(delta.localDate)} AS DATE), ${delta.estimatedKwh},
        ${delta.estimatedCost}, ${delta.knownSeconds}, ${delta.unknownSeconds},
        CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      )`))}
      ON CONFLICT ("energyFixtureId", "localDate") DO UPDATE SET
        "estimatedKwh" = "FixtureEnergyDailyAggregate"."estimatedKwh" + EXCLUDED."estimatedKwh",
        "estimatedCost" = "FixtureEnergyDailyAggregate"."estimatedCost" + EXCLUDED."estimatedCost",
        "knownSeconds" = "FixtureEnergyDailyAggregate"."knownSeconds" + EXCLUDED."knownSeconds",
        "unknownSeconds" = "FixtureEnergyDailyAggregate"."unknownSeconds" + EXCLUDED."unknownSeconds",
        "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    `);
  }
}

async function persistSiteHourlyDeltas(tx: Prisma.TransactionClient, closures: SiteCheckpointClosure[]) {
  const rows = closures.flatMap(({ energyFixtureId, closed }) =>
    closed.hourlyDeltas.map((delta) => ({ energyFixtureId, delta }))
  );
  for (const batch of batches(rows, ENERGY_WRITE_BATCH_SIZE)) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "FixtureEnergyHourlyAggregate" (
        "id", "energyFixtureId", "bucketStartUtc", "localDate", "localHour", "utcOffsetMinutes",
        "estimatedKwh", "knownSeconds", "unknownSeconds", "brightnessWeightedSeconds", "createdAt", "updatedAt"
      )
      VALUES ${Prisma.join(batch.map(({ energyFixtureId, delta }) => Prisma.sql`(
        ${randomUUID()}, ${energyFixtureId}, ${utcTimestamp(delta.bucketStartUtc)},
        CAST(${localDateString(delta.localDate)} AS DATE), ${delta.localHour},
        ${delta.utcOffsetMinutes}, ${delta.estimatedKwh}, ${delta.knownSeconds}, ${delta.unknownSeconds},
        ${delta.brightnessWeightedSeconds}, CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
        CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      )`))}
      ON CONFLICT ("energyFixtureId", "bucketStartUtc") DO UPDATE SET
        "estimatedKwh" = "FixtureEnergyHourlyAggregate"."estimatedKwh" + EXCLUDED."estimatedKwh",
        "knownSeconds" = "FixtureEnergyHourlyAggregate"."knownSeconds" + EXCLUDED."knownSeconds",
        "unknownSeconds" = "FixtureEnergyHourlyAggregate"."unknownSeconds" + EXCLUDED."unknownSeconds",
        "brightnessWeightedSeconds" = "FixtureEnergyHourlyAggregate"."brightnessWeightedSeconds"
          + EXCLUDED."brightnessWeightedSeconds",
        "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    `);
  }
}

async function persistSiteCheckpoints(tx: Prisma.TransactionClient, closures: SiteCheckpointClosure[]) {
  for (const batch of batches(closures, ENERGY_WRITE_BATCH_SIZE)) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "FixtureEnergyStateCursor" (
        "fixtureId", "aggregatedThrough", "observedStateOccurredAt", "brightness", "powerOn", "ratedWatt",
        "durationRemainders", "createdAt", "updatedAt"
      )
      VALUES ${Prisma.join(batch.map(({ fixtureId, closed }) => Prisma.sql`(
        ${fixtureId}, ${utcTimestamp(closed.nextCheckpoint.aggregatedThrough)},
        ${utcTimestamp(closed.nextCheckpoint.observedStateOccurredAt)},
        ${closed.nextCheckpoint.brightness}, ${closed.nextCheckpoint.powerOn}, ${closed.nextCheckpoint.ratedWatt},
        CAST(${JSON.stringify(closed.nextCheckpoint.durationRemainders)} AS JSONB),
        CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      )`))}
      ON CONFLICT ("fixtureId") DO UPDATE SET
        "aggregatedThrough" = EXCLUDED."aggregatedThrough",
        "observedStateOccurredAt" = EXCLUDED."observedStateOccurredAt",
        "brightness" = EXCLUDED."brightness",
        "powerOn" = EXCLUDED."powerOn",
        "ratedWatt" = EXCLUDED."ratedWatt",
        "durationRemainders" = EXCLUDED."durationRemainders",
        "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    `);
  }
}

function batches<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

function localDateString(value: Date) {
  return value.toISOString().slice(0, 10);
}

function utcTimestamp(value: Date | null) {
  return Prisma.sql`CAST(${value?.toISOString() ?? null} AS TIMESTAMPTZ) AT TIME ZONE 'UTC'`;
}

async function persistDailyDeltas(
  tx: Prisma.TransactionClient,
  fixtureId: string,
  energyFixtureId: string,
  dailyDeltas: ReturnType<typeof closeFixtureEnergyCheckpoint>["dailyDeltas"]
) {
  for (const delta of dailyDeltas) {
    await tx.fixtureEnergyDailyAggregate.upsert({
      where: { energyFixtureId_localDate: { energyFixtureId, localDate: delta.localDate } },
      create: {
        fixtureId,
        energyFixtureId,
        localDate: delta.localDate,
        estimatedKwh: delta.estimatedKwh,
        estimatedCost: delta.estimatedCost,
        knownSeconds: delta.knownSeconds,
        unknownSeconds: delta.unknownSeconds
      },
      update: {
        estimatedKwh: { increment: delta.estimatedKwh },
        estimatedCost: { increment: delta.estimatedCost },
        knownSeconds: { increment: delta.knownSeconds },
        unknownSeconds: { increment: delta.unknownSeconds }
      }
    });
  }
}

async function persistHourlyDeltas(
  tx: Prisma.TransactionClient,
  energyFixtureId: string,
  hourlyDeltas: ReturnType<typeof closeFixtureEnergyCheckpoint>["hourlyDeltas"]
) {
  for (const delta of hourlyDeltas) {
    await tx.fixtureEnergyHourlyAggregate.upsert({
      where: {
        energyFixtureId_bucketStartUtc: { energyFixtureId, bucketStartUtc: delta.bucketStartUtc }
      },
      create: {
        energyFixtureId,
        bucketStartUtc: delta.bucketStartUtc,
        localDate: delta.localDate,
        localHour: delta.localHour,
        utcOffsetMinutes: delta.utcOffsetMinutes,
        estimatedKwh: delta.estimatedKwh,
        knownSeconds: delta.knownSeconds,
        unknownSeconds: delta.unknownSeconds,
        brightnessWeightedSeconds: delta.brightnessWeightedSeconds
      },
      update: {
        estimatedKwh: { increment: delta.estimatedKwh },
        knownSeconds: { increment: delta.knownSeconds },
        unknownSeconds: { increment: delta.unknownSeconds },
        brightnessWeightedSeconds: { increment: delta.brightnessWeightedSeconds }
      }
    });
  }
}

function persistCheckpoint(tx: Prisma.TransactionClient, fixtureId: string, checkpoint: FixtureEnergyCheckpoint) {
  return tx.fixtureEnergyStateCursor.upsert({
    where: { fixtureId },
    create: { fixtureId, ...checkpointData(checkpoint) },
    update: checkpointData(checkpoint)
  });
}

function toSnapshot(row: Pick<LockedFixtureRow,
  "energyTrackingStartedAt" | "firstStateOccurredAt" | "lastStateEventId" | "lastStateSequence" |
  "lastStateOccurredAt" | "brightness" | "powerOn" | "ratedWatt"
>): FixtureEnergySnapshot {
  return {
    energyTrackingStartedAt: row.energyTrackingStartedAt,
    firstStateOccurredAt: row.firstStateOccurredAt,
    lastStateEventId: row.lastStateEventId,
    lastStateSequence: row.lastStateSequence,
    lastStateOccurredAt: row.lastStateOccurredAt,
    brightness: row.brightness,
    powerOn: row.powerOn,
    ratedWatt: new Prisma.Decimal(row.ratedWatt)
  };
}

function toCheckpoint(cursor: {
  aggregatedThrough: Date;
  observedStateOccurredAt: Date | null;
  brightness: number;
  powerOn: boolean | null;
  ratedWatt: Prisma.Decimal;
  durationRemainders: Prisma.JsonValue;
}): FixtureEnergyCheckpoint {
  if (!Array.isArray(cursor.durationRemainders)) throw new Error("invalid fixture energy state cursor");
  return {
    aggregatedThrough: cursor.aggregatedThrough,
    observedStateOccurredAt: cursor.observedStateOccurredAt,
    brightness: cursor.brightness,
    powerOn: cursor.powerOn,
    ratedWatt: new Prisma.Decimal(cursor.ratedWatt),
    durationRemainders: cursor.durationRemainders.map((value) => {
      if (!isRecord(value) || typeof value.localDate !== "string" || typeof value.knownMilliseconds !== "number" ||
          typeof value.unknownMilliseconds !== "number") throw new Error("invalid fixture energy state cursor");
      return {
        localDate: value.localDate,
        knownMilliseconds: value.knownMilliseconds,
        unknownMilliseconds: value.unknownMilliseconds
      };
    })
  };
}

function checkpointData(checkpoint: FixtureEnergyCheckpoint) {
  return {
    aggregatedThrough: checkpoint.aggregatedThrough,
    observedStateOccurredAt: checkpoint.observedStateOccurredAt,
    brightness: checkpoint.brightness,
    powerOn: checkpoint.powerOn,
    ratedWatt: checkpoint.ratedWatt,
    durationRemainders: checkpoint.durationRemainders as unknown as Prisma.InputJsonValue
  };
}

function resultFrom(state: FixtureStateV2, status: IngestionStatus): FixtureStateIngestionResult {
  return { eventId: state.eventId, sequence: state.sequence, fixtureId: state.fixtureId, status };
}

function sameProcessedEvent(
  event: { gatewayId: string; fixtureId: string | null; sequence: bigint; eventType: string; occurredAt: Date; payloadHash: string | null },
  gatewayId: string,
  state: FixtureStateV2,
  payloadHash: string
) {
  return sameProcessedEventIdentity(event, gatewayId, state) && event.payloadHash === payloadHash;
}

function sameProcessedEventIdentity(
  event: { gatewayId: string; fixtureId: string | null; sequence: bigint; eventType: string; occurredAt: Date; payloadHash?: string | null },
  gatewayId: string,
  state: FixtureStateV2
) {
  return event.gatewayId === gatewayId && event.fixtureId === state.fixtureId && event.sequence === BigInt(state.sequence) &&
    event.eventType === "fixture_state" && event.occurredAt.getTime() === new Date(state.occurredAt).getTime() &&
    // Legacy ledger rows lack complete payload hashes; keep their historical
    // duplicate contract only while the raw row remains retained.
    (event.payloadHash == null || event.payloadHash === canonicalPayloadHash(state));
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
