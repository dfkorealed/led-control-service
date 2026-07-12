import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async getDefaultDashboard(organizationId: string, includeFixtures = true) {
    const site = await this.prisma.site.findFirst({
      where: { organizationId },
      include: {
        floors: {
          orderBy: { level: "asc" },
          include: {
            floorPlan: true
          }
        },
        groups: {
          include: { groupFixtures: true },
          orderBy: { name: "asc" }
        },
        gateways: { orderBy: { name: "asc" } }
      }
    });

    if (!site) {
      return {
        site: { id: "", name: "현장 미등록" },
        summary: {
          totalFixtures: 0,
          onlineFixtures: 0,
          faultFixtures: 0,
          averageBrightness: 0
        },
        floors: [],
        groups: [],
        gateways: []
      };
    }

    const fixtures = includeFixtures
      ? await this.prisma.fixture.findMany({
          where: { floor: { siteId: site.id } },
          orderBy: { name: "asc" },
          include: { meshNode: { include: { gateway: true } } }
        })
      : [];
    const fixturesByFloor = new Map(site.floors.map((floor) => [floor.id, fixtures.filter((fixture) => fixture.floorId === floor.id)]));
    const now = Date.now();
    const summary = includeFixtures
      ? {
          totalFixtures: fixtures.length,
          onlineFixtures: fixtures.filter((fixture) => fixture.status === "online").length,
          faultFixtures: fixtures.filter((fixture) => fixture.status === "fault").length,
          averageBrightness: fixtures.length
            ? Math.round(fixtures.reduce((sum, fixture) => sum + fixture.brightness, 0) / fixtures.length)
            : 0
        }
      : await this.getFixtureSummary(site.id);

    return {
      site: { id: site.id, name: site.name },
      summary,
      floors: site.floors.map((floor) => ({
        id: floor.id,
        name: floor.name,
        level: floor.level,
        floorPlan: floor.floorPlan
          ? {
              imageUrl: floor.floorPlan.imageUrl,
              sourceType: floor.floorPlan.sourceType,
              originalFileUrl: floor.floorPlan.originalFileUrl,
              renderedImageUrl: floor.floorPlan.renderedImageUrl,
              width: floor.floorPlan.width,
              height: floor.floorPlan.height,
              version: floor.floorPlan.version
            }
          : null,
        fixtures: (fixturesByFloor.get(floor.id) ?? []).map((fixture) => {
          const gatewayOnline = Boolean(
            fixture.meshNode?.gateway.lastHeartbeatAt &&
              now - fixture.meshNode.gateway.lastHeartbeatAt.getTime() < 90_000
          );
          const controlBlockReason = !fixture.meshNode
            ? "fixture_unmapped"
            : !gatewayOnline
              ? "gateway_offline"
              : fixture.status === "fault"
                ? "fixture_fault"
                : fixture.status === "offline"
                  ? "fixture_offline"
                  : null;
          return {
          id: fixture.id,
          name: fixture.name,
          x: fixture.x,
          y: fixture.y,
          ratedWatt: Number(fixture.ratedWatt),
          brightness: fixture.brightness,
          status: fixture.status,
          statusReason: fixture.statusReason,
          rssi: fixture.rssi,
          hopCount: fixture.hopCount,
          commandSuccessRate: fixture.commandSuccessRate,
          lastSeenAt: fixture.lastSeenAt?.toISOString() ?? null,
          gateway: fixture.meshNode
            ? {
                id: fixture.meshNode.gateway.id,
                name: fixture.meshNode.gateway.name,
                connectionStatus: gatewayOnline ? "online" : "offline"
              }
            : null,
          controllable: controlBlockReason === null,
          controlBlockReason
          };
        })
      })),
      groups: site.groups.map((group) => ({
        id: group.id,
        name: group.name,
        fixtureIds: group.groupFixtures.map((item) => item.fixtureId)
      })),
      gateways: site.gateways.map((gateway) => ({
        id: gateway.id,
        name: gateway.name,
        serialNumber: gateway.serialNumber,
        firmwareVersion: gateway.firmwareVersion,
        lastHeartbeatAt: gateway.lastHeartbeatAt?.toISOString() ?? null,
        connectionStatus:
          gateway.lastHeartbeatAt && now - gateway.lastHeartbeatAt.getTime() < 90_000 ? "online" : "offline"
      }))
    };
  }

  private async getFixtureSummary(siteId: string) {
    const [totalFixtures, onlineFixtures, faultFixtures, brightness] = await Promise.all([
      this.prisma.fixture.count({ where: { floor: { siteId } } }),
      this.prisma.fixture.count({ where: { floor: { siteId }, status: "online" } }),
      this.prisma.fixture.count({ where: { floor: { siteId }, status: "fault" } }),
      this.prisma.fixture.aggregate({ where: { floor: { siteId } }, _avg: { brightness: true } })
    ]);
    return {
      totalFixtures,
      onlineFixtures,
      faultFixtures,
      averageBrightness: Math.round(brightness._avg.brightness ?? 0)
    };
  }
}
