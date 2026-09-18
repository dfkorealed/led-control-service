import { Prisma } from "@prisma/client";

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
  return updated.count === 1;
}
