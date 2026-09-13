import { Injectable, Optional } from "@nestjs/common";
import {
  applicationProvisioningDeviceTerminalIngestedAckV2Schema,
  mqttTopicsV2,
  provisioningDeviceCommandV2Schema,
  provisioningDeviceTerminalV2Schema,
  type ApplicationProvisioningDeviceTerminalIngestedAckV2,
  type ProvisioningDeviceTerminalV2
} from "@led-control/shared";
import { Prisma, type ProcessedGatewayEvent } from "@prisma/client";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { PrismaService } from "../prisma/prisma.service";

export const PROVISIONING_DEVICE_TERMINAL_EVENT_TYPE = "provisioning_device_terminal";

const DEVICE_UUID_CONFLICT_ERROR = "device UUID is already registered by another site";
const FIXTURE_FLOOR_CONFLICT_ERROR = "fixture is already assigned to another floor";
const PROVISIONING_WAITING_STATE = "provisioning_waiting_state";
const UNKNOWN_TERMINAL_ERROR = "조명 등록 결과를 자동 확정하지 못했습니다. 장비 상태를 확인해 주세요.";

type GatewayScope = { siteId: string; gatewayId: string };

type LegacyCompletedEvent = {
  sessionId: string;
  nodeId: string;
  deviceUuid: string;
  meshAddress: string;
  firmwareVersion?: string;
  rssi?: number | null;
  hopCount?: number | null;
  completedAt: string;
};

type LockedCommand = NonNullable<Awaited<ReturnType<Prisma.TransactionClient["provisioningDeviceOutbox"]["findUnique"]>>> & {
  session: {
    id: string;
    siteId: string;
    floorId: string;
    gatewayId: string;
    status: string;
  };
  node: {
    id: string;
    sessionId: string;
    deviceUuid: string;
    serialNumber: string;
    firmwareVersion: string;
    rssi: number;
    status: string;
    identifyState: string;
    meshAddress: string | null;
    pendingFixtureName: string | null;
    pendingFixtureX: number | null;
    pendingFixtureY: number | null;
    pendingFixtureSize: number | null;
    pendingRatedWatt: Prisma.Decimal | null;
  };
};

@Injectable()
export class ProvisioningDeviceTerminalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meshControlGroups: MeshControlGroupService,
    @Optional() private readonly energyDimensions?: EnergyDimensionHistoryService
  ) {}

  async ingest(
    scope: GatewayScope,
    rawEvent: ProvisioningDeviceTerminalV2,
    receivedAt: Date
  ): Promise<ApplicationProvisioningDeviceTerminalIngestedAckV2> {
    const event = provisioningDeviceTerminalV2Schema.parse(rawEvent);
    if (scope.siteId !== event.siteId || scope.gatewayId !== event.gatewayId) {
      throw new Error("provisioning device terminal topic scope rejected");
    }
    const frozenReceivedAt = new Date(receivedAt.getTime());
    const apply = () => this.prisma.$transaction(
      (tx) => this.ingestInTransaction(tx, scope, event, frozenReceivedAt),
      { timeout: 10_000 }
    );
    try {
      return await apply();
    } catch (error) {
      // A concurrent command can win the device UUID unique key after our read.
      // Replaying the complete transaction lets the locked stored command decide
      // whether the terminal is now applicable or requires reconciliation.
      if (!isDeviceUuidUniqueConstraintError(error)) throw error;
      return apply();
    }
  }

  async completeLegacy(scope: GatewayScope, event: LegacyCompletedEvent) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const sessionScope = await tx.provisioningSession.findUnique({
          where: { id: event.sessionId },
          select: { siteId: true, floorId: true, gatewayId: true }
        });
        if (!sessionScope || sessionScope.siteId !== scope.siteId || sessionScope.gatewayId !== scope.gatewayId) return;
        await this.lockLegacyRows(tx, sessionScope, event.sessionId, event.nodeId);
        const session = await tx.provisioningSession.findUnique({ where: { id: event.sessionId } });
        if (!session || session.status !== "active" || session.siteId !== scope.siteId || session.gatewayId !== scope.gatewayId) {
          return;
        }
        const floor = await tx.floor.findFirst({
          where: { id: session.floorId, siteId: session.siteId },
          select: { status: true }
        });
        if (!floor || floor.status !== "active") return;
        const node = await tx.discoveredMeshNode.findFirst({
          where: {
            id: event.nodeId,
            sessionId: event.sessionId,
            deviceUuid: event.deviceUuid,
            status: { in: ["provisioning", "reconcile_required"] }
          }
        });
        if (!node) return;
        await this.applyCompleted(tx, scope, event, session, node, "legacy");
      });
    } catch (error) {
      if (!isDeviceUuidUniqueConstraintError(error)) throw error;
      await this.markLegacyDeviceUuidConflict(scope, event);
    }
  }

  private async ingestInTransaction(
    tx: Prisma.TransactionClient,
    scope: GatewayScope,
    event: ProvisioningDeviceTerminalV2,
    receivedAt: Date
  ) {
    const command = await this.lockStoredCommand(tx, event.commandId);
    if (!command || !storedCommandMatches(command, event)) {
      throw new Error("provisioning device terminal stored command identity conflict");
    }
    if (command.session.siteId !== scope.siteId || command.session.gatewayId !== scope.gatewayId) {
      throw new Error("provisioning device terminal tenant rejected");
    }

    const payloadHash = canonicalPayloadHash(event);
    const [eventById, eventAtOrAboveSequence] = await Promise.all([
      tx.processedGatewayEvent.findUnique({ where: { eventId: event.eventId } }),
      tx.processedGatewayEvent.findFirst({
        where: {
          gatewayId: event.gatewayId,
          eventType: PROVISIONING_DEVICE_TERMINAL_EVENT_TYPE,
          sequence: { gte: BigInt(event.sequence) }
        },
        orderBy: { sequence: "asc" }
      })
    ]);
    const ledgers = distinctLedgers(eventById, eventAtOrAboveSequence);
    if (ledgers.some((ledger) => !sameTerminalLedger(ledger, event, payloadHash))) {
      throw new Error("provisioning device terminal ledger identity conflict");
    }
    if (ledgers.length > 0) {
      return this.persistAcknowledgement(tx, event, receivedAt);
    }

    if (command.session.status !== "active") {
      throw new Error("provisioning device terminal session rejected");
    }
    if (event.operation === "identify") {
      const latestIdentify = await tx.provisioningDeviceOutbox.findFirst({
        where: {
          sessionId: command.sessionId,
          nodeId: command.nodeId,
          deadLetteredAt: null,
          payload: { path: ["operation"], equals: "identify" }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true }
      });
      // An earlier command may finish after its timeout and after the user has
      // started another identify. We still ledger and ACK that terminal so the
      // Gateway journal can drain, but only the newest command may transition
      // the node visible to the current browser operation.
      if (latestIdentify?.id === command.id) {
        await this.applyIdentifyTerminal(tx, command, event);
      }
    } else if (event.status === "completed") {
      const applied = await this.applyCompleted(tx, scope, {
        sessionId: event.sessionId,
        nodeId: event.nodeId,
        deviceUuid: event.deviceUuid,
        meshAddress: event.meshAddress,
        firmwareVersion: event.firmwareVersion,
        rssi: event.rssi,
        hopCount: event.hopCount,
        completedAt: event.occurredAt
      }, command.session, command.node, "v2");
      if (!applied) await this.markUnknownTerminal(tx, command, UNKNOWN_TERMINAL_ERROR);
    } else {
      await this.markUnknownTerminal(tx, command, event.errorMessage);
    }

    await tx.processedGatewayEvent.create({
      data: {
        eventId: event.eventId,
        gatewayId: event.gatewayId,
        sequence: BigInt(event.sequence),
        eventType: PROVISIONING_DEVICE_TERMINAL_EVENT_TYPE,
        payloadHash,
        occurredAt: new Date(event.occurredAt),
        receivedAt
      }
    });
    return this.persistAcknowledgement(tx, event, receivedAt);
  }

  private async lockStoredCommand(tx: Prisma.TransactionClient, commandId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT outbox."id"
      FROM "ProvisioningDeviceOutbox" AS outbox
      INNER JOIN "ProvisioningSession" AS session ON session."id" = outbox."sessionId"
      INNER JOIN "DiscoveredMeshNode" AS node ON node."id" = outbox."nodeId"
      WHERE outbox."id" = ${commandId}
      FOR UPDATE OF outbox, session, node
    `);
    if (locked.length !== 1) return null;
    return tx.provisioningDeviceOutbox.findUnique({
      where: { id: commandId },
      include: { session: true, node: true }
    }) as Promise<LockedCommand | null>;
  }

  private async persistAcknowledgement(
    tx: Prisma.TransactionClient,
    event: ProvisioningDeviceTerminalV2,
    receivedAt: Date
  ) {
    const applicationAckKey = `provisioning-device-terminal:${event.gatewayId}:${event.commandId}`;
    const topic = mqttTopicsV2.provisioningDeviceTerminalIngestedAck(event.siteId, event.gatewayId);
    const existing = await tx.mqttOutbox.findUnique({ where: { applicationAckKey } });
    const now = new Date(receivedAt.getTime());
    if (existing) {
      const stored = applicationProvisioningDeviceTerminalIngestedAckV2Schema.parse(existing.payload);
      if (
        existing.gatewayId !== event.gatewayId || existing.topic !== topic ||
        !ackMatchesTerminal(stored, event)
      ) {
        throw new Error("provisioning device terminal acknowledgement identity conflict");
      }
      await tx.mqttOutbox.updateMany({
        where: {
          id: existing.id,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          AND: [{ OR: [
            { publishedAt: { not: null } },
            { deadLetteredAt: { not: null } },
            { leaseExpiresAt: { lte: now } }
          ] }]
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
      return stored;
    }

    const acknowledgement = applicationProvisioningDeviceTerminalIngestedAckV2Schema.parse({
      commandId: event.commandId,
      sessionId: event.sessionId,
      siteId: event.siteId,
      gatewayId: event.gatewayId,
      nodeId: event.nodeId,
      deviceUuid: event.deviceUuid,
      ...(event.operation === "identify"
        ? { operation: "identify" as const }
        : { ...(event.operation === undefined ? {} : { operation: event.operation }), meshAddress: event.meshAddress }),
      eventId: event.eventId,
      sequence: event.sequence,
      ingestedAt: now.toISOString()
    });
    const stored = await tx.mqttOutbox.create({
      data: {
        gatewayId: event.gatewayId,
        applicationAckKey,
        revision: null,
        payloadHash: canonicalPayloadHash(acknowledgement),
        topic,
        payload: acknowledgement
      }
    });
    return applicationProvisioningDeviceTerminalIngestedAckV2Schema.parse(stored.payload);
  }

  private async applyCompleted(
    tx: Prisma.TransactionClient,
    scope: GatewayScope,
    event: LegacyCompletedEvent,
    session: { id: string; siteId: string; floorId: string; gatewayId: string; status: string },
    node: LockedCommand["node"],
    mode: "legacy" | "v2"
  ) {
    if (
      session.status !== "active" || session.siteId !== scope.siteId || session.gatewayId !== scope.gatewayId ||
      node.id !== event.nodeId || node.sessionId !== event.sessionId || node.deviceUuid !== event.deviceUuid
    ) return false;
    if (node.status === "provisioned") return node.meshAddress === event.meshAddress;
    if (node.status !== "provisioning" && node.status !== "reconcile_required") return false;
    if (!node.pendingFixtureName || node.pendingFixtureX === null || node.pendingFixtureY === null) return false;

    const existingMeshNode = await tx.meshNode.findUnique({ where: { deviceUuid: event.deviceUuid } });
    if (existingMeshNode && existingMeshNode.gatewayId !== session.gatewayId) {
      await tx.discoveredMeshNode.update({
        where: { id: node.id },
        data: {
          status: mode === "legacy" ? "failed" : "reconcile_required",
          errorMessage: DEVICE_UUID_CONFLICT_ERROR
        }
      });
      return true;
    }

    const meshNode = existingMeshNode ?? await tx.meshNode.create({
      data: {
        gatewayId: session.gatewayId,
        deviceUuid: event.deviceUuid,
        serialNumber: node.serialNumber,
        meshAddress: event.meshAddress,
        firmwareVersion: event.firmwareVersion ?? node.firmwareVersion
      }
    });
    const existingFixture = await tx.fixture.findFirst({
      where: { meshNodeId: meshNode.id },
      select: { id: true, floorId: true }
    });
    if (existingFixture && existingFixture.floorId !== session.floorId) {
      await tx.discoveredMeshNode.update({
        where: { id: node.id },
        data: {
          status: mode === "legacy" ? "failed" : "reconcile_required",
          errorMessage: FIXTURE_FLOOR_CONFLICT_ERROR
        }
      });
      return true;
    }

    let fixture = existingFixture;
    if (!fixture) {
      const createdFixture = await tx.fixture.create({
        data: {
          id: node.id,
          floorId: session.floorId,
          meshNodeId: meshNode.id,
          name: node.pendingFixtureName,
          ratedWatt: node.pendingRatedWatt ?? "40.00",
          x: node.pendingFixtureX,
          y: node.pendingFixtureY,
          size: node.pendingFixtureSize ?? 20,
          status: "offline",
          statusReason: PROVISIONING_WAITING_STATE,
          reportedStatus: "offline",
          reportedStatusReason: PROVISIONING_WAITING_STATE,
          brightness: 0,
          rssi: null,
          hopCount: null,
          commandSuccessRate: null,
          lastSeenAt: null
        }
      });
      fixture = createdFixture;
      if (this.energyDimensions) {
        const floor = await tx.floor.findUniqueOrThrow({
          where: { id: session.floorId },
          select: { name: true }
        });
        await this.energyDimensions.recordFixtureDimensions(tx, {
          fixtureId: createdFixture.id,
          siteId: session.siteId,
          name: node.pendingFixtureName,
          floorId: session.floorId,
          floorName: floor.name,
          ratedWatt: new Prisma.Decimal(node.pendingRatedWatt ?? "40.00"),
          trackingStartedAt: createdFixture.energyTrackingStartedAt,
          effectiveAt: createdFixture.createdAt
        });
      }
    }
    const fixtureGroups = await tx.groupFixture.findMany({
      where: { fixtureId: fixture.id },
      select: { groupId: true },
      orderBy: { groupId: "asc" }
    });
    await this.meshControlGroups.attachProvisionedNode(tx, {
      meshNodeId: meshNode.id,
      gatewayId: session.gatewayId,
      floorId: session.floorId,
      fixtureGroupIds: fixtureGroups.map((membership) => membership.groupId)
    });
    await tx.discoveredMeshNode.update({
      where: { id: node.id },
      data: {
        status: "provisioned",
        identifyState: "confirmed",
        meshAddress: event.meshAddress,
        firmwareVersion: event.firmwareVersion ?? node.firmwareVersion,
        rssi: event.rssi ?? node.rssi,
        errorMessage: null
      }
    });
    return true;
  }

  private async applyIdentifyTerminal(
    tx: Prisma.TransactionClient,
    command: LockedCommand,
    event: Extract<ProvisioningDeviceTerminalV2, { operation: "identify" }>
  ) {
    if (command.node.status === "discovered" && command.node.identifyState === "failed") {
      // A result arriving after the bounded API timeout is still ledgered and
      // acknowledged so Gateway replay can drain, but cannot rewrite the
      // already-visible timeout into success.
      return;
    }
    if (command.node.status !== "identifying" || !["pending", "running"].includes(command.node.identifyState)) {
      throw new Error("provisioning identify terminal node state rejected");
    }
    // The BIO adapter returns success only after its fixed force-on interval
    // and a verified sensor-mode report. The shared schema makes
    // restoreConfirmed=false invalid, so no light-left-on ambiguity becomes a
    // successful registration state.
    await tx.discoveredMeshNode.update({
      where: { id: command.node.id },
      data: event.status === "completed"
        ? { status: "discovered", identifyState: "confirmed", errorMessage: null }
        : { status: "discovered", identifyState: "failed", errorMessage: event.errorMessage }
    });
  }

  private markUnknownTerminal(tx: Prisma.TransactionClient, command: LockedCommand, errorMessage: string) {
    return tx.discoveredMeshNode.update({
      where: { id: command.node.id },
      data: { status: "reconcile_required", errorMessage }
    });
  }

  private lockLegacyRows(
    tx: Prisma.TransactionClient,
    scope: { siteId: string; floorId: string },
    sessionId: string,
    nodeId: string
  ) {
    return Promise.all([
      tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${scope.floorId} AND "siteId" = ${scope.siteId} FOR UPDATE`,
      tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${sessionId} FOR UPDATE`,
      tx.$queryRaw`SELECT "id" FROM "DiscoveredMeshNode" WHERE "id" = ${nodeId} AND "sessionId" = ${sessionId} FOR UPDATE`
    ]);
  }

  private markLegacyDeviceUuidConflict(scope: GatewayScope, event: LegacyCompletedEvent) {
    return this.prisma.discoveredMeshNode.updateMany({
      where: {
        id: event.nodeId,
        sessionId: event.sessionId,
        deviceUuid: event.deviceUuid,
        status: { in: ["discovered", "identifying", "provisioning", "reconcile_required"] },
        session: { siteId: scope.siteId, gatewayId: scope.gatewayId, status: "active" }
      },
      data: { status: "failed", errorMessage: DEVICE_UUID_CONFLICT_ERROR }
    });
  }
}

function storedCommandMatches(command: LockedCommand, event: ProvisioningDeviceTerminalV2) {
  const stored = provisioningDeviceCommandV2Schema.safeParse(command.payload);
  if (!stored.success) return false;
  const operation = operationOf(event);
  const expectedTopic = mqttTopicsV2.gatewayCommand(
    event.siteId,
    event.gatewayId,
    operation === "identify" ? "provisioning/identify-device" : "provisioning/provision-device"
  );
  return command.id === event.commandId && command.sessionId === event.sessionId && command.nodeId === event.nodeId &&
    command.topic === expectedTopic && stored.data.commandId === event.commandId &&
    stored.data.sessionId === event.sessionId && stored.data.siteId === event.siteId &&
    stored.data.gatewayId === event.gatewayId && stored.data.nodeId === event.nodeId &&
    stored.data.deviceUuid === event.deviceUuid && operationOf(stored.data) === operation &&
    meshAddressOf(stored.data) === meshAddressOf(event) &&
    command.node.id === event.nodeId && command.node.sessionId === event.sessionId &&
    command.node.deviceUuid === event.deviceUuid &&
    (operation === "identify" ? command.node.meshAddress === null : command.node.meshAddress === meshAddressOf(event)) &&
    command.session.id === event.sessionId;
}

function distinctLedgers(first: ProcessedGatewayEvent | null, second: ProcessedGatewayEvent | null) {
  if (!first) return second ? [second] : [];
  if (!second || second.eventId === first.eventId) return [first];
  return [first, second];
}

function sameTerminalLedger(
  ledger: ProcessedGatewayEvent,
  event: ProvisioningDeviceTerminalV2,
  payloadHash: string
) {
  return ledger.eventId === event.eventId && ledger.gatewayId === event.gatewayId &&
    ledger.sequence === BigInt(event.sequence) && ledger.eventType === PROVISIONING_DEVICE_TERMINAL_EVENT_TYPE &&
    ledger.payloadHash === payloadHash && ledger.occurredAt.getTime() === new Date(event.occurredAt).getTime();
}

function ackMatchesTerminal(
  ack: ApplicationProvisioningDeviceTerminalIngestedAckV2,
  event: ProvisioningDeviceTerminalV2
) {
  return ack.commandId === event.commandId && ack.sessionId === event.sessionId && ack.siteId === event.siteId &&
    ack.gatewayId === event.gatewayId && ack.nodeId === event.nodeId && ack.deviceUuid === event.deviceUuid &&
    operationOf(ack) === operationOf(event) && meshAddressOf(ack) === meshAddressOf(event) &&
    ack.eventId === event.eventId && ack.sequence === event.sequence;
}

function operationOf(value: { operation?: "identify" | "provision" }) {
  return value.operation ?? "provision";
}

function meshAddressOf(value: object) {
  return "meshAddress" in value ? value.meshAddress : undefined;
}

function isDeviceUuidUniqueConstraintError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") return false;
  const target = "meta" in error && error.meta && typeof error.meta === "object" && "target" in error.meta
    ? error.meta.target
    : undefined;
  if (Array.isArray(target)) return target.length === 1 && target[0] === "deviceUuid";
  return typeof target === "string" && /(^|_)deviceUuid(_key)?$/.test(target);
}
