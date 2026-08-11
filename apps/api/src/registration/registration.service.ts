import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { CreateRegistrationSessionInput, gatewayHeartbeatFreshSince } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";

interface RegisterNodeInput {
  fixtureName: string;
  x: number;
  y: number;
  ratedWatt?: string;
}

@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService,
    private readonly siteAccess: SiteAccessService
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
        status: "active"
      },
      include: { discoveredNodes: true }
    });

    await this.mqttService.publishProvisioningScanStart({
      sessionId: session.id,
      siteId: session.siteId,
      gatewayId: session.gatewayId,
      floorId: session.floorId,
      requestedBy: session.requestedBy,
      requestedAt: session.startedAt.toISOString()
    });

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

    const node = await this.findSessionNode(user, sessionId, nodeId);
    this.assertActiveSession(node.session.status);

    const meshAddress = node.meshAddress ?? (await this.nextMeshAddress(node.session.gatewayId));

    const discoveredNode = await this.prisma.discoveredMeshNode.update({
      where: { id: nodeId },
      data: {
        status: "provisioning",
        meshAddress,
        pendingFixtureName: input.fixtureName.trim(),
        pendingFixtureX: input.x,
        pendingFixtureY: input.y,
        pendingRatedWatt: input.ratedWatt ?? "40.00",
        errorMessage: null
      }
    });

    await this.mqttService.publishProvisionDevice({
      sessionId,
      siteId: node.session.siteId,
      gatewayId: node.session.gatewayId,
      nodeId,
      deviceUuid: node.deviceUuid,
      meshAddress,
      requestedAt: new Date().toISOString()
    });

    return { fixture: null, discoveredNode };
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

  private async nextMeshAddress(gatewayId: string) {
    const count = await this.prisma.meshNode.count({ where: { gatewayId } });
    return `0x${(count + 1).toString(16).padStart(4, "0")}`;
  }

  private async assertCommissionAccess(user: AuthenticatedUser, siteId: string) {
    if (user.role !== "operator") throw new ForbiddenException("registration requires operator role");
    await this.siteAccess.assert(user, siteId, "commission");
  }
}
