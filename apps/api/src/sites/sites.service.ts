import { Injectable, NotFoundException } from "@nestjs/common";
import { isGatewayHeartbeatFresh } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async listSites(user: AuthenticatedUser) {
    const siteIds = await this.siteAccess.listAccessibleSiteIds(user);
    if (siteIds.length === 0) return [];

    const sites = await this.prisma.site.findMany({
      where: { id: { in: siteIds } },
      select: { id: true, name: true, organization: { select: { name: true } } },
      orderBy: { name: "asc" }
    });
    return sites.map((site) => ({ id: site.id, customerName: site.organization.name, name: site.name }));
  }

  async getDefaultDashboard(user: AuthenticatedUser, includeFixtures = true) {
    const siteIds = await this.siteAccess.listAccessibleSiteIds(user);
    if (siteIds.length === 0) return emptyDashboard();
    return this.getDashboard(user, siteIds[0], includeFixtures);
  }

  async getDashboard(user: AuthenticatedUser, siteId: string, includeFixtures = true) {
    await this.siteAccess.assert(user, siteId, "read");
    return this.getDashboardById(siteId, includeFixtures);
  }

  // Setup reaches this only after its own transaction created or organization-validated the exact site.
  async getDashboardById(siteId: string, includeFixtures = true) {
    const site = await this.prisma.site.findFirst({
      where: { id: siteId },
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

    if (!site) throw new NotFoundException("site not found");

    const fixtures = includeFixtures
      ? await this.prisma.fixture.findMany({
          where: { floor: { siteId: site.id } },
          orderBy: { name: "asc" },
          include: { meshNode: { include: { gateway: true } } }
        })
      : [];
    const fixturesByFloor = new Map(site.floors.map((floor) => [floor.id, fixtures.filter((fixture) => fixture.floorId === floor.id)]));
    const now = new Date();
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
          const gatewayOnline = isGatewayHeartbeatFresh(fixture.meshNode?.gateway.lastHeartbeatAt, now);
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
          isGatewayHeartbeatFresh(gateway.lastHeartbeatAt, now) ? "online" : "offline"
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

function emptyDashboard() {
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
