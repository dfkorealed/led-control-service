import { BadRequestException, Injectable } from "@nestjs/common";
import {
  mqttTopics,
  type VehicleSensorCapabilityIngestedAckV1,
  type VehicleSensorCapabilityReportV1,
  vehicleSensorCapabilityIngestedAckV1Schema,
  vehicleSensorCapabilityReportV1Schema
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AutomationClock } from "./automation-clock";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { AutomationSnapshotService, compareAutomationIds } from "./automation-snapshot.service";

export const VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE = "vehicle_sensor_capability";

interface LockedCapabilityNode {
  id: string;
  vehicleSensorCapabilityStatus: "unknown" | "supported" | "unsupported";
  vehicleSensorCapabilityVerifiedAt: Date | null;
  vehicleSensorCapabilityRevision: bigint;
  vehicleSensorServerBound: boolean;
  vehicleVendorEventModelBound: boolean;
  fixtureId: string | null;
}

interface CapabilityLedgerRow {
  eventId: string;
  gatewayId: string;
  meshNodeId: string | null;
  sequence: bigint;
  eventType: string;
  payloadHash: string | null;
}

@Injectable()
export class VehicleSensorCapabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly automationSnapshot: AutomationSnapshotService,
    private readonly clock: AutomationClock
  ) {}

  async applyReport(
    rawReport: unknown,
    scope?: { siteId: string; gatewayId: string; requireActiveClaim: boolean }
  ): Promise<VehicleSensorCapabilityIngestedAckV1> {
    const parsed = vehicleSensorCapabilityReportV1Schema.safeParse(rawReport);
    if (!parsed.success) {
      throw new BadRequestException("invalid vehicle sensor capability report");
    }
    const report = parsed.data;
    if (scope && (scope.siteId !== report.siteId || scope.gatewayId !== report.gatewayId)) {
      throw new BadRequestException("vehicle sensor capability report scope rejected");
    }
    const payloadHash = canonicalPayloadHash(report);

    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      const node = await this.lockOwnedNode(tx, report, scope?.requireActiveClaim === true);
      if (!node) {
        throw new BadRequestException("vehicle sensor capability report scope rejected");
      }

      const capabilityRevision = BigInt(report.capabilityRevision);
      const [eventById, eventByRevision] = await Promise.all([
        tx.processedGatewayEvent.findUnique({ where: { eventId: report.eventId } }),
        tx.processedGatewayEvent.findFirst({
          where: {
            gatewayId: report.gatewayId,
            meshNodeId: report.meshNodeId,
            sequence: capabilityRevision,
            eventType: VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE
          }
        })
      ]);
      const existing = distinctLedgerRows(eventById, eventByRevision);
      if (existing.some((row) => !sameCapabilityLedger(row, report, payloadHash))) {
        return this.persistAck(tx, report, payloadHash, "rejected", "capability_event_conflict");
      }
      if (existing.length > 0) {
        if (capabilityRevision === node.vehicleSensorCapabilityRevision && !sameCapabilityState(node, report)) {
          return this.persistAck(tx, report, payloadHash, "rejected", "capability_state_conflict");
        }
        return this.persistAck(tx, report, payloadHash, "duplicate", null);
      }

      if (capabilityRevision < node.vehicleSensorCapabilityRevision) {
        await this.createLedger(tx, node, report, payloadHash);
        return this.persistAck(tx, report, payloadHash, "stale", null);
      }
      if (capabilityRevision === node.vehicleSensorCapabilityRevision) {
        if (!sameCapabilityState(node, report)) {
          return this.persistAck(tx, report, payloadHash, "rejected", "capability_state_conflict");
        }
        await this.createLedger(tx, node, report, payloadHash);
        return this.persistAck(tx, report, payloadHash, "duplicate", null);
      }

      if (report.status === "unsupported") {
        await this.disableAffectedRules(tx, node, report.gatewayId);
      }
      await this.updateMetadata(tx, node.id, report);
      await this.createLedger(tx, node, report, payloadHash);
      return this.persistAck(tx, report, payloadHash, "applied", null);
    }, { timeout: 10_000 });
  }

  private async disableAffectedRules(
    tx: Prisma.TransactionClient,
    node: LockedCapabilityNode,
    gatewayId: string
  ) {
    const enabledRules = node.fixtureId
      ? await tx.vehicleEventRule.findMany({
        where: {
          gatewayId,
          status: "enabled",
          sources: { some: { fixtureId: node.fixtureId } }
        },
        select: { id: true },
        orderBy: { id: "asc" }
      })
      : [];
    const ruleIds = enabledRules.map(({ id }) => id).sort(compareAutomationIds);
    if (ruleIds.length === 0) return;

    const disabledRuleCount = (await tx.vehicleEventRule.updateMany({
      where: { id: { in: ruleIds }, status: "enabled" },
      data: { status: "disabled" }
    })).count;
    if (disabledRuleCount > 0) {
      await this.automationSnapshot.incrementDesiredRevision(tx, gatewayId);
    }
  }

  private async lockOwnedNode(
    tx: Prisma.TransactionClient,
    report: VehicleSensorCapabilityReportV1,
    requireActiveClaim: boolean
  ) {
    const activeClaimJoin = requireActiveClaim ? Prisma.sql`
      INNER JOIN "GatewayInventory" AS inventory
        ON inventory."claimedGatewayId" = gateway."id"
        AND inventory."claimedAt" IS NOT NULL
        AND inventory."disabledAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM "GatewayCertificate" AS certificate
          WHERE certificate."inventoryId" = inventory."id"
            AND certificate."gatewayId" = gateway."id"
            AND certificate."purpose" = 'mqtt'
            AND certificate."status" = 'active'
            AND certificate."revokedAt" IS NULL
        )
    ` : Prisma.empty;
    const lockTargets = requireActiveClaim
      ? Prisma.sql`FOR UPDATE OF node, gateway, inventory`
      : Prisma.sql`FOR UPDATE OF node, gateway`;
    const [node] = await tx.$queryRaw<LockedCapabilityNode[]>(Prisma.sql`
      SELECT
        node."id",
        node."vehicleSensorCapabilityStatus",
        node."vehicleSensorCapabilityVerifiedAt",
        node."vehicleSensorCapabilityRevision",
        node."vehicleSensorServerBound",
        node."vehicleVendorEventModelBound",
        fixture."id" AS "fixtureId"
      FROM "MeshNode" AS node
      INNER JOIN "Gateway" AS gateway ON gateway."id" = node."gatewayId"
      ${activeClaimJoin}
      LEFT JOIN "Fixture" AS fixture ON fixture."meshNodeId" = node."id"
      WHERE node."id" = ${report.meshNodeId}
        AND node."gatewayId" = ${report.gatewayId}
        AND gateway."siteId" = ${report.siteId}
      ${lockTargets}
    `);
    return node;
  }

  private updateMetadata(
    tx: Prisma.TransactionClient,
    meshNodeId: string,
    report: VehicleSensorCapabilityReportV1
  ) {
    return tx.meshNode.update({
      where: { id: meshNodeId },
      data: {
        vehicleSensorCapabilityStatus: report.status,
        vehicleSensorCapabilityVerifiedAt: new Date(report.verifiedAt),
        vehicleSensorCapabilityRevision: BigInt(report.capabilityRevision),
        vehicleSensorServerBound: report.sensorServerBound,
        vehicleVendorEventModelBound: report.vendorVehicleEventModelBound
      }
    });
  }

  private createLedger(
    tx: Prisma.TransactionClient,
    node: LockedCapabilityNode,
    report: VehicleSensorCapabilityReportV1,
    payloadHash: `sha256:${string}`
  ) {
    return tx.processedGatewayEvent.create({
      data: {
        eventId: report.eventId,
        gatewayId: report.gatewayId,
        meshNodeId: report.meshNodeId,
        fixtureId: node.fixtureId,
        sequence: BigInt(report.capabilityRevision),
        eventType: VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE,
        payloadHash,
        occurredAt: new Date(report.verifiedAt)
      }
    });
  }

  private ack(
    report: VehicleSensorCapabilityReportV1,
    reportPayloadHash: `sha256:${string}`,
    status: VehicleSensorCapabilityIngestedAckV1["status"],
    errorCode: string | null,
    ingestedAt: string
  ) {
    return vehicleSensorCapabilityIngestedAckV1Schema.parse({
      schemaVersion: 1,
      eventId: report.eventId,
      gatewayId: report.gatewayId,
      meshNodeId: report.meshNodeId,
      capabilityRevision: report.capabilityRevision,
      reportPayloadHash,
      status,
      errorCode,
      ingestedAt
    });
  }

  private async persistAck(
    tx: Prisma.TransactionClient,
    report: VehicleSensorCapabilityReportV1,
    reportPayloadHash: `sha256:${string}`,
    status: VehicleSensorCapabilityIngestedAckV1["status"],
    errorCode: string | null
  ) {
    const applicationAckKey =
      `vehicle-sensor-capability:${report.gatewayId}:${report.meshNodeId}:${report.eventId}:${reportPayloadHash}`;
    const existingOutbox = await tx.mqttOutbox.findUnique({
      where: { applicationAckKey }
    });
    const now = this.clock.now();
    if (existingOutbox) {
      const existingAck = vehicleSensorCapabilityIngestedAckV1Schema.parse(existingOutbox.payload);
      await tx.mqttOutbox.updateMany({
        where: {
          id: existingOutbox.id,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          AND: [{
            OR: [
              { publishedAt: { not: null } },
              { deadLetteredAt: { not: null } },
              { leaseExpiresAt: { lte: now } }
            ]
          }]
        },
        data: {
          attempts: 0,
          nextAttemptAt: now,
          publishedAt: null,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          deadLetteredAt: null,
          lastError: null
        }
      });
      return existingAck;
    }

    const ack = this.ack(report, reportPayloadHash, status, errorCode, now.toISOString());
    const payloadHash = canonicalPayloadHash(ack);
    const topic = mqttTopics.vehicleSensorCapabilityIngested(report.siteId, report.gatewayId);
    const stored = await tx.mqttOutbox.create({
      data: {
        gatewayId: report.gatewayId,
        applicationAckKey,
        revision: null,
        payloadHash,
        topic,
        payload: ack
      }
    });
    return vehicleSensorCapabilityIngestedAckV1Schema.parse(stored.payload);
  }
}

function distinctLedgerRows(
  eventById: CapabilityLedgerRow | null,
  eventByRevision: CapabilityLedgerRow | null
) {
  if (!eventById) return eventByRevision ? [eventByRevision] : [];
  if (!eventByRevision || eventByRevision.eventId === eventById.eventId) return [eventById];
  return [eventById, eventByRevision];
}

function sameCapabilityLedger(
  row: CapabilityLedgerRow,
  report: VehicleSensorCapabilityReportV1,
  payloadHash: string
) {
  return row.gatewayId === report.gatewayId
    && row.meshNodeId === report.meshNodeId
    && row.sequence === BigInt(report.capabilityRevision)
    && row.eventType === VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE
    && row.payloadHash === payloadHash;
}

function sameCapabilityState(node: LockedCapabilityNode, report: VehicleSensorCapabilityReportV1) {
  return node.vehicleSensorCapabilityStatus === report.status
    && node.vehicleSensorCapabilityVerifiedAt?.getTime() === new Date(report.verifiedAt).getTime()
    && node.vehicleSensorServerBound === report.sensorServerBound
    && node.vehicleVendorEventModelBound === report.vendorVehicleEventModelBound;
}
