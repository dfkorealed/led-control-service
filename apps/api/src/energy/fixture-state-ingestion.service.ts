import { Prisma } from "@prisma/client";
import { Injectable } from "@nestjs/common";
import {
  fixtureStateV2Schema,
  mapHealthFaults,
  statusFromHealth,
  type ApplicationStateIngestedAckV2,
  type FixtureStateV2
} from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";
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

export interface FixtureStateIngestionResult {
  eventId: string;
  sequence: number;
  fixtureId: string;
  status: IngestionStatus;
}

@Injectable()
export class FixtureStateIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(gatewayId: string, input: FixtureStateV2): Promise<FixtureStateIngestionResult> {
    const state = fixtureStateV2Schema.parse(input);
    try {
      return await this.prisma.$transaction(
        async (tx) => this.ingestInTransaction(tx, gatewayId, state),
        { timeout: 10_000 }
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const duplicate = await this.prisma.processedGatewayEvent.findUnique({ where: { eventId: state.eventId } });
      if (!duplicate || !sameProcessedEvent(duplicate, gatewayId, state)) throw new Error("fixture state sequence conflict");
      return resultFrom(state, "duplicate");
    }
  }

  private async ingestInTransaction(tx: Prisma.TransactionClient, gatewayId: string, state: FixtureStateV2) {
    const existing = await tx.processedGatewayEvent.findUnique({ where: { eventId: state.eventId } });
    if (existing) {
      if (!sameProcessedEvent(existing, gatewayId, state)) throw new Error("fixture state event identity conflict");
      return resultFrom(state, "duplicate");
    }

    const sequenceConflict = await tx.processedGatewayEvent.findFirst({
      where: { gatewayId, sequence: BigInt(state.sequence), eventType: "fixture_state" }
    });
    if (sequenceConflict) throw new Error("fixture state sequence conflict");

    const [fixture] = await tx.$queryRaw<LockedFixtureRow[]>(Prisma.sql`
      SELECT
        f."id",
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
      WHERE f."id" = ${state.fixtureId}
        AND fl."siteId" = ${state.siteId}
        AND mn."gatewayId" = ${gatewayId}
        AND mn."gatewayId" = ${state.gatewayId}
      FOR UPDATE OF f
    `);
    if (!fixture) throw new Error("fixture state scope rejected");

    const snapshot = toSnapshot(fixture);
    const storedCursor = await tx.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: fixture.id } });
    const checkpoint = storedCursor ? toCheckpoint(storedCursor) : createInitialFixtureEnergyCheckpoint(snapshot);
    const transition = aggregateFixtureStateTransition({
      snapshot,
      checkpoint,
      event: {
        eventId: state.eventId,
        sequence: BigInt(state.sequence),
        occurredAt: new Date(state.occurredAt),
        brightness: state.brightness,
        powerOn: state.powerOn
      },
      timeZone: fixture.timeZone,
      tariffKwhRate: new Prisma.Decimal(fixture.tariffKwhRate)
    });

    await tx.processedGatewayEvent.create({
      data: {
        eventId: state.eventId,
        gatewayId,
        fixtureId: state.fixtureId,
        sequence: BigInt(state.sequence),
        eventType: "fixture_state",
        occurredAt: new Date(state.occurredAt)
      }
    });

    if (transition.status !== "accepted") return resultFrom(state, transition.status);

    await persistDailyDeltas(tx, fixture.id, transition.dailyDeltas);
    await persistCheckpoint(tx, fixture.id, transition.nextCheckpoint);

    const health = state.health
      ? { faultCodes: mapHealthFaults(state.health.faultCodes), observedAt: new Date(state.health.observedAt) }
      : null;
    await tx.fixture.update({
      where: { id: fixture.id },
      data: {
        brightness: state.brightness,
        powerOn: state.powerOn,
        status: health ? statusFromHealth(health.faultCodes) : state.status,
        statusReason: state.statusReason ?? "reported",
        ...(health ? { healthFaultCodes: health.faultCodes, healthLastSeenAt: health.observedAt } : {}),
        rssi: state.rssi,
        hopCount: state.hopCount,
        lastSeenAt: new Date(state.occurredAt),
        firstStateOccurredAt: transition.nextSnapshot.firstStateOccurredAt,
        lastStateEventId: state.eventId,
        lastStateSequence: BigInt(state.sequence),
        lastStateOccurredAt: new Date(state.occurredAt)
      }
    });
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
  await persistDailyDeltas(tx, fixtureId, closed.dailyDeltas);
  await persistCheckpoint(tx, fixtureId, closed.nextCheckpoint);
  return true;
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
}

async function persistDailyDeltas(
  tx: Prisma.TransactionClient,
  fixtureId: string,
  dailyDeltas: ReturnType<typeof closeFixtureEnergyCheckpoint>["dailyDeltas"]
) {
  for (const delta of dailyDeltas) {
    await tx.fixtureEnergyDailyAggregate.upsert({
      where: { fixtureId_localDate: { fixtureId, localDate: delta.localDate } },
      create: {
        fixtureId,
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

function persistCheckpoint(tx: Prisma.TransactionClient, fixtureId: string, checkpoint: FixtureEnergyCheckpoint) {
  return tx.fixtureEnergyStateCursor.upsert({
    where: { fixtureId },
    create: { fixtureId, ...checkpointData(checkpoint) },
    update: checkpointData(checkpoint)
  });
}

function toSnapshot(row: LockedFixtureRow): FixtureEnergySnapshot {
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
  event: { gatewayId: string; fixtureId: string | null; sequence: bigint; eventType: string; occurredAt: Date },
  gatewayId: string,
  state: FixtureStateV2
) {
  return event.gatewayId === gatewayId && event.fixtureId === state.fixtureId && event.sequence === BigInt(state.sequence) &&
    event.eventType === "fixture_state" && event.occurredAt.getTime() === new Date(state.occurredAt).getTime();
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
