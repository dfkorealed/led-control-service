import { Prisma } from "@prisma/client";
import { recordMonitoringActivity } from "../monitoring-activity/monitoring-activity.projection";

export async function finalizeResolvedMonitoringRefresh(
  tx: Prisma.TransactionClient,
  refreshId: string,
  completedAt: Date,
  emptyVerifiedStatus: "failed" | "expired"
) {
  const pending = await tx.monitoringRefreshFixture.count({ where: { refreshId, status: "pending" } });
  if (pending !== 0) return false;

  const counts = await tx.monitoringRefreshFixture.groupBy({
    by: ["status"],
    where: { refreshId },
    _count: { _all: true }
  });
  const byStatus = Object.fromEntries(counts.map((row) => [row.status, row._count._all]));
  const onlineFixtures = byStatus.online ?? 0;
  const offlineFixtures = byStatus.offline ?? 0;
  const unverifiedFixtures = byStatus.unverified ?? 0;
  const verified = onlineFixtures + offlineFixtures;
  const status = unverifiedFixtures === 0 ? "completed" : verified > 0 ? "partial" : emptyVerifiedStatus;
  const updated = await tx.monitoringRefresh.updateMany({
    where: { id: refreshId, status: "pending" },
    data: { status, onlineFixtures, offlineFixtures, unverifiedFixtures, completedAt }
  });
  if (updated.count === 1) {
    const refresh = await tx.monitoringRefresh.findUnique({ where: { id: refreshId },
      select: { siteId: true, floorId: true } });
    if (!refresh) throw new Error("terminal monitoring refresh disappeared");
    await recordMonitoringActivity(tx, {
      siteId: refresh.siteId, floorId: refresh.floorId,
      sourceType: "monitoring_refresh", sourceKey: `${refreshId}:${status}`,
      kind: "monitoring_refresh_result", refreshStatus: status
    });
  }
  return updated.count === 1;
}
