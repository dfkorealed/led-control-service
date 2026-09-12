import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type MonitoringIncident } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { encodeIncidentCursor, parseIncidentMutation, parseIncidentQuery, parseMonitoringPolicy } from "./monitoring-incidents.dto";
import { isMonitoringConditionActive } from "./monitoring-conditions";

const policySelect = { id: true, gatewayOfflineAfterSeconds: true, fixtureStaleAfterSeconds: true, updatedAt: true } satisfies Prisma.SiteSelect;
const actorSelect = { id: true, name: true, loginId: true } satisfies Prisma.UserSelect;
const incidentInclude = {
  fixture: { select: { id: true, name: true, floorId: true } },
  gateway: { select: { id: true, name: true } },
  acknowledgedBy: { select: actorSelect }, assignedTo: { select: actorSelect }, resolvedBy: { select: actorSelect }
} satisfies Prisma.MonitoringIncidentInclude;
type IncidentRow = Prisma.MonitoringIncidentGetPayload<{ include: typeof incidentInclude }>;
type IncidentTarget = Pick<MonitoringIncident, "type" | "fixtureId" | "gatewayId">;

@Injectable()
export class MonitoringIncidentsService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService, private readonly audit: AuditService) {}
  async getPolicy(user: AuthenticatedUser, siteId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.access.assertReadInTransaction(tx, user, siteId);
      return this.policy(tx, siteId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async updatePolicy(user: AuthenticatedUser, siteId: string, input: unknown) {
    const { expectedUpdatedAt, ...data } = parseMonitoringPolicy(input);
    await this.access.assert(user, siteId, "manage");
    return this.prisma.$transaction(async (tx) => {
      const site = await this.access.assertManageInTransaction(tx, user, siteId);
      const current = await this.policy(tx, siteId);
      this.assertRevision(current.updatedAt, expectedUpdatedAt, "MONITORING_POLICY_CONFLICT");
      const saved = await tx.site.update({ where: { id: siteId }, data: { ...data, updatedAt: this.nextUpdatedAt(current.updatedAt) }, select: policySelect });
      await this.audit.record({ transaction: tx, organizationId: site.organizationId, siteId, actorId: user.id,
        action: "monitoring_policy.updated", targetType: "Site", targetId: siteId, outcome: "success", metadata: data });
      return saved;
    });
  }

  async list(user: AuthenticatedUser, siteId: string, input: unknown) {
    const query = parseIncidentQuery(input, siteId);
    return this.prisma.$transaction(async (tx) => {
      await this.access.assertReadInTransaction(tx, user, siteId);
      // A tuple cursor keeps active incidents together while ordering both active
      // statuses by openedAt; enum sorting would incorrectly put every open first.
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "MonitoringIncident" WHERE "siteId" = ${siteId}
        ${query.status === "all" ? Prisma.empty : Prisma.sql`AND "status" = ${query.status}::"MonitoringIncidentStatus"`}
        ${query.type ? Prisma.sql`AND "type" = ${query.type}::"MonitoringIncidentType"` : Prisma.empty}
        ${query.cursor ? Prisma.sql`AND ("resolvedAt" IS NULL, "openedAt", "id") < (${query.cursor.active}, ${query.cursor.openedAt}, ${query.cursor.id})` : Prisma.empty}
        ORDER BY ("resolvedAt" IS NULL) DESC, "openedAt" DESC, "id" DESC LIMIT ${query.limit + 1}
      `);
      const pageIds = rows.slice(0, query.limit).map((row) => row.id);
      const incidents = await tx.monitoringIncident.findMany({ where: { siteId, id: { in: pageIds } }, include: incidentInclude });
      const byId = new Map(incidents.map((row) => [row.id, row]));
      const ordered = pageIds.map((id) => byId.get(id)!);
      const last = ordered.at(-1);
      const activeCount = await tx.monitoringIncident.count({ where: { siteId, status: { in: ["open", "acknowledged"] } } });
      return {
        incidents: ordered.map((row) => this.summary(row)), activeCount,
        nextCursor: rows.length > query.limit && last ? encodeIncidentCursor({
          siteId, status: query.status, type: query.type, active: last.resolvedAt === null, openedAt: last.openedAt, id: last.id
        }) : null
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async update(user: AuthenticatedUser, siteId: string, id: string, input: unknown) {
    const body = parseIncidentMutation(input);
    await this.access.assert(user, siteId, "manage");
    return this.prisma.$transaction(async (tx) => {
      // Assignment/user-status writes use the same Site-first lock. Reauthorize
      // only after acquiring it, then serialize this occurrence's mutations.
      const site = await this.access.assertManageInTransaction(tx, user, siteId);
      const candidate = body.action === "resolve"
        ? await tx.monitoringIncident.findFirst({ where: { id, siteId } }) : null;
      if (body.action === "resolve" && !candidate) throw new NotFoundException("incident not found");
      const lockedGatewayId = candidate ? await this.lockResolutionDependencies(tx, siteId, candidate) : null;
      const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "MonitoringIncident" WHERE "siteId" = ${siteId} AND "id" = ${id} FOR UPDATE
      `);
      if (!locked.length) throw new NotFoundException("incident not found");
      const current = await tx.monitoringIncident.findFirstOrThrow({ where: { id, siteId } });
      if (candidate && (candidate.type !== current.type || candidate.fixtureId !== current.fixtureId || candidate.gatewayId !== current.gatewayId)) throw this.targetChanged();
      this.assertRevision(current.updatedAt, body.expectedUpdatedAt, "INCIDENT_CONFLICT");
      if (current.status === "resolved" || (body.action === "acknowledge" && current.status !== "open")) {
        throw new ConflictException({ code: "INCIDENT_INVALID_STATE", message: "incident action is no longer available" });
      }
      let now = new Date(Math.max(Date.now(), current.openedAt.getTime(), current.lastObservedAt.getTime(), current.acknowledgedAt?.getTime() ?? 0));
      let data: Prisma.MonitoringIncidentUpdateInput;
      if (body.action === "acknowledge") {
        data = { status: "acknowledged", acknowledgedAt: now, acknowledgedBy: { connect: { id: user.id } } };
      } else if (body.action === "assign") {
        if (body.userId !== null) {
          const assignee = await tx.user.findFirst({
            where: { id: body.userId, organizationId: site.organizationId, status: "active", OR: [
              { role: "admin", administeredSite: { id: siteId } },
              { role: "viewer", siteMemberships: { some: { siteId } } }
            ] }, select: { id: true }
          });
          if (!assignee) throw new BadRequestException({ code: "INVALID_INCIDENT_ASSIGNEE", message: "assignee must be an active member of this site" });
        }
        data = { assignedTo: body.userId === null ? { disconnect: true } : { connect: { id: body.userId } } };
      } else {
        const policy = await this.policy(tx, siteId);
        const condition = await this.readResolutionCondition(tx, siteId, current, lockedGatewayId);
        // A blocked target lock can outlive a freshness threshold. Sample time
        // again after reading the locked snapshot before confirming recovery.
        now = new Date(Math.max(now.getTime(), Date.now()));
        if (isMonitoringConditionActive(current.type, condition, policy, now)) {
          throw new ConflictException({ code: "INCIDENT_STILL_ACTIVE", message: "the incident condition is still active" });
        }
        data = { status: "resolved", activeKey: null, resolvedAt: now, resolvedBy: { connect: { id: user.id } }, resolutionKind: "operator_confirmed", resolutionNote: body.note };
      }
      const saved = await tx.monitoringIncident.update({ where: { id }, data: { ...data, updatedAt: this.nextUpdatedAt(current.updatedAt) }, include: incidentInclude });
      await this.audit.record({ transaction: tx, organizationId: site.organizationId, siteId, actorId: user.id,
        action: `monitoring_incident.${body.action}`, targetType: "MonitoringIncident", targetId: id, outcome: "success",
        metadata: { action: body.action, status: saved.status, ...(body.action === "assign" ? { assignedToUserId: body.userId } : {}) } });
      return this.summary(saved);
    });
  }

  private async lockResolutionDependencies(tx: Prisma.TransactionClient, siteId: string, target: IncidentTarget) {
    let gatewayId = target.gatewayId;
    if (target.fixtureId) {
      const fixture = await tx.fixture.findFirst({ where: { id: target.fixtureId, siteId }, select: { gatewayId: true } });
      if (!fixture) throw new NotFoundException("incident target not found");
      gatewayId = fixture.gatewayId;
    }
    // Resolution order is Site -> Gateway -> Fixture -> Incident, matching
    // gateway-first provisioning and target deletion cascades. NO KEY UPDATE
    // blocks heartbeat writers but permits the Gateway FK KEY SHARE acquired by
    // fixture ingestion while it owns Fixture; FOR UPDATE would create a cycle.
    if (gatewayId) {
      const gateways = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "Gateway" WHERE "id" = ${gatewayId} AND "siteId" = ${siteId} FOR NO KEY UPDATE
      `);
      if (!gateways.length) throw new NotFoundException("incident target not found");
    }
    if (target.fixtureId) {
      const fixtures = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "Fixture" WHERE "id" = ${target.fixtureId} AND "siteId" = ${siteId} FOR UPDATE
      `);
      if (!fixtures.length) throw new NotFoundException("incident target not found");
    }
    return gatewayId;
  }

  private async readResolutionCondition(tx: Prisma.TransactionClient, siteId: string, target: IncidentTarget, lockedGatewayId: string | null) {
    const fixture = target.fixtureId ? await tx.fixture.findFirst({ where: { id: target.fixtureId, siteId }, select: {
      gatewayId: true, lastSeenAt: true, reportedStatusReason: true, healthFaultCodes: true, healthLastSeenAt: true
    } }) : null;
    if (target.fixtureId && !fixture) throw new NotFoundException("incident target not found");
    // Fixture.gatewayId is enforced against MeshNode by its composite FK and
    // owner-projection trigger. If mapping changed while we waited, abort instead
    // of acquiring a new Gateway lock after Fixture (which would invert order).
    if (fixture && fixture.gatewayId !== lockedGatewayId) throw this.targetChanged();
    const gateway = lockedGatewayId ? await tx.gateway.findFirst({ where: { id: lockedGatewayId, siteId }, select: { lastHeartbeatAt: true } }) : null;
    if (lockedGatewayId && !gateway) throw new NotFoundException("incident target not found");
    return { fixture, gateway };
  }

  private targetChanged() {
    return new ConflictException({ code: "INCIDENT_TARGET_CHANGED", message: "incident target changed; reload and retry" });
  }

  private async policy(tx: Prisma.TransactionClient, siteId: string) {
    const policy = await tx.site.findUnique({ where: { id: siteId }, select: policySelect });
    if (!policy) throw new NotFoundException("site not found");
    return policy;
  }

  private assertRevision(updatedAt: Date, expected: string, code: string) {
    if (updatedAt.getTime() !== new Date(expected).getTime()) throw new ConflictException({ code, message: "monitoring data changed; reload and retry" });
  }

  private nextUpdatedAt(current: Date) {
    // Millisecond precision can otherwise let two writes reuse the same revision.
    return new Date(Math.max(Date.now(), current.getTime() + 1));
  }

  private summary({ fixture, gateway, activeKey: _activeKey, ...row }: IncidentRow) {
    return { ...row, target: fixture ? { kind: "fixture" as const, ...fixture } : { kind: "gateway" as const, ...gateway! } };
  }
}
