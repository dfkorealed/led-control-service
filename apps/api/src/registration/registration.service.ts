import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
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
      return await this.prisma.$transaction(async (tx) => {
        await this.siteAccess.assertCommissionInTransaction(tx, user, input.siteId);
        const floor = await tx.floor.findFirst({
          where: { id: input.floorId, siteId: input.siteId }
        });
        if (!floor) throw new BadRequestException("floorId must reference a floor in the selected site");

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
          include: { discoveredNodes: true }
        });
        await tx.provisioningScanOutbox.create({
          data: this.createScanOutboxData(session, scanCorrelationId, 1)
        });
        return session;
      });
    } catch (error) {
      if (this.isGatewayScanConflict(error)) throw new ConflictException({ code: "gateway_scan_in_progress" });
      throw error;
    }
  }

  async getSession(user: AuthenticatedUser, sessionId: string) {
    const session = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      include: { site: true, discoveredNodes: { orderBy: { discoveredAt: "asc" } } }
    });
    if (!session) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, session.siteId);
    return session;
  }

  async listActiveSessions(user: AuthenticatedUser, siteId: string) {
    await this.assertCommissionAccess(user, siteId);
    return this.prisma.provisioningSession.findMany({
      where: { siteId, status: "active" },
      orderBy: { startedAt: "desc" },
      include: { discoveredNodes: { orderBy: { discoveredAt: "asc" } } }
    });
  }

  async identifyNode(user: AuthenticatedUser, sessionId: string, nodeId: string) {
    const session = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true }
    });
    if (!session) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, session.siteId);
    void nodeId;
    throw new HttpException({ code: "pre_provision_identify_unsupported" }, HttpStatus.NOT_IMPLEMENTED);
  }

  async retryScan(user: AuthenticatedUser, sessionId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true, gatewayId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
        await this.lockGateway(tx, accessSession.gatewayId);
        await tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${sessionId} FOR UPDATE`;
        const current = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
        if (!current) throw new NotFoundException("registration session not found");
        this.assertActiveSession(current.status);
        if (current.scanStatus !== "completed" && current.scanStatus !== "failed") {
          throw new ConflictException({ code: "scan_retry_requires_terminal_scan" });
        }
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
        return session;
      });
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

    const discoveredNode = await this.prisma.discoveredMeshNode.findUnique({ where: { id: nodeId } });
    if (!discoveredNode) throw new NotFoundException("discovered node not found");
    return { fixture: null, discoveredNode };
  }

  async registerBatch(user: AuthenticatedUser, sessionId: string, input: RegisterFixtureBatchInput) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true, gatewayId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    // 등록 요청은 주소 예약, node 준비 상태, durable outbox를 함께 commit해 같은 주소가 두 등록에 배정되는 실패를 막는다.
    // accepted는 이 DB commit만 뜻하며 MQTT PUBACK, 물리 provisioning, Fixture 확정을 뜻하지 않는다.
    const prepared = await this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await this.lockGateway(tx, accessSession.gatewayId);
      await tx.$queryRaw`
        SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${sessionId} FOR UPDATE
      `;
      const session = await tx.provisioningSession.findUnique({
        where: { id: sessionId },
        include: { floor: { include: { floorPlan: true } } }
      });
      if (!session) throw new NotFoundException("registration session not found");
      this.assertActiveSession(session.status);
      if (session.scanStatus !== "completed") {
        throw new ConflictException({ code: "registration_scan_not_completed" });
      }
      await this.meshControlGroups.ensureFloorGroup(tx, session.gatewayId, session.floorId);

      const nodeIds = input.nodes.map((node) => node.nodeId).sort();
      await tx.$queryRaw`
        SELECT "id" FROM "DiscoveredMeshNode"
        WHERE "sessionId" = ${sessionId} AND "id" IN (${Prisma.join(nodeIds)})
        ORDER BY "id" FOR UPDATE
      `;
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
        if (node.status !== "discovered" && node.status !== "identifying") {
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

      // Legacy placement input remains accepted but is intentionally ignored. Numeric zeroes
      // satisfy the provisioning contract only; the new Fixture default is unplaced, not (0,0).
      const positioned = candidates.map((candidate) => ({ ...candidate, x: 0, y: 0 }));

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
    });

    return { items: prepared.items };
  }

  async excludeNode(user: AuthenticatedUser, sessionId: string, nodeId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${sessionId} FOR UPDATE`;
      const session = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
      if (!session || session.siteId !== accessSession.siteId) {
        throw new NotFoundException("registration session not found");
      }
      this.assertActiveSession(session.status);

      await tx.$queryRaw`
        SELECT "id" FROM "DiscoveredMeshNode"
        WHERE "id" = ${nodeId} AND "sessionId" = ${sessionId}
        FOR UPDATE
      `;
      const node = await tx.discoveredMeshNode.findFirst({ where: { id: nodeId, sessionId } });
      if (!node) throw new NotFoundException("discovered node not found");
      if (node.status !== "reconcile_required") {
        throw new ConflictException({ code: "node_exclusion_requires_reconciliation" });
      }

      const excludedMessage = "현재 세션에서 제외됨";
      const errorMessage = node.errorMessage
        ? `${node.errorMessage}; ${excludedMessage}`
        : excludedMessage;
      return tx.discoveredMeshNode.update({
        where: { id: nodeId },
        data: { status: "failed", errorMessage }
      });
    });
  }

  async completeSession(user: AuthenticatedUser, sessionId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({ where: { id: sessionId }, select: { siteId: true } });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);
    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${sessionId} FOR UPDATE`;
      const session = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new NotFoundException("registration session not found");
      this.assertActiveSession(session.status);
      if (session.scanStatus !== "completed" && session.scanStatus !== "failed") {
        throw new ConflictException({ code: "scan_session_not_terminal" });
      }
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
      return tx.provisioningSession.update({
        where: { id: sessionId },
        data: { status: "completed", completedAt: new Date() },
        include: { discoveredNodes: true }
      });
    });
  }

  async cancelSession(user: AuthenticatedUser, sessionId: string) {
    const accessSession = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      select: { siteId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertCommissionInTransaction(tx, user, accessSession.siteId);
      await tx.$queryRaw`SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${sessionId} FOR UPDATE`;
      const session = await tx.provisioningSession.findUnique({ where: { id: sessionId } });
      if (!session || session.siteId !== accessSession.siteId) {
        throw new NotFoundException("registration session not found");
      }
      this.assertActiveSession(session.status);
      if (session.scanStatus !== "completed" && session.scanStatus !== "failed") {
        throw new ConflictException({ code: "scan_session_not_terminal" });
      }

      const blockingNodeCount = await tx.discoveredMeshNode.count({
        where: {
          sessionId,
          status: { in: ["provisioning", "reconcile_required", "provisioned"] }
        }
      });
      if (blockingNodeCount > 0) {
        throw new ConflictException({ code: "registration_session_not_empty" });
      }

      return tx.provisioningSession.update({
        where: { id: sessionId },
        data: { status: "cancelled", completedAt: new Date() },
        include: { discoveredNodes: true }
      });
    });
  }

  private assertActiveSession(status: string) {
    if (status !== "active") throw new BadRequestException("registration session is not active");
  }

  private async lockGateway(tx: Prisma.TransactionClient, gatewayId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Gateway" WHERE "id" = ${gatewayId} FOR UPDATE`;
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
