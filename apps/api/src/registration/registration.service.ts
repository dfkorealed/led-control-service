import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  CreateRegistrationSessionInput,
  gatewayHeartbeatFreshSince,
  mqttTopicsV2,
  provisioningDeviceCommandV2Schema,
  RegisterFixtureBatchInput,
  registerFixtureBatchSchema
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegistrationAllocationService } from "./registration-allocation.service";
import { lockRegistrationDomain } from "./registration-domain-locks";

interface RegisterNodeInput {
  fixtureName: string;
  x: number;
  y: number;
  ratedWatt?: string;
}

interface PendingRegistration {
  nodeId: string;
  deviceUuid: string;
  meshAddress: string;
  fixtureName: string;
  ratedWatt: string;
  x: number;
  y: number;
  size: number;
}

const INTERNAL_REGISTRATION_SESSION_FIELDS = [
  "scanTerminalEventId",
  "scanTerminalSequence",
  "scanTerminalEventType",
  "scanTerminalPayloadHash",
  "scanTerminalIngestedAt"
] as const;

type InternalRegistrationSessionField = typeof INTERNAL_REGISTRATION_SESSION_FIELDS[number];

// Polling must identify the operation whose state it reports, not merely a
// node's reusable "confirmed/failed" string. Select only immutable ownership
// metadata (including timed-out/dead-lettered operations), never command payloads.
const identifyOperationInclude = {
  deviceOutbox: {
    where: { payload: { path: ["operation"], equals: "identify" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
    select: { id: true, createdAt: true }
  }
} satisfies Prisma.DiscoveredMeshNodeInclude;

const registrationResponseSelect = {
  deviceUuid: true,
  gateway: { select: { siteId: true } },
  fixture: {
    select: {
      id: true,
      name: true,
      floorId: true,
      floor: { select: { name: true } }
    }
  }
} satisfies Prisma.MeshNodeSelect;

const registrationSiteSelect = {
  deviceUuid: true,
  gateway: { select: { siteId: true } }
} satisfies Prisma.MeshNodeSelect;

type RegistrationResponseRecord = Prisma.MeshNodeGetPayload<{ select: typeof registrationResponseSelect }>;

@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService,
    private readonly siteAccess: SiteAccessService,
    private readonly allocationService: RegistrationAllocationService,
    private readonly meshControlGroups: MeshControlGroupService
  ) {}

  async createSession(user: AuthenticatedUser, input: CreateRegistrationSessionInput) {
    await this.assertCommissionAccess(user, input.siteId);

    try {
      const session = await this.prisma.$transaction(async (tx) => {
        await this.siteAccess.assertCommissionInTransaction(tx, user, input.siteId);
        await this.assertActiveFloorInTransaction(tx, input.siteId, input.floorId);

        await this.lockGateway(tx, input.gatewayId);
        const gateway = await tx.gateway.findFirst({
          where: {
            id: input.gatewayId,
            siteId: input.siteId,
            lastHeartbeatAt: { gte: gatewayHeartbeatFreshSince(new Date()) }
          }
        });
        if (!gateway) throw new BadRequestException("gatewayId must reference an online gateway in the selected site");

        const scanCorrelationId = randomUUID();
        const session = await tx.provisioningSession.create({
          data: {
            siteId: input.siteId,
            floorId: input.floorId,
            gatewayId: gateway.id,
            requestedBy: user.id,
            status: "active",
            scanStatus: "pending",
            scanCorrelationId,
            scanAttempt: 1,
            scanStartedAt: null
          },
          include: { discoveredNodes: { include: identifyOperationInclude } }
        });
        await tx.provisioningScanOutbox.create({
          data: this.createScanOutboxData(session, scanCorrelationId, 1)
        });
        return toRegistrationSessionResponse(tx, session);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return session;
    } catch (error) {
      if (this.isGatewayScanConflict(error)) throw new ConflictException({ code: "gateway_scan_in_progress" });
      throw error;
    }
  }

  async getSession(user: AuthenticatedUser, sessionId: string) {
    // Prisma can fetch included relations with separate SQL statements. One
    // repeatable-read snapshot prevents an old terminal node from being paired
    // with retry #2's newly inserted outbox ownership between those statements.
    const session = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.provisioningSession.findUnique({
        where: { id: sessionId },
        include: { site: true, discoveredNodes: { orderBy: { discoveredAt: "asc" }, include: identifyOperationInclude } }
      });
      return stored ? toRegistrationSessionResponse(tx, stored) : null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    if (!session) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, session.siteId);
    return session;
  }

  async listActiveSessions(user: AuthenticatedUser, siteId: string) {
    await this.assertCommissionAccess(user, siteId);
    return this.prisma.$transaction(async (tx) => {
      const sessions = await tx.provisioningSession.findMany({
        where: { siteId, status: "active" },
        orderBy: { startedAt: "desc" },
        include: { discoveredNodes: { orderBy: { discoveredAt: "asc" }, include: identifyOperationInclude } }
      });
      return toRegistrationSessionResponses(tx, sessions);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async identifyNode(user: AuthenticatedUser, sessionId: string, nodeId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true, floorId: true, gatewayId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await lockRegistrationDomain(tx, { ...accessSession, sessionId, nodeIds: [nodeId] });
      await this.assertActiveFloorStateInTransaction(tx, accessSession.siteId, accessSession.floorId);
      const gateway = await tx.gateway.findFirst({ where: {
        id: accessSession.gatewayId,
        siteId: accessSession.siteId,
        lastHeartbeatAt: { gte: gatewayHeartbeatFreshSince(new Date()) }
      } });
      if (!gateway) throw new ConflictException({ code: "registration_gateway_offline" });
      const session = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
      if (
        !session
        || session.siteId !== accessSession.siteId
        || session.floorId !== accessSession.floorId
        || session.gatewayId !== accessSession.gatewayId
      ) {
        throw new NotFoundException("registration session not found");
      }
      this.assertActiveSession(session.status);
      if (session.scanStatus !== "completed") {
        throw new ConflictException({ code: "identify_scan_not_completed" });
      }
      const node = await tx.discoveredMeshNode.findUnique({ where: { id: nodeId } });
      if (!node || node.sessionId !== session.id) throw new NotFoundException("discovered node not found");
      if (node.scanCorrelationId !== session.scanCorrelationId || node.scanAttempt !== session.scanAttempt) {
        throw new ConflictException({ code: "identify_node_stale" });
      }
      if (node.meshAddress !== null || !["discovered", "identifying"].includes(node.status)) {
        throw new ConflictException({ code: "identify_node_wrong_state" });
      }

      const existing = await tx.provisioningDeviceOutbox.findFirst({
        where: {
          sessionId,
          nodeId,
          deadLetteredAt: null,
          payload: { path: ["operation"], equals: "identify" }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      });
      if (node.status === "identifying") {
        if (!existing) throw new ConflictException({ code: "identify_state_requires_reconciliation" });
        return {
          status: "accepted" as const,
          operationId: existing.id,
          node: await toRegistrationNodeResponse(tx, session.siteId, node, existing)
        };
      }

      const commandId = randomUUID();
      const payload = provisioningDeviceCommandV2Schema.parse({
        operation: "identify",
        commandId,
        sessionId,
        siteId: session.siteId,
        gatewayId: session.gatewayId,
        nodeId,
        deviceUuid: node.deviceUuid,
        requestedAt: new Date().toISOString()
      });
      const updatedNode = await tx.discoveredMeshNode.update({
        where: { id: node.id },
        data: { status: "identifying", identifyState: "pending", errorMessage: null }
      });
      const operation = await tx.provisioningDeviceOutbox.create({ data: {
        id: commandId,
        sessionId,
        nodeId,
        topic: mqttTopicsV2.gatewayCommand(session.siteId, session.gatewayId, "provisioning/identify-device"),
        payload
      } });
      return {
        status: "accepted" as const,
        operationId: commandId,
        node: await toRegistrationNodeResponse(tx, session.siteId, updatedNode, operation)
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async retryScan(user: AuthenticatedUser, sessionId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true, floorId: true, gatewayId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    try {
      const session = await this.prisma.$transaction(async (tx) => {
        await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
        await lockRegistrationDomain(tx, { ...accessSession, sessionId, allSessionNodes: true });
        await this.assertActiveFloorStateInTransaction(tx, accessSession.siteId, accessSession.floorId);
        const current = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
        this.assertSessionScope(current, accessSession);
        this.assertActiveSession(current.status);
        if (current.scanStatus !== "completed" && current.scanStatus !== "failed") {
          throw new ConflictException({ code: "scan_retry_requires_terminal_scan" });
        }
        await this.assertNoIdentifyInFlight(tx, sessionId);
        const unresolvedNodeCount = await tx.discoveredMeshNode.count({
          where: {
            sessionId,
            status: { in: ["provisioning", "reconcile_required"] }
          }
        });
        if (unresolvedNodeCount > 0) {
          throw new ConflictException({ code: "scan_retry_has_unresolved_nodes" });
        }

        const scanCorrelationId = randomUUID();
        const session = await tx.provisioningSession.update({
          where: { id: current.id },
          data: {
            scanStatus: "pending",
            scanCorrelationId,
            scanAttempt: current.scanAttempt + 1,
            scanStartedAt: null,
            scanCompletedAt: null,
            scanFailureCode: null,
            scanFailureMessage: null
          }
        });
        await tx.provisioningScanOutbox.create({
          data: this.createScanOutboxData(session, scanCorrelationId, session.scanAttempt)
        });
        return toRegistrationSessionResponse(tx, session);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return session;
    } catch (error) {
      if (this.isGatewayScanConflict(error)) throw new ConflictException({ code: "gateway_scan_in_progress" });
      throw error;
    }
  }

  async registerNode(user: AuthenticatedUser, sessionId: string, nodeId: string, input: RegisterNodeInput) {
    if (!input.fixtureName.trim()) throw new BadRequestException("fixtureName is required");
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      throw new BadRequestException("x and y must be valid floor plan coordinates");
    }

    const batchInput = registerFixtureBatchSchema.parse({
      mode: "individual",
      defaults: { namePrefix: "L", startNumber: 1, digits: 3 },
      nodes: [{
        nodeId,
        fixtureName: input.fixtureName.trim(),
        ratedWatt: input.ratedWatt ?? "40.00",
        size: 20,
        placement: { mode: "manual", x: input.x, y: input.y }
      }]
    });
    const result = await this.registerBatch(user, sessionId, batchInput);
    const item = result.items[0];
    if (item.status === "validation_failed") throw new BadRequestException(item.error);

    const discoveredNode = await this.prisma.$transaction(async (tx) => {
      const session = await tx.provisioningSession.findUnique({
        where: { id: sessionId },
        select: { siteId: true }
      });
      const node = await tx.discoveredMeshNode.findUnique({ where: { id: nodeId } });
      if (!session || !node || node.sessionId !== sessionId) {
        throw new NotFoundException("discovered node not found");
      }
      return toRegistrationNodeResponse(tx, session.siteId, node);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { fixture: null, discoveredNode };
  }

  async registerBatch(user: AuthenticatedUser, sessionId: string, input: RegisterFixtureBatchInput) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true, floorId: true, gatewayId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    // 등록 요청은 주소 예약, node 준비 상태, durable outbox를 함께 commit해 같은 주소가 두 등록에 배정되는 실패를 막는다.
    // accepted는 이 DB commit만 뜻하며 MQTT PUBACK, 물리 provisioning, Fixture 확정을 뜻하지 않는다.
    const prepared = await this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await lockRegistrationDomain(tx, { ...accessSession, sessionId, allSessionNodes: true });
      await this.assertActiveFloorStateInTransaction(tx, accessSession.siteId, accessSession.floorId);
      const session = await tx.provisioningSession.findUnique({
        where: { id: sessionId },
        include: { floor: { include: { floorPlan: true } } }
      });
      this.assertSessionScope(session, accessSession);
      this.assertActiveSession(session.status);
      if (session.scanStatus !== "completed") {
        throw new ConflictException({ code: "registration_scan_not_completed" });
      }
      const nodeIds = input.nodes.map((node) => node.nodeId).sort();
      await this.assertNoIdentifyInFlight(tx, sessionId);
      const nodes = await tx.discoveredMeshNode.findMany({
        where: { sessionId, id: { in: nodeIds } }
      });
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const failures = new Map<string, string>();
      const candidates: Array<{
        nodeId: string;
        deviceUuid: string;
        meshAddress: string | null;
        fixtureName: string;
        ratedWatt: string;
        size: number;
      }> = [];

      for (const requested of input.nodes) {
        const node = nodesById.get(requested.nodeId);
        if (!node) {
          failures.set(requested.nodeId, "discovered node not found");
          continue;
        }
        if (node.status !== "discovered") {
          failures.set(requested.nodeId, "discovered node is not available for registration");
          continue;
        }
        if (
          node.scanCorrelationId === null
          || node.scanAttempt === null
          || node.scanCorrelationId !== session.scanCorrelationId
          || node.scanAttempt !== session.scanAttempt
        ) {
          failures.set(requested.nodeId, "discovered node does not belong to the current completed scan");
          continue;
        }
        const individual = input.mode === "individual"
          ? input.nodes.find((item) => item.nodeId === requested.nodeId)
          : undefined;
        candidates.push({
          nodeId: node.id,
          deviceUuid: node.deviceUuid,
          meshAddress: node.meshAddress,
          fixtureName: individual?.fixtureName ?? "",
          ratedWatt: individual?.ratedWatt ?? (input.mode === "batch" ? input.defaults.ratedWatt : "40.00"),
          size: individual?.size ?? (input.mode === "batch" ? input.defaults.size : 20)
        });
      }

      const existingMeshNodes = candidates.length > 0
        ? await tx.meshNode.findMany({
          where: { deviceUuid: { in: candidates.map((candidate) => candidate.deviceUuid) } },
          select: registrationSiteSelect
        })
        : [];
      const existingByDeviceUuid = new Map(existingMeshNodes.flatMap((meshNode) => meshNode.deviceUuid
        ? [[meshNode.deviceUuid, meshNode] as const]
        : []));
      const availableCandidates = candidates.filter((candidate) => {
        const existing = existingByDeviceUuid.get(candidate.deviceUuid);
        if (!existing) return true;
        failures.set(
          candidate.nodeId,
          existing.gateway.siteId === session.siteId
            ? "fixture already registered in this site"
            : "fixture already registered in another site"
        );
        return false;
      });

      if (availableCandidates.length > 0) {
        await this.meshControlGroups.ensureFloorGroup(tx, session.gatewayId, session.floorId);
      }

      // Legacy placement input remains accepted but is intentionally ignored. Numeric zeroes
      // satisfy the provisioning contract only; the new Fixture default is unplaced, not (0,0).
      const positioned = availableCandidates.map((candidate) => ({ ...candidate, x: 0, y: 0 }));

      const generatedNameCandidates = positioned.filter((candidate) => !candidate.fixtureName);
      const fixtureNumbers = generatedNameCandidates.length > 0
        ? await this.allocationService.reserveFixtureNumbers(
          tx,
          session.floorId,
          generatedNameCandidates.length,
          input.defaults.startNumber
        )
        : [];
      const generatedNames = new Map(generatedNameCandidates.map((candidate, index) => [
        candidate.nodeId,
        `${input.defaults.namePrefix}${fixtureNumbers[index].toString().padStart(input.defaults.digits, "0")}`
      ]));
      const nodesNeedingAddress = positioned.filter((candidate) => !candidate.meshAddress);
      const meshAddresses = nodesNeedingAddress.length > 0
        ? await this.allocationService.reserveMeshAddresses(tx, session.gatewayId, nodesNeedingAddress.length)
        : [];
      const reservedAddresses = new Map(nodesNeedingAddress.map((candidate, index) => [candidate.nodeId, meshAddresses[index]]));

      const registrations: PendingRegistration[] = [];
      for (const candidate of positioned) {
        const registration = {
          nodeId: candidate.nodeId,
          deviceUuid: candidate.deviceUuid,
          meshAddress: candidate.meshAddress ?? reservedAddresses.get(candidate.nodeId)!,
          fixtureName: candidate.fixtureName || generatedNames.get(candidate.nodeId)!,
          ratedWatt: candidate.ratedWatt,
          x: candidate.x,
          y: candidate.y,
          size: candidate.size
        };
        await tx.discoveredMeshNode.update({
          where: { id: candidate.nodeId },
          data: {
            status: "provisioning",
            meshAddress: registration.meshAddress,
            pendingFixtureName: registration.fixtureName,
            pendingFixtureX: registration.x,
            pendingFixtureY: registration.y,
            pendingFixtureSize: registration.size,
            pendingRatedWatt: registration.ratedWatt,
            errorMessage: null
          }
        });
        const commandId = randomUUID();
        const payload = provisioningDeviceCommandV2Schema.parse({
          commandId,
          sessionId,
          siteId: session.siteId,
          gatewayId: session.gatewayId,
          nodeId: registration.nodeId,
          deviceUuid: registration.deviceUuid,
          meshAddress: registration.meshAddress,
          requestedAt: new Date().toISOString()
        });
        await tx.provisioningDeviceOutbox.create({
          data: {
            id: commandId,
            sessionId,
            nodeId: registration.nodeId,
            topic: mqttTopicsV2.gatewayCommand(session.siteId, session.gatewayId, "provisioning/provision-device"),
            payload
          }
        });
        registrations.push(registration);
      }
      const registrationsByNodeId = new Map(registrations.map((registration) => [registration.nodeId, registration]));

      return {
        items: input.nodes.map((node) => failures.has(node.nodeId)
          ? { nodeId: node.nodeId, status: "validation_failed" as const, error: failures.get(node.nodeId)! }
          : {
            nodeId: node.nodeId,
            status: "accepted" as const,
            fixtureName: registrationsByNodeId.get(node.nodeId)!.fixtureName
          })
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    return { items: prepared.items };
  }

  async excludeNode(user: AuthenticatedUser, sessionId: string, nodeId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true, floorId: true, gatewayId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await lockRegistrationDomain(tx, { ...accessSession, sessionId, nodeIds: [nodeId] });
      await this.assertActiveFloorStateInTransaction(tx, accessSession.siteId, accessSession.floorId);
      const session = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
      this.assertSessionScope(session, accessSession);
      this.assertActiveSession(session.status);

      const node = await tx.discoveredMeshNode.findFirst({ where: { id: nodeId, sessionId } });
      if (!node) throw new NotFoundException("discovered node not found");
      if (node.status !== "reconcile_required") {
        throw new ConflictException({ code: "node_exclusion_requires_reconciliation" });
      }

      const excludedMessage = "현재 세션에서 제외됨";
      const errorMessage = node.errorMessage
        ? `${node.errorMessage}; ${excludedMessage}`
        : excludedMessage;
      const updated = await tx.discoveredMeshNode.update({
        where: { id: nodeId },
        data: { status: "failed", errorMessage }
      });
      return toRegistrationNodeResponse(tx, session.siteId, updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async completeSession(user: AuthenticatedUser, sessionId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true, floorId: true, gatewayId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);
    const completed = await this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await lockRegistrationDomain(tx, { ...accessSession, sessionId, allSessionNodes: true });
      await this.assertActiveFloorStateInTransaction(tx, accessSession.siteId, accessSession.floorId);
      const session = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
      this.assertSessionScope(session, accessSession);
      this.assertActiveSession(session.status);
      if (session.scanStatus !== "completed" && session.scanStatus !== "failed") {
        throw new ConflictException({ code: "scan_session_not_terminal" });
      }
      await this.assertNoIdentifyInFlight(tx, sessionId);
      const unresolvedNodeCount = await tx.discoveredMeshNode.count({
        where: {
          sessionId,
          status: { in: ["provisioning", "reconcile_required"] }
        }
      });
      if (unresolvedNodeCount > 0) {
        throw new ConflictException({ code: "registration_session_has_unresolved_nodes" });
      }
      const provisionedCount = await tx.discoveredMeshNode.count({
        where: { sessionId, status: "provisioned" }
      });
      if (provisionedCount < 1) {
        throw new ConflictException({ code: "registration_session_requires_provisioned_node" });
      }
      const updated = await tx.provisioningSession.update({
        where: { id: sessionId },
        data: { status: "completed", completedAt: new Date() },
        include: { discoveredNodes: { include: identifyOperationInclude } }
      });
      return toRegistrationSessionResponse(tx, updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return completed;
  }

  async cancelSession(user: AuthenticatedUser, sessionId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true, floorId: true, gatewayId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    const cancelled = await this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await lockRegistrationDomain(tx, { ...accessSession, sessionId, allSessionNodes: true });
      await this.assertActiveFloorStateInTransaction(tx, accessSession.siteId, accessSession.floorId);
      const session = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
      this.assertSessionScope(session, accessSession);
      this.assertActiveSession(session.status);
      if (session.scanStatus !== "completed" && session.scanStatus !== "failed") {
        throw new ConflictException({ code: "scan_session_not_terminal" });
      }
      await this.assertNoIdentifyInFlight(tx, sessionId);

      const blockingNodeCount = await tx.discoveredMeshNode.count({
        where: {
          sessionId,
          status: { in: ["provisioning", "reconcile_required", "provisioned"] }
        }
      });
      if (blockingNodeCount > 0) {
        throw new ConflictException({ code: "registration_session_not_empty" });
      }

      const updated = await tx.provisioningSession.update({
        where: { id: sessionId },
        data: { status: "cancelled", completedAt: new Date() },
        include: { discoveredNodes: { include: identifyOperationInclude } }
      });
      return toRegistrationSessionResponse(tx, updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return cancelled;
  }

  private assertActiveSession(status: string) {
    if (status !== "active") throw new BadRequestException("registration session is not active");
  }

  private assertSessionScope(
    session: { siteId: string; floorId: string; gatewayId: string } | null,
    expected: { siteId: string; floorId: string; gatewayId: string }
  ): asserts session is { siteId: string; floorId: string; gatewayId: string } {
    if (
      !session
      || session.siteId !== expected.siteId
      || session.floorId !== expected.floorId
      || session.gatewayId !== expected.gatewayId
    ) throw new NotFoundException("registration session not found");
  }

  private async lockGateway(tx: Prisma.TransactionClient, gatewayId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Gateway" WHERE "id" = ${gatewayId} FOR UPDATE`;
  }

  private async assertNoIdentifyInFlight(tx: Prisma.TransactionClient, sessionId: string) {
    const identifying = await tx.discoveredMeshNode.findFirst({
      where: { sessionId, status: "identifying" },
      select: { id: true }
    });
    if (identifying) throw new ConflictException({ code: "registration_identify_in_progress" });
  }

  private async assertActiveFloorInTransaction(
    tx: Prisma.TransactionClient,
    siteId: string,
    floorId: string
  ) {
    await tx.$queryRaw`
      SELECT "id" FROM "Floor"
      WHERE "id" = ${floorId} AND "siteId" = ${siteId}
      FOR UPDATE
    `;
    await this.assertActiveFloorStateInTransaction(tx, siteId, floorId);
  }

  private async assertActiveFloorStateInTransaction(
    tx: Prisma.TransactionClient,
    siteId: string,
    floorId: string
  ) {
    const floor = await tx.floor.findFirst({
      where: { id: floorId, siteId },
      select: { status: true }
    });
    if (!floor) throw new BadRequestException("floorId must reference a floor in the selected site");
    if (floor.status !== "active") throw new ConflictException({ code: "floor_archived" });
  }

  private createScanOutboxData(
    session: { id: string; siteId: string; gatewayId: string; floorId: string },
    scanCorrelationId: string,
    scanAttempt: number
  ) {
    return {
      sessionId: session.id,
      scanAttempt,
      topic: mqttTopicsV2.gatewayCommand(session.siteId, session.gatewayId, "provisioning/scan-start"),
      payload: {
        sessionId: session.id,
        siteId: session.siteId,
        gatewayId: session.gatewayId,
        floorId: session.floorId,
        scanCorrelationId,
        scanAttempt,
        requestedAt: new Date().toISOString()
      }
    };
  }

  private isGatewayScanConflict(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
  }

  private async assertCommissionAccess(user: AuthenticatedUser, siteId: string) {
    if (user.role !== "admin" || user.status !== "active" || user.organizationType !== "customer") {
      throw new NotFoundException("site not found");
    }
    await this.siteAccess.assert(user, siteId, "commission");
  }
}

interface RegistrationNodeShape {
  deviceUuid: string;
  [key: string]: unknown;
}

interface RegistrationSessionShape {
  siteId: string;
  discoveredNodes?: RegistrationNodeShape[];
  [key: string]: unknown;
}

type RegistrationNodeResponse = RegistrationNodeShape & {
  identifyOperationId: string | null;
  identifyOperationStartedAt: Date | null;
  registrationEligibility: "available" | "registered_in_site" | "registered_elsewhere";
  existingRegistration: {
    fixtureId: string | null;
    fixtureName: string | null;
    floorId: string | null;
    floorName: string | null;
  } | null;
};

async function toRegistrationSessionResponse<T extends RegistrationSessionShape>(
  tx: Prisma.TransactionClient,
  session: T
): Promise<Omit<T, InternalRegistrationSessionField>> {
  const [response] = await toRegistrationSessionResponses(tx, [session]);
  return response;
}

async function toRegistrationSessionResponses<T extends RegistrationSessionShape>(
  tx: Prisma.TransactionClient,
  sessions: T[]
): Promise<Array<Omit<T, InternalRegistrationSessionField>>> {
  const responses = sessions.map((session) => {
    const response = { ...session } as RegistrationSessionShape & Partial<Record<InternalRegistrationSessionField, unknown>>;
    for (const field of INTERNAL_REGISTRATION_SESSION_FIELDS) delete response[field];
    return response;
  });
  const nodes = responses.flatMap((response) => Array.isArray(response.discoveredNodes) ? response.discoveredNodes : []);
  const registrationsByDeviceUuid = await findRegistrationResponses(tx, nodes.map((node) => node.deviceUuid));

  for (const response of responses) {
    if (!Array.isArray(response.discoveredNodes)) continue;
    response.discoveredNodes = response.discoveredNodes.map((node) => presentRegistrationNode(
      response.siteId,
      node,
      registrationsByDeviceUuid.get(node.deviceUuid)
    ));
  }
  return responses as unknown as Array<Omit<T, InternalRegistrationSessionField>>;
}

async function toRegistrationNodeResponse<T extends RegistrationNodeShape>(
  tx: Prisma.TransactionClient,
  siteId: string,
  node: T,
  operation?: { id: string; createdAt?: Date }
) {
  const registrationsByDeviceUuid = await findRegistrationResponses(tx, [node.deviceUuid]);
  return presentRegistrationNode(siteId, node, registrationsByDeviceUuid.get(node.deviceUuid), operation);
}

async function findRegistrationResponses(
  tx: Prisma.TransactionClient,
  deviceUuids: string[]
): Promise<Map<string, RegistrationResponseRecord>> {
  const uniqueDeviceUuids = [...new Set(deviceUuids)];
  if (uniqueDeviceUuids.length === 0) return new Map();
  const registrations = await tx.meshNode.findMany({
    where: { deviceUuid: { in: uniqueDeviceUuids } },
    select: registrationResponseSelect
  });
  return new Map(registrations.flatMap((registration) => registration.deviceUuid
    ? [[registration.deviceUuid, registration] as const]
    : []));
}

function presentRegistrationNode<T extends RegistrationNodeShape>(
  siteId: string,
  node: T,
  registration?: RegistrationResponseRecord,
  operation?: { id: string; createdAt?: Date }
): RegistrationNodeResponse {
  const { deviceOutbox, ...publicNode } = node as T & { deviceOutbox?: Array<{ id: string; createdAt: Date }> };
  const latest = operation ?? deviceOutbox?.[0];
  const registrationEligibility = !registration
    ? "available" as const
    : registration.gateway.siteId === siteId
      ? "registered_in_site" as const
      : "registered_elsewhere" as const;
  const existingRegistration = registration && registration.gateway.siteId === siteId
    ? {
      fixtureId: registration.fixture?.id ?? null,
      fixtureName: registration.fixture?.name ?? null,
      floorId: registration.fixture?.floorId ?? null,
      floorName: registration.fixture?.floor.name ?? null
    }
    : null;
  return {
    ...publicNode,
    identifyOperationId: latest?.id ?? null,
    identifyOperationStartedAt: latest?.createdAt ?? null,
    registrationEligibility,
    existingRegistration
  } as unknown as RegistrationNodeResponse;
}
