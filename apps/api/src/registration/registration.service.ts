import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";

interface CreateSessionInput {
  siteId: string;
  floorId: string;
  requestedBy: string;
  organizationId: string;
}

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
    private readonly mqttService: MqttService
  ) {}

  async createSession(input: CreateSessionInput) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: input.floorId, siteId: input.siteId, site: { organizationId: input.organizationId } }
    });
    if (!floor) throw new BadRequestException("floorId must reference a floor in the selected site");

    const gateway = await this.prisma.gateway.findFirst({
      where: { siteId: input.siteId, site: { organizationId: input.organizationId } },
      orderBy: { createdAt: "asc" }
    });
    if (!gateway) throw new BadRequestException("site must have a gateway before registration can start");

    const session = await this.prisma.provisioningSession.create({
      data: {
        siteId: input.siteId,
        floorId: input.floorId,
        gatewayId: gateway.id,
        requestedBy: input.requestedBy,
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

  async getSession(sessionId: string, organizationId: string) {
    const session = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      include: { site: true, discoveredNodes: { orderBy: { discoveredAt: "asc" } } }
    });
    if (!session || session.site.organizationId !== organizationId) {
      throw new NotFoundException("registration session not found");
    }
    return session;
  }

  async identifyNode(sessionId: string, nodeId: string, organizationId: string) {
    const node = await this.findSessionNode(sessionId, nodeId, organizationId);
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

  async registerNode(sessionId: string, nodeId: string, input: RegisterNodeInput, organizationId: string) {
    if (!input.fixtureName.trim()) throw new BadRequestException("fixtureName is required");
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      throw new BadRequestException("x and y must be valid floor plan coordinates");
    }

    const node = await this.findSessionNode(sessionId, nodeId, organizationId);
    this.assertActiveSession(node.session.status);

    const meshAddress = node.meshAddress ?? (await this.nextMeshAddress(node.session.gatewayId));

    return this.prisma.$transaction(async (tx) => {
      const meshNode = await tx.meshNode.create({
        data: {
          gatewayId: node.session.gatewayId,
          deviceUuid: node.deviceUuid,
          serialNumber: node.serialNumber,
          meshAddress,
          firmwareVersion: node.firmwareVersion
        }
      });

      const fixture = await tx.fixture.create({
        data: {
          floorId: node.session.floorId,
          meshNodeId: meshNode.id,
          name: input.fixtureName.trim(),
          ratedWatt: input.ratedWatt ?? "40.00",
          x: input.x,
          y: input.y,
          status: "online",
          brightness: 60,
          lastSeenAt: new Date()
        }
      });

      const discoveredNode = await tx.discoveredMeshNode.update({
        where: { id: nodeId },
        data: { status: "provisioned", identifyState: "confirmed", meshAddress }
      });

      return { meshNode, fixture, discoveredNode };
    });
  }

  async completeSession(sessionId: string, organizationId: string) {
    const session = await this.prisma.provisioningSession.findUnique({
      where: { id: sessionId },
      include: { site: true }
    });
    if (!session || session.site.organizationId !== organizationId) {
      throw new NotFoundException("registration session not found");
    }
    this.assertActiveSession(session.status);

    return this.prisma.provisioningSession.update({
      where: { id: sessionId },
      data: { status: "completed", completedAt: new Date() },
      include: { discoveredNodes: true }
    });
  }

  private async findSessionNode(sessionId: string, nodeId: string, organizationId: string) {
    const node = await this.prisma.discoveredMeshNode.findUnique({
      where: { id: nodeId },
      include: { session: { include: { site: true } } }
    });
    if (!node || node.sessionId !== sessionId || node.session.site.organizationId !== organizationId) {
      throw new NotFoundException("discovered node not found");
    }
    return node;
  }

  private assertActiveSession(status: string) {
    if (status !== "active") throw new BadRequestException("registration session is not active");
  }

  private async nextMeshAddress(gatewayId: string) {
    const count = await this.prisma.meshNode.count({ where: { gatewayId } });
    return `0x${(count + 1).toString(16).padStart(4, "0")}`;
  }
}
