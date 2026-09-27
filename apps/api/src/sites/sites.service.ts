import { Injectable, NotFoundException } from "@nestjs/common";
import { isGatewayHeartbeatFresh } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { fixtureStatusWithHealth, toFixtureHealthSnapshot } from "../fixtures/fixture-health";
import { DEFAULT_MONITORING_POLICY, isMonitoringGatewayOnline, monitoringFixtureState, type MonitoringPolicy } from "../monitoring-incidents/monitoring-conditions";

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
          where: { status: "active" },
          orderBy: { level: "asc" },
          include: {
            floorPlan: true,
            mapDocument: { select: { revision: true } },
            cadScene: { select: { status: true, primitiveCount: true } },
            mapObjects: { where: { visible: true }, take: 1, select: { id: true } }
          }
        },
        organization: { select: { name: true } },
        groups: {
          where: { lifecycleStatus: "active", floor: { is: { status: "active" } } },
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

    // Generation.elementCount is only the checkpoint base; ordinary saves update
    // the exact revision snapshot while leaving that base count unchanged.
    // Extract one scalar per active floor in the database so dashboard reads
    // never transfer full revision snapshots or issue a query per floor.
    const currentMapRows = site.floors.some((floor) => floor.mapDocument)
      ? await this.prisma.$queryRaw<Array<{
          floorId: string; mapRevision: number; revision: number; snapshotRevision: number | null;
          snapshotVersion: string | null; elementCount: number | null;
        }>>`
          SELECT document."floorId" AS "floorId", floor."mapRevision" AS "mapRevision",
            document."revision" AS "revision",
            (history."snapshot" #>> '{document,revision}')::integer AS "snapshotRevision",
            history."snapshot" ->> 'version' AS "snapshotVersion",
            (history."snapshot" #>> '{document,elementCount}')::integer AS "elementCount"
          FROM "FloorMapDocument" AS document
          JOIN "Floor" AS floor ON floor."id" = document."floorId"
          LEFT JOIN "FloorMapRevision" AS history ON history."floorId" = document."floorId"
            AND history."revision" = document."revision"
          WHERE floor."siteId" = ${site.id} AND floor."status" = 'active'
        `
      : [];
    const currentMapByFloor = new Map(currentMapRows.map((row) => [row.floorId, row]));
    const currentMapCounts = new Map<string, number>();
    for (const floor of site.floors) {
      if (!floor.mapDocument) continue;
      const row = currentMapByFloor.get(floor.id);
      if (!row || row.revision !== row.mapRevision ||
        row.snapshotRevision !== row.revision || row.snapshotVersion !== "3" ||
        row.elementCount === null || !Number.isSafeInteger(row.elementCount) || row.elementCount < 0) {
        throw new Error("map dashboard revision metadata mismatch");
      }
      currentMapCounts.set(floor.id, row.elementCount);
    }

    const fixtures = includeFixtures
      ? await this.prisma.fixture.findMany({
          where: { floor: { siteId: site.id, status: "active" } },
          orderBy: { name: "asc" },
          include: { meshNode: { include: { gateway: true } } }
        })
      : [];
    const fixturesByFloor = new Map(site.floors.map((floor) => [floor.id, fixtures.filter((fixture) => fixture.floorId === floor.id)]));
    const now = new Date();
    const monitoringPolicy = {
      gatewayOfflineAfterSeconds: site.gatewayOfflineAfterSeconds,
      fixtureStaleAfterSeconds: site.fixtureStaleAfterSeconds
    };
    const summaryFixtures = includeFixtures ? fixtures : await this.prisma.fixture.findMany({
      where: { floor: { siteId: site.id, status: "active" } },
      select: {
        floorId: true, brightness: true, reportedStatus: true, reportedStatusReason: true,
        lastSeenAt: true, lastUnreachableAt: true, healthFaultCodes: true, healthLastSeenAt: true,
        meshNode: { select: { gateway: { select: { lastHeartbeatAt: true } } } }
      }
    });
    const floorSummaries = new Map(site.floors.map((floor) => [floor.id, emptyFixtureCounts()]));
    let totalBrightness = 0;
    for (const fixture of summaryFixtures) {
      const floorSummary = floorSummaries.get(fixture.floorId);
      if (!floorSummary) continue;
      const status = monitoringFixtureState(fixture, fixture.meshNode?.gateway, monitoringPolicy, now).status;
      floorSummary.totalFixtures += 1;
      floorSummary[`${status}Fixtures`] += 1;
      totalBrightness += fixture.brightness;
    }
    const summary = [...floorSummaries.values()].reduce((sum, floor) => ({
      totalFixtures: sum.totalFixtures + floor.totalFixtures,
      onlineFixtures: sum.onlineFixtures + floor.onlineFixtures,
      faultFixtures: sum.faultFixtures + floor.faultFixtures,
      offlineFixtures: sum.offlineFixtures + floor.offlineFixtures
    }), emptyFixtureCounts());
    const siteSummary = { ...summary, averageBrightness: summary.totalFixtures
      ? Math.round(totalBrightness / summary.totalFixtures) : 0 };

    return {
      generatedAt: now.toISOString(),
      monitoringPolicy,
      site: {
        id: site.id,
        name: site.name,
        customerName: site.organization.name,
        installationStatus: site.address !== null && site.tariffKwhRate !== null && site.floors.length > 0 ? "installed" : "pending",
        address: site.address,
        tariffKwhRate: site.tariffKwhRate === null ? null : Number(site.tariffKwhRate),
        timeZone: site.timeZone
      },
      summary: siteSummary,
      floors: site.floors.map((floor) => ({
        id: floor.id,
        name: floor.name,
        level: floor.level,
        summary: floorSummaries.get(floor.id) ?? emptyFixtureCounts(),
        mapRevision: currentMapByFloor.get(floor.id)?.mapRevision ?? floor.mapRevision,
        // A revision alone may represent an initialized or reset empty document.
        // Snapshot elementCount has no visibility breakdown, so an all-hidden document
        // remains configured until a separate visible-count contract is available.
        mapConfigured: (currentMapCounts.get(floor.id) ?? 0) > 0
          || (floor.floorPlan != null && floor.floorPlan.sourceType !== "none")
          || (floor.cadScene?.status === "active" && floor.cadScene.primitiveCount > 0)
          || (floor.mapObjects?.length ?? 0) > 0,
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
          const gatewayOnline = isMonitoringGatewayOnline(fixture.meshNode?.gateway.lastHeartbeatAt, monitoringPolicy, now);
          // Monitoring policy controls display; command readiness retains the
          // fixed safety contract used by registration/identify/control APIs.
          const controlGatewayOnline = isGatewayHeartbeatFresh(fixture.meshNode?.gateway.lastHeartbeatAt, now);
          const health = toFixtureHealthSnapshot(fixture.healthFaultCodes, fixture.healthLastSeenAt);
          const controlStatus = fixtureStatusWithHealth(fixture.status, health);
          const { status, statusReason } = monitoringFixtureState(fixture, fixture.meshNode?.gateway, monitoringPolicy, now);
          const controlBlockReason = !fixture.meshNode
            ? "fixture_unmapped"
            : !controlGatewayOnline
              ? "gateway_offline"
              : controlStatus === "fault"
                ? "fixture_fault"
                : controlStatus === "offline"
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
          // BIO의 configuredBrightness는 센서 모드에서 설정된 목표값일 뿐 실제 LED 출력값이 아닙니다.
          // 실제 brightness는 fixture-state read-back만 반영하므로 presence 수신으로 바꾸지 않습니다.
          bioControlMode: fixture.bioControlMode,
          bioConfiguredBrightness: fixture.bioConfiguredBrightness,
          bioRawHighBrightness: fixture.bioRawHighBrightness,
          status,
          statusReason,
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
          isMonitoringGatewayOnline(gateway.lastHeartbeatAt, monitoringPolicy, now) ? "online" : "offline"
      }))
    };
  }

}

function emptyFixtureCounts() {
  return { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, offlineFixtures: 0 };
}

function emptyDashboard() {
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    monitoringPolicy: { ...DEFAULT_MONITORING_POLICY },
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
      offlineFixtures: 0,
      averageBrightness: 0
    },
    capabilities: { read: false, control: false, manage: false, commission: false },
    floors: [],
    groups: [],
    gateways: []
  };
}
