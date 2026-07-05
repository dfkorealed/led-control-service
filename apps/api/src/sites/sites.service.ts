import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async getDefaultDashboard(organizationId: string) {
    const site = await this.prisma.site.findFirst({
      where: { organizationId },
      include: {
        floors: {
          orderBy: { level: "asc" },
          include: {
            floorPlan: true,
            fixtures: { orderBy: { name: "asc" } }
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

    const fixtures = site.floors.flatMap((floor) => floor.fixtures);
    const now = Date.now();

    return {
      site: { id: site.id, name: site.name },
      summary: {
        totalFixtures: fixtures.length,
        onlineFixtures: fixtures.filter((fixture) => fixture.status === "online").length,
        faultFixtures: fixtures.filter((fixture) => fixture.status === "fault").length,
        averageBrightness: fixtures.length
          ? Math.round(fixtures.reduce((sum, fixture) => sum + fixture.brightness, 0) / fixtures.length)
          : 0
      },
      floors: site.floors.map((floor) => ({
        id: floor.id,
        name: floor.name,
        level: floor.level,
        floorPlan: floor.floorPlan
          ? {
              imageUrl: floor.floorPlan.imageUrl,
              width: floor.floorPlan.width,
              height: floor.floorPlan.height,
              version: floor.floorPlan.version
            }
          : null,
        fixtures: floor.fixtures.map((fixture) => ({
          id: fixture.id,
          name: fixture.name,
          x: fixture.x,
          y: fixture.y,
          ratedWatt: Number(fixture.ratedWatt),
          brightness: fixture.brightness,
          status: fixture.status,
          rssi: fixture.rssi,
          hopCount: fixture.hopCount,
          commandSuccessRate: fixture.commandSuccessRate,
          lastSeenAt: fixture.lastSeenAt?.toISOString() ?? null
        }))
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
          gateway.lastHeartbeatAt && now - gateway.lastHeartbeatAt.getTime() < 15_000 ? "online" : "offline"
      }))
    };
  }
}
