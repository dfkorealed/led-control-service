import { Injectable, NotFoundException } from "@nestjs/common";
import { isGatewayHeartbeatFresh } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { fixtureStatusWithHealth, toFixtureHealthSnapshot } from "../fixtures/fixture-health";

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
    const capabilities = await this.siteAccess.capabilities(user, siteId);
    const dashboard = await this.getDashboardById(siteId, includeFixtures);
    return { ...dashboard, capabilities };
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
        organization: { select: { name: true } },
        groups: {
          where: { lifecycleStatus: "active" },
          include: { groupFixtures: true },
          orderBy: { name: "asc" }
        },
        gateways: {
          orderBy: { name: "asc" },
          include: {
            meshControlGroups: {
              select: {
                targetType: true,
                targetId: true,
                status: true,
                configurationVersion: true,
                lastError: true
              }
            }
          }
        }
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
    const resolvedFixtureStatuses = fixtures.map((fixture) => fixtureStatusWithHealth(
      fixture.status,
      toFixtureHealthSnapshot(fixture.healthFaultCodes, fixture.healthLastSeenAt)
    ));
    const summary = includeFixtures
      ? {
          totalFixtures: fixtures.length,
          onlineFixtures: resolvedFixtureStatuses.filter((status) => status === "online").length,
          faultFixtures: resolvedFixtureStatuses.filter((status) => status === "fault").length,
          averageBrightness: fixtures.length
            ? Math.round(fixtures.reduce((sum, fixture) => sum + fixture.brightness, 0) / fixtures.length)
            : 0
        }
      : await this.getFixtureSummary(site.id);

    return {
      site: {
        id: site.id,
        name: site.name,
        customerName: site.organization.name,
        installationStatus: site.address !== null && site.tariffKwhRate !== null && site.floors.length > 0 ? "installed" : "pending",
        address: site.address,
        tariffKwhRate: site.tariffKwhRate === null ? null : Number(site.tariffKwhRate),
        timeZone: site.timeZone
      },
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
        meshControlGroups: site.gateways.flatMap((gateway) => (gateway.meshControlGroups ?? [])
          .filter((group) => group.targetType === "floor" && group.targetId === floor.id)
          .map((group) => ({
            gatewayId: gateway.id,
            status: group.status,
            version: group.configurationVersion,
            error: group.lastError
          }))),
        fixtures: (fixturesByFloor.get(floor.id) ?? []).map((fixture) => {
          const gatewayOnline = isGatewayHeartbeatFresh(fixture.meshNode?.gateway.lastHeartbeatAt, now);
          const health = toFixtureHealthSnapshot(fixture.healthFaultCodes, fixture.healthLastSeenAt);
          const status = fixtureStatusWithHealth(fixture.status, health);
          const controlBlockReason = !fixture.meshNode
            ? "fixture_unmapped"
            : !gatewayOnline
              ? "gateway_offline"
              : status === "fault"
                ? "fixture_fault"
                : status === "offline"
                  ? "fixture_offline"
                  : null;
          return {
          id: fixture.id,
          name: fixture.name,
          x: fixture.x,
          y: fixture.y,
          size: fixture.size,
          placementStatus: fixture.placementStatus,
          positionVerifiedAt: fixture.positionVerifiedAt?.toISOString() ?? null,
          ratedWatt: Number(fixture.ratedWatt),
          brightness: fixture.brightness,
          status,
          statusReason: fixture.statusReason,
          health,
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
          vehicleSensorCapabilityStatus: fixture.meshNode?.vehicleSensorCapabilityStatus ?? "unknown",
          vehicleSensorCapabilityVerifiedAt: fixture.meshNode?.vehicleSensorCapabilityVerifiedAt?.toISOString() ?? null,
          controllable: controlBlockReason === null,
          controlBlockReason
          };
        })
      })),
      groups: site.groups.filter((group) => group.lifecycleStatus === "active").map((group) => ({
        id: group.id,
        name: group.name,
        floorId: group.floorId,
        gatewayId: group.gatewayId,
        lifecycleStatus: group.lifecycleStatus,
        fixtureCount: group.groupFixtures.length,
        fixtureIds: group.groupFixtures.map((item) => item.fixtureId),
        meshControlGroup: group.gatewayId
          ? (() => {
              const meshGroup = site.gateways
                .find((gateway) => gateway.id === group.gatewayId)
                ?.meshControlGroups?.find((candidate) =>
                  candidate.targetType === "fixture_group" && candidate.targetId === group.id
                );
              return meshGroup
                ? {
                    status: meshGroup.status,
                    version: meshGroup.configurationVersion,
                    error: meshGroup.lastError
                  }
                : null;
            })()
          : null
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
    const fixtures = await this.prisma.fixture.findMany({
      where: { floor: { siteId } },
      select: {
        status: true,
        brightness: true,
        healthFaultCodes: true,
        healthLastSeenAt: true
      }
    });
    const statuses = fixtures.map((fixture) => fixtureStatusWithHealth(
      fixture.status,
      toFixtureHealthSnapshot(fixture.healthFaultCodes, fixture.healthLastSeenAt)
    ));
    return {
      totalFixtures: fixtures.length,
      onlineFixtures: statuses.filter((status) => status === "online").length,
      faultFixtures: statuses.filter((status) => status === "fault").length,
      averageBrightness: fixtures.length
        ? Math.round(fixtures.reduce((sum, fixture) => sum + fixture.brightness, 0) / fixtures.length)
        : 0
    };
  }
}

function emptyDashboard() {
  return {
    site: {
      id: "",
      name: "현장 미등록",
      customerName: "",
      installationStatus: "pending" as const,
      address: null,
      tariffKwhRate: null,
      timeZone: "Asia/Seoul"
    },
    summary: {
      totalFixtures: 0,
      onlineFixtures: 0,
      faultFixtures: 0,
      averageBrightness: 0
    },
    capabilities: { read: false, control: false, manage: false, commission: false },
    floors: [],
    groups: [],
    gateways: []
  };
}
