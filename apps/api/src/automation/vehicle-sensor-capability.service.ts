import { BadRequestException, Injectable } from "@nestjs/common";
import {
  mqttTopics,
  type VehicleSensorCapabilityIngestedAckV1,
  type VehicleSensorCapabilityReportV1,
  type VehicleSensorCapabilityReportV2,
  vehicleSensorCapabilityIngestedAckV1Schema,
  vehicleSensorCapabilityReportV1Schema,
  vehicleSensorCapabilityReportV2Schema,
  vehicleSensorCapabilityDeliveryV2Schema,
  vehicleSensorCapabilityIngestedAckV2Schema,
  matchesVehicleSensorCapabilityIngestedAckV2
} from "@led-control/shared";
import { Prisma, type BioPulseReadiness, type VehicleSensorProtocol } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { compareAndAdvanceGatewayEvent } from "../retention/gateway-event-watermark";
import { AutomationClock } from "./automation-clock";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { AutomationSnapshotService, compareAutomationIds } from "./automation-snapshot.service";
import { loadBioSensorEligibility } from "./bio-sensor-eligibility";

export const VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE = "vehicle_sensor_capability";
const BIO_CAPABILITY_EVENT_TYPE = "bio_pulse_capability";

interface LockedCapabilityNode {
  id: string;
  vehicleSensorCapabilityStatus: "unknown" | "supported" | "unsupported";
  vehicleSensorCapabilityVerifiedAt: Date | null;
  vehicleSensorCapabilityRevision: bigint;
  vehicleSensorServerBound: boolean;
  vehicleVendorEventModelBound: boolean;
  fixtureId: string | null;
  vehicleSensorProtocol: VehicleSensorProtocol;
  bioPulseReadiness: BioPulseReadiness;
  bioPulseCapabilityRevision: bigint;
  bioPulseProfileId: string | null;
  bioPulseVerifiedAt: Date | null;
  bioPulseSensorModeVerifiedAt: Date | null;
}

interface CapabilityLedgerRow {
  eventId: string;
  gatewayId: string;
  meshNodeId: string | null;
  sequence: bigint;
  eventType: string;
  payloadHash: string | null;
}

type BioCapabilityResult = { status: "applied" | "duplicate" | "stale" | "rejected"; errorCode: string | null };

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
      if (!node || node.vehicleSensorProtocol === "bio_usb_pulse") {
        throw new BadRequestException("vehicle sensor capability report scope rejected");
      }

      const capabilityRevision = BigInt(report.capabilityRevision);
      const [eventById, eventByRevision] = await Promise.all([
        tx.processedGatewayEvent.findUnique({ where: { eventId: report.eventId } }),
        tx.processedGatewayEvent.findFirst({
          where: {
            gatewayId: report.gatewayId,
            meshNodeId: node.id,
            sequence: capabilityRevision,
            eventType: VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE
          }
        })
      ]);
      const existing = distinctLedgerRows(eventById, eventByRevision);
      if (existing.some((row) => !sameCapabilityLedger(row, node.id, report, payloadHash))) {
        return this.persistAck(tx, report, payloadHash, "rejected", "capability_event_conflict");
      }
      if (existing.length > 0) {
        if (capabilityRevision === node.vehicleSensorCapabilityRevision && !sameCapabilityState(node, report)) {
          return this.persistAck(tx, report, payloadHash, "rejected", "capability_state_conflict");
        }
        return this.persistAck(tx, report, payloadHash, "duplicate", null);
      }

      if (capabilityRevision === node.vehicleSensorCapabilityRevision && !sameCapabilityState(node, report)) {
        return this.persistAck(tx, report, payloadHash, "rejected", "capability_state_conflict");
      }
      const ordering = await compareAndAdvanceGatewayEvent(tx, {
        gatewayId: report.gatewayId, eventType: VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE, scopeKey: node.id,
        sequence: capabilityRevision, eventId: report.eventId, payloadHash, occurredAt: new Date(report.verifiedAt)
      });
      if (ordering === "conflict") return this.persistAck(tx, report, payloadHash, "rejected", "capability_event_conflict");
      if (ordering === "duplicate") return this.persistAck(tx, report, payloadHash, "duplicate", null);

      if (ordering === "stale" || capabilityRevision < node.vehicleSensorCapabilityRevision) {
        await this.createLedger(tx, node, report, payloadHash);
        return this.persistAck(tx, report, payloadHash, "stale", null);
      }
      if (capabilityRevision === node.vehicleSensorCapabilityRevision) {
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

  /** Internal qualification only: no HTTP/MQTT route or V1 ACK. The caller must supply the
   * authenticated Gateway scope; a report cannot change a node's protocol.
   * Persisted qualification is not V2 support, a mode operation result, or
   * permission to execute a BIO rule. Those remain gated in Task 5c. */
  async applyBioReport(rawReport: unknown,
    scope: { siteId: string; gatewayId: string; requireActiveClaim: true }
  ): Promise<{ status: "applied" | "duplicate" | "stale" | "rejected"; errorCode: string | null }> {
    const parsed = vehicleSensorCapabilityReportV2Schema.safeParse(rawReport);
    if (!parsed.success || scope?.requireActiveClaim !== true
      || scope.siteId !== parsed.data.siteId || scope.gatewayId !== parsed.data.gatewayId) {
      throw new BadRequestException("invalid BIO capability report or authenticated scope");
    }
    const report = parsed.data;
    const payloadHash = canonicalPayloadHash(report);
    return this.prisma.$transaction(async tx => {
      await this.automationSnapshot.lockMutation(tx);
      return this.qualifyBioReport(tx, report, payloadHash);
    }, { timeout: 10_000 });
  }

  /** Broker mTLS/topic ACL authenticates delivery. Subscribers do not receive a
   * peer certificate; SQL rechecks current claim, assignment and certificate metadata.
   * An applied receipt records qualification only and cannot authorize a BIO rule. */
  async applyBioDelivery(rawDelivery: unknown,
    scope: { siteId: string; gatewayId: string; requireActiveClaim: true }
  ) {
    const parsed = vehicleSensorCapabilityDeliveryV2Schema.safeParse(rawDelivery);
    if (!parsed.success || scope?.requireActiveClaim !== true
      || scope.siteId !== parsed.data.report.siteId || scope.gatewayId !== parsed.data.report.gatewayId) {
      throw new BadRequestException("invalid BIO capability delivery or authenticated scope");
    }
    const delivery = parsed.data;
    const deliveryPayloadHash = canonicalPayloadHash(delivery);
    return this.prisma.$transaction(async tx => {
      await this.automationSnapshot.lockMutation(tx);
      const now = this.clock.now();
      if (!Number.isFinite(now.getTime())) throw new BadRequestException("BIO capability clock unavailable");
      // Validate current authority before looking up any replay/ACK. Old-assignment
      // receipts may not be revived under a newly claimed Gateway authority.
      const identities = await tx.$queryRaw<Array<{ assignmentVersion: number }>>(Prisma.sql`
        SELECT gateway."assignmentVersion" FROM "Gateway" gateway
        JOIN "GatewayInventory" inventory ON inventory."claimedGatewayId" = gateway."id"
          AND inventory."claimedAt" IS NOT NULL AND inventory."disabledAt" IS NULL
        JOIN "GatewayCertificate" certificate ON certificate."inventoryId" = inventory."id"
          AND certificate."gatewayId" = gateway."id" AND certificate."purpose" = 'mqtt'
          AND certificate."status" = 'active' AND certificate."revokedAt" IS NULL
          -- Prisma DateTime columns are UTC timestamp-without-time-zone values.
          -- Normalize the timestamptz parameter explicitly; session TimeZone must
          -- not reject a valid certificate or admit an expired one.
          AND certificate."notBefore" <= (${now}::timestamptz AT TIME ZONE 'UTC')
          AND certificate."notAfter" > (${now}::timestamptz AT TIME ZONE 'UTC')
        WHERE gateway."id" = ${scope.gatewayId} AND gateway."siteId" = ${scope.siteId}
          AND gateway."claimedAt" IS NOT NULL
        FOR UPDATE OF gateway, inventory, certificate
      `);
      if (!identities.length || identities.some(identity => identity.assignmentVersion !== delivery.assignmentVersion)) {
        throw new BadRequestException("BIO capability current authority rejected");
      }
      const node = await this.lockOwnedNode(tx, delivery.report, true);
      // V1's legacy Fixture alias remains supported by its existing path only.
      // The V2 wire receipt must name exactly the node whose evidence is stored.
      if (!node || node.id !== delivery.report.meshNodeId || node.vehicleSensorProtocol !== "bio_usb_pulse") {
        throw new BadRequestException("BIO capability report scope or protocol rejected");
      }
      const applicationAckKey = `bio-vehicle-sensor-capability:${scope.gatewayId}:${delivery.assignmentVersion}:${node.id}:${delivery.report.eventId}:${deliveryPayloadHash}`;
      const existing = await tx.mqttOutbox.findUnique({ where: { applicationAckKey } });
      const topic = mqttTopics.vehicleSensorCapabilityIngested(scope.siteId, scope.gatewayId);
      if (existing) {
        if (!matchesVehicleSensorCapabilityIngestedAckV2(delivery, existing.payload, deliveryPayloadHash)
          || existing.gatewayId !== scope.gatewayId || existing.topic !== topic
          || existing.automationAssignmentVersion !== delivery.assignmentVersion
          || existing.payloadHash !== canonicalPayloadHash(existing.payload)) {
          throw new BadRequestException("BIO capability receipt identity conflict");
        }
        await this.reviveAck(tx, existing.id, now);
        return vehicleSensorCapabilityIngestedAckV2Schema.parse(existing.payload);
      }
      const outcome = await this.qualifyBioReport(tx, delivery.report, deliveryPayloadHash, node);
      const ack = vehicleSensorCapabilityIngestedAckV2Schema.parse({ schemaVersion: 2,
        siteId: scope.siteId, gatewayId: scope.gatewayId, assignmentVersion: delivery.assignmentVersion,
        eventId: delivery.report.eventId, meshNodeId: delivery.report.meshNodeId,
        capabilityRevision: delivery.report.capabilityRevision, deliveryPayloadHash,
        ...outcome, ingestedAt: now.toISOString() });
      await tx.mqttOutbox.create({ data: { gatewayId: scope.gatewayId, applicationAckKey,
        automationAssignmentVersion: delivery.assignmentVersion, revision: null,
        payloadHash: canonicalPayloadHash(ack), topic, payload: ack } });
      return ack;
    }, { timeout: 10_000 });
  }

  private async qualifyBioReport(
    tx: Prisma.TransactionClient, report: VehicleSensorCapabilityReportV2,
    payloadHash: `sha256:${string}`, lockedNode?: LockedCapabilityNode
  ): Promise<BioCapabilityResult> {
    const result = (status: BioCapabilityResult["status"], errorCode: string | null = null) => ({ status, errorCode });
    const node = lockedNode ?? await this.lockOwnedNode(tx, report, true);
    if (!node || node.vehicleSensorProtocol !== "bio_usb_pulse") {
      throw new BadRequestException("BIO capability report scope or protocol rejected");
    }
    const revision = BigInt(report.capabilityRevision);
    const [eventById, eventByRevision] = await Promise.all([
      tx.processedGatewayEvent.findUnique({ where: { eventId: report.eventId } }),
      tx.processedGatewayEvent.findFirst({ where: {
        gatewayId: report.gatewayId, meshNodeId: node.id, sequence: revision, eventType: BIO_CAPABILITY_EVENT_TYPE
      } })
    ]);
    const existing = distinctLedgerRows(eventById, eventByRevision);
    if (existing.some(row => !sameCapabilityLedger(row, node.id, report, payloadHash, BIO_CAPABILITY_EVENT_TYPE))) {
      return result("rejected", "capability_event_conflict");
    }
    if (revision === node.bioPulseCapabilityRevision && !sameBioCapabilityState(node, report)) {
      return result("rejected", "capability_state_conflict");
    }
    if (existing.length > 0) return result("duplicate");
    const ordering = await compareAndAdvanceGatewayEvent(tx, {
      gatewayId: report.gatewayId, eventType: BIO_CAPABILITY_EVENT_TYPE, scopeKey: node.id,
      sequence: revision, eventId: report.eventId, payloadHash, occurredAt: new Date(report.verifiedAt)
    });
    if (ordering === "conflict") return result("rejected", "capability_event_conflict");
    if (ordering === "duplicate") return result("duplicate");
    if (ordering === "stale" || revision < node.bioPulseCapabilityRevision) {
      await this.createLedger(tx, node, report, payloadHash, BIO_CAPABILITY_EVENT_TYPE);
      return result("stale");
    }
    if (revision === node.bioPulseCapabilityRevision) {
      await this.createLedger(tx, node, report, payloadHash, BIO_CAPABILITY_EVENT_TYPE);
      return result("duplicate");
    }
    // Proposed values are broker-authenticated and exact delivery/current scope
    // checked above. Qualification does not depend on an already-ready node.
    if (report.readiness === "ready") {
      const evidence = node.fixtureId ? await loadBioSensorEligibility(tx, [node.fixtureId], this.clock.now(), report) : null;
      const view = node.fixtureId ? evidence?.get(node.fixtureId) : null;
      if (!view || view.blockedReasons.length) {
        await this.disableAffectedRules(tx, node, report.gatewayId);
        return result("rejected", "bio_current_evidence_unverified");
      }
    }
    if (report.readiness !== "ready" || (node.bioPulseReadiness === "ready"
      && node.bioPulseProfileId !== report.verifiedFingerprintId)) {
      // The DB rejects downgrading an enabled source. Disable and enqueue the
      // new configuration in this same transaction before changing evidence.
      await this.disableAffectedRules(tx, node, report.gatewayId);
    }
    await tx.meshNode.update({ where: { id: node.id }, data: {
      bioPulseReadiness: report.readiness, bioPulseCapabilityRevision: revision,
      bioPulseProfileId: report.verifiedFingerprintId, bioPulseVerifiedAt: new Date(report.verifiedAt),
      bioPulseSensorModeVerifiedAt: report.sensorModeVerifiedAt ? new Date(report.sensorModeVerifiedAt) : null
    } });
    await this.createLedger(tx, node, report, payloadHash, BIO_CAPABILITY_EVENT_TYPE);
    return result("applied");
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
    report: Pick<VehicleSensorCapabilityReportV1, "siteId" | "gatewayId" | "meshNodeId">,
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
    const nodes = await tx.$queryRaw<LockedCapabilityNode[]>(Prisma.sql`
      SELECT
        node."id",
        node."vehicleSensorProtocol",
        node."bioPulseReadiness",
        node."bioPulseCapabilityRevision",
        node."bioPulseProfileId",
        node."bioPulseVerifiedAt",
        node."bioPulseSensorModeVerifiedAt",
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
      WHERE (node."id" = ${report.meshNodeId} OR fixture."id" = ${report.meshNodeId})
        AND node."gatewayId" = ${report.gatewayId}
        AND gateway."siteId" = ${report.siteId}
      ${lockTargets}
    `);
    return nodes.length === 1 ? nodes[0] : null;
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
    report: VehicleSensorCapabilityReportV1 | VehicleSensorCapabilityReportV2,
    payloadHash: `sha256:${string}`,
    eventType = VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE
  ) {
    return tx.processedGatewayEvent.create({
      data: {
        eventId: report.eventId,
        gatewayId: report.gatewayId,
        meshNodeId: node.id,
        scopeKey: node.id,
        fixtureId: node.fixtureId,
        sequence: BigInt(report.capabilityRevision),
        eventType,
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
      await this.reviveAck(tx, existingOutbox.id, now);
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

  private reviveAck(tx: Prisma.TransactionClient, id: string, now: Date) {
    // Only publication lifecycle changes. The original ACK payload/hash/ingestedAt
    // remain immutable, and an active publisher lease is never stolen.
    return tx.mqttOutbox.updateMany({ where: { id,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      AND: [{ OR: [{ publishedAt: { not: null } }, { deadLetteredAt: { not: null } },
        { leaseExpiresAt: { lte: now } }] }]
    }, data: { attempts: 0, nextAttemptAt: now, publishedAt: null, lockedBy: null,
      lockedAt: null, leaseExpiresAt: null, deadLetteredAt: null, lastError: null } });
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
  canonicalMeshNodeId: string,
  report: VehicleSensorCapabilityReportV1 | VehicleSensorCapabilityReportV2,
  payloadHash: string,
  eventType = VEHICLE_SENSOR_CAPABILITY_EVENT_TYPE
) {
  return row.gatewayId === report.gatewayId
    && row.meshNodeId === canonicalMeshNodeId
    && row.sequence === BigInt(report.capabilityRevision)
    && row.eventType === eventType
    && row.payloadHash === payloadHash;
}

function sameBioCapabilityState(node: LockedCapabilityNode, report: VehicleSensorCapabilityReportV2) {
  return node.bioPulseReadiness === report.readiness
    && node.bioPulseProfileId === report.verifiedFingerprintId
    && node.bioPulseVerifiedAt?.getTime() === new Date(report.verifiedAt).getTime()
    && (node.bioPulseSensorModeVerifiedAt?.getTime() ?? null) === (report.sensorModeVerifiedAt ? new Date(report.sensorModeVerifiedAt).getTime() : null);
}

function sameCapabilityState(node: LockedCapabilityNode, report: VehicleSensorCapabilityReportV1) {
  return node.vehicleSensorCapabilityStatus === report.status
    && node.vehicleSensorCapabilityVerifiedAt?.getTime() === new Date(report.verifiedAt).getTime()
    && node.vehicleSensorServerBound === report.sensorServerBound
    && node.vehicleVendorEventModelBound === report.vendorVehicleEventModelBound;
}
