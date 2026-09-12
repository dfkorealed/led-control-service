import { Injectable } from "@nestjs/common";
import { Prisma, type MonitoringIncidentType } from "@prisma/client";
import { isMonitoringConditionActive, type MonitoringPolicy } from "./monitoring-conditions";

@Injectable()
export class MonitoringIncidentReconcilerService {
  // The caller owns Site → all Gateway → all Fixture locks and keeps them until
  // commit. State projection and incident reconciliation are one transaction.
  async reconcile(tx: Prisma.TransactionClient, site: MonitoringPolicy & { id: string }, now: Date): Promise<void> {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "MonitoringIncident" WHERE "siteId" = ${site.id} AND "activeKey" IS NOT NULL
      ORDER BY "id" FOR UPDATE
    `);
    const gateways = await tx.gateway.findMany({ where: { siteId: site.id }, select: { id: true, lastHeartbeatAt: true } });
    const fixtures = await tx.fixture.findMany({ where: { siteId: site.id }, select: {
      id: true, gatewayId: true, lastSeenAt: true, reportedStatusReason: true, healthFaultCodes: true, healthLastSeenAt: true
    } });
    const byGatewayId = new Map(gateways.map((gateway) => [gateway.id, gateway]));
    const conditions: Prisma.MonitoringIncidentCreateManyInput[] = [];
    const addCondition = (type: MonitoringIncidentType, id: string) => {
      const isGateway = type === "gateway_offline";
      const targetKey = `${isGateway ? "gateway" : "fixture"}:${id}`;
      conditions.push({ siteId: site.id, type, targetKey, activeKey: `${site.id}:${type}:${targetKey}`,
        gatewayId: isGateway ? id : null, fixtureId: isGateway ? null : id,
        openedAt: now, lastObservedAt: now, createdAt: now, updatedAt: now });
    };
    for (const gateway of gateways) {
      if (isMonitoringConditionActive("gateway_offline", { gateway }, site, now)) addCondition("gateway_offline", gateway.id);
    }
    for (const fixture of fixtures) {
      const gateway = fixture.gatewayId ? byGatewayId.get(fixture.gatewayId) : null;
      for (const type of ["fixture_stale", "fixture_fault", "command_failed"] as const) {
        if (isMonitoringConditionActive(type, { fixture, gateway }, site, now)) addCondition(type, fixture.id);
      }
    }
    const activeKeys = conditions.map((condition) => condition.activeKey!);
    if (activeKeys.length) {
      // Raw SQL intentionally bypasses Prisma @updatedAt. Observations do not
      // invalidate the operator's revision, acknowledgement or assignment.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "MonitoringIncident" SET "lastObservedAt" = GREATEST("lastObservedAt", ${now})
        WHERE "siteId" = ${site.id} AND "activeKey" IN (${Prisma.join(activeKeys)})
      `);
      // Site locking serializes cooperating writers. The unique activeKey is an
      // additional DB guard; a conflict must never overwrite a manual mutation.
      await tx.monitoringIncident.createMany({ data: conditions, skipDuplicates: true });
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "MonitoringIncident"
      SET "status" = 'resolved', "activeKey" = NULL, "resolutionKind" = 'automatic_recovery',
          "resolvedAt" = GREATEST(${now}, "openedAt", "lastObservedAt", "acknowledgedAt"),
          "updatedAt" = GREATEST(${now}, "updatedAt" + INTERVAL '1 millisecond')
      WHERE "siteId" = ${site.id} AND "activeKey" IS NOT NULL
      ${activeKeys.length ? Prisma.sql`AND "activeKey" NOT IN (${Prisma.join(activeKeys)})` : Prisma.empty}
    `);
  }
}
