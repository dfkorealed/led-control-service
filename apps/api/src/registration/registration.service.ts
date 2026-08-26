import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  CreateRegistrationSessionInput,
  gatewayHeartbeatFreshSince,
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

interface OccupiedPlacement {
  x: number;
  y: number;
  size: number;
}

class PlacementIndex {
  private readonly bucketSize = 32;
  private readonly buckets = new Map<string, Set<OccupiedPlacement>>();

  constructor(placements: OccupiedPlacement[]) {
    placements.forEach((placement) => this.add(placement));
  }

  add(placement: OccupiedPlacement) {
    for (const key of this.keysFor(placement)) {
      const bucket = this.buckets.get(key) ?? new Set<OccupiedPlacement>();
      bucket.add(placement);
      this.buckets.set(key, bucket);
    }
  }

  overlaps(candidate: OccupiedPlacement) {
    const nearby = new Set<OccupiedPlacement>();
    for (const key of this.keysFor(candidate)) {
      this.buckets.get(key)?.forEach((placement) => nearby.add(placement));
    }
    return Array.from(nearby).some((placement) =>
      Math.abs(placement.x - candidate.x) < (placement.size + candidate.size) / 2 + 4
      && Math.abs(placement.y - candidate.y) < (placement.size + candidate.size) / 2 + 4
    );
  }

  private keysFor(placement: OccupiedPlacement) {
    const radius = placement.size / 2 + 4;
    const minX = Math.floor((placement.x - radius) / this.bucketSize);
    const maxX = Math.floor((placement.x + radius) / this.bucketSize);
    const minY = Math.floor((placement.y - radius) / this.bucketSize);
    const maxY = Math.floor((placement.y + radius) / this.bucketSize);
    const keys: string[] = [];
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) keys.push(`${x}:${y}`);
    }
    return keys;
  }
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
    const floor = await this.prisma.floor.findFirst({
      where: { id: input.floorId, siteId: input.siteId }
    });
    if (!floor) throw new BadRequestException("floorId must reference a floor in the selected site");

    const gateway = await this.prisma.gateway.findFirst({
      where: {
        id: input.gatewayId,
        siteId: input.siteId,
        lastHeartbeatAt: { gte: gatewayHeartbeatFreshSince(new Date()) }
      }
    });
    if (!gateway) throw new BadRequestException("gatewayId must reference an online gateway in the selected site");

    const session = await this.prisma.provisioningSession.create({
      data: {
        siteId: input.siteId,
        floorId: input.floorId,
        gatewayId: gateway.id,
        requestedBy: user.id,
        status: "active",
        scanStatus: "scanning",
        scanCorrelationId: randomUUID(),
        scanAttempt: 1,
        scanStartedAt: new Date()
      },
      include: { discoveredNodes: true }
    });

    try {
      await this.mqttService.publishProvisioningScanStart({
        sessionId: session.id,
        siteId: session.siteId,
        gatewayId: session.gatewayId,
        floorId: session.floorId,
        scanCorrelationId: session.scanCorrelationId!,
        scanAttempt: session.scanAttempt,
        requestedAt: session.startedAt.toISOString()
      });
    } catch (error) {
      await this.prisma.provisioningSession.updateMany({
        where: { id: session.id, status: "active", scanStatus: "scanning" },
        data: {
          scanStatus: "failed",
          scanCompletedAt: new Date(),
          scanFailureCode: "scan_start_publish_failed",
          scanFailureMessage: "조명 검색 명령을 전송하지 못했습니다. 다시 시도해 주세요."
        }
      });
      throw error;
    }

    return session;
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

  async identifyNode(user: AuthenticatedUser, sessionId: string, nodeId: string) {
    const node = await this.findSessionNode(user, sessionId, nodeId);
    this.assertActiveSession(node.session.status);

    const updated = await this.prisma.discoveredMeshNode.update({
      where: { id: nodeId },
      data: { status: "identifying", identifyState: "blinking" }
    });

    await this.mqttService.publishIdentifyDevice({
      sessionId,
      siteId: node.session.siteId,
      gatewayId: node.session.gatewayId,
      nodeId,
      deviceUuid: node.deviceUuid,
      requestedAt: new Date().toISOString()
    });

    return updated;
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
      select: { siteId: true }
    });
    if (!accessSession) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, accessSession.siteId);

    const prepared = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "ProvisioningSession" WHERE "id" = ${sessionId} FOR UPDATE
      `;
      const session = await tx.provisioningSession.findUnique({
        where: { id: sessionId },
        include: { floor: { include: { floorPlan: true } } }
      });
      if (!session) throw new NotFoundException("registration session not found");
      this.assertActiveSession(session.status);
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
        placement: { mode: "auto" } | { mode: "manual"; x: number; y: number };
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
        const individual = input.mode === "individual"
          ? input.nodes.find((item) => item.nodeId === requested.nodeId)
          : undefined;
        candidates.push({
          nodeId: node.id,
          deviceUuid: node.deviceUuid,
          meshAddress: node.meshAddress,
          fixtureName: individual?.fixtureName ?? "",
          ratedWatt: individual?.ratedWatt ?? (input.mode === "batch" ? input.defaults.ratedWatt : "40.00"),
          size: individual?.size ?? (input.mode === "batch" ? input.defaults.size : 20),
          placement: requested.placement
        });
      }

      const width = session.floor.floorPlan?.width ?? 1200;
      const height = session.floor.floorPlan?.height ?? 800;
      const occupied: OccupiedPlacement[] = await tx.fixture.findMany({
        where: { floorId: session.floorId },
        select: { x: true, y: true, size: true }
      });
      const placementIndex = new PlacementIndex(occupied);
      const positioned = candidates.flatMap((candidate) => {
        const position = candidate.placement.mode === "manual"
          ? this.validateManualPlacement(candidate.placement, candidate.size, width, height)
          : this.findAutoPlacement(width, height, candidate.size, placementIndex);
        if (!position) {
          failures.set(candidate.nodeId, "no valid placement is available on the floor plan");
          return [];
        }
        placementIndex.add({ ...position, size: candidate.size });
        return [{ ...candidate, ...position }];
      });

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
        registrations.push(registration);
      }
      const registrationsByNodeId = new Map(registrations.map((registration) => [registration.nodeId, registration]));

      return {
        siteId: session.siteId,
        gatewayId: session.gatewayId,
        registrations,
        items: input.nodes.map((node) => failures.has(node.nodeId)
          ? { nodeId: node.nodeId, status: "validation_failed" as const, error: failures.get(node.nodeId)! }
          : {
            nodeId: node.nodeId,
            status: "accepted" as const,
            fixtureName: registrationsByNodeId.get(node.nodeId)!.fixtureName
          })
      };
    });

    for (const registration of prepared.registrations) {
      try {
        await this.mqttService.publishProvisionDevice({
          sessionId,
          siteId: prepared.siteId,
          gatewayId: prepared.gatewayId,
          nodeId: registration.nodeId,
          deviceUuid: registration.deviceUuid,
          meshAddress: registration.meshAddress,
          requestedAt: new Date().toISOString()
        });
      } catch (error) {
        await this.prisma.discoveredMeshNode.updateMany({
          where: { id: registration.nodeId, sessionId, status: "provisioning" },
          data: {
            status: "reconcile_required",
            errorMessage: error instanceof Error ? error.message : "provisioning publish outcome is unknown"
          }
        });
      }
    }

    return { items: prepared.items };
  }

  async completeSession(user: AuthenticatedUser, sessionId: string) {
    const session = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      include: { site: true }
    });
    if (!session) throw new NotFoundException("registration session not found");
    await this.assertCommissionAccess(user, session.siteId);
    this.assertActiveSession(session.status);

    return this.prisma.provisioningSession.update({
      where: { id: sessionId },
      data: { status: "completed", completedAt: new Date() },
      include: { discoveredNodes: true }
    });
  }

  private async findSessionNode(user: AuthenticatedUser, sessionId: string, nodeId: string) {
    const node = await this.prisma.discoveredMeshNode.findUnique({
      where: { id: nodeId },
      include: { session: { include: { site: true } } }
    });
    if (!node || node.sessionId !== sessionId) throw new NotFoundException("discovered node not found");
    await this.assertCommissionAccess(user, node.session.siteId);
    return node;
  }

  private assertActiveSession(status: string) {
    if (status !== "active") throw new BadRequestException("registration session is not active");
  }

  private validateManualPlacement(
    placement: { x: number; y: number },
    size: number,
    width: number,
    height: number
  ) {
    const half = size / 2;
    if (placement.x < half || placement.x > width - half || placement.y < half || placement.y > height - half) {
      return null;
    }
    return { x: placement.x, y: placement.y };
  }

  private findAutoPlacement(width: number, height: number, size: number, placementIndex: PlacementIndex) {
    if (size > width || size > height) return null;
    const half = size / 2;
    const step = Math.max(24, Math.ceil(size + 4));
    for (let y = half; y <= height - half; y += step) {
      for (let x = half; x <= width - half; x += step) {
        if (!placementIndex.overlaps({ x, y, size })) return { x, y };
      }
    }
    return null;
  }

  private async assertCommissionAccess(user: AuthenticatedUser, siteId: string) {
    if (user.role !== "operator") throw new ForbiddenException("registration requires operator role");
    await this.siteAccess.assert(user, siteId, "commission");
  }
}
