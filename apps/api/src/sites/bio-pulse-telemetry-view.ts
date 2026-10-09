import type { PrismaService } from "../prisma/prisma.service";

/** This is past runtime evidence, never source readiness or optical brightness.
 * Reassignment/configuration changes hide an obsolete projection without rewriting
 * its audit record. A pending older occurrence must not disappear behind a pulse. */
export async function loadBioPulseTelemetryViews(prisma: PrismaService, siteId: string, sources: Array<{ id: string; gatewayId: string | null; meshNodeId: string | null }>) {
  const sourceIds = sources.map(source => source.id);
  const views = new Map<string, ReturnType<typeof summarize>>();
  if (!sourceIds.length) return views;
  const rows = await prisma.bioPulseTelemetryProjection.findMany({
    where: { siteId, sourceFixtureId: { in: sourceIds } }, orderBy: { sequence: "desc" },
    include: { gateway: { select: { assignmentVersion: true, automationConfiguration: { select: { desiredRevision: true } } } } }
  });
  const current = rows.filter(row => row.assignmentVersion === row.gateway.assignmentVersion && row.revision === row.gateway.automationConfiguration?.desiredRevision
    && sources.some(source => source.id === row.sourceFixtureId && source.gatewayId === row.gatewayId && source.meshNodeId === row.sourceMeshNodeId));
  for (const id of sourceIds) {
    const matches = current.filter(row => row.sourceFixtureId === id);
    if (matches.length) views.set(id, summarize(matches));
  }
  return views;
}

type Row = {
  ruleId: string; occurrenceKey: string; gatewayId: string; revision: number; assignmentVersion: number;
  targetFixtureIds: string[]; sequence: bigint; lastPulseAt: Date | null; lastPulseSequence: bigint | null; health: string; healthReason: string | null;
  degradedSince: Date | null; restorationPending: boolean | null; restorationReason: string | null;
  configurationReadback: unknown; lastEventAt: Date; receivedAt: Date;
};
function summarize(rows: Row[]) {
  const latest = rows[0]!;
  const degraded = rows.find(row => row.health === "degraded" || (row.health === "unverified" && row.degradedSince));
  const pending = rows.find(row => row.restorationPending === true);
  const lastPulse = rows.filter(row => row.lastPulseSequence !== null).reduce<Row | undefined>((latest, row) =>
    !latest || row.lastPulseSequence! > latest.lastPulseSequence! ? row : latest, undefined);
  const readback = rows.filter(row => row.configurationReadback).reduce<Row | undefined>((latest, row) =>
    !latest || readbackSequence(row) > readbackSequence(latest) ? row : latest, undefined);
  return {
    evidence: "gateway_runtime_telemetry" as const,
    gatewayId: latest.gatewayId, assignmentVersion: latest.assignmentVersion, revision: latest.revision,
    lastPulseAt: lastPulse?.lastPulseAt?.toISOString() ?? null,
    health: degraded?.health ?? latest.health, healthReason: degraded?.healthReason ?? latest.healthReason,
    degradedSince: degraded?.degradedSince?.toISOString() ?? null,
    restorationPending: pending ? true : latest.restorationPending,
    restorationReason: pending?.restorationReason ?? latest.restorationReason,
    targetFixtureIds: [...new Set(rows.flatMap(row => row.targetFixtureIds))],
    configurationReadback: readback?.configurationReadback ?? null,
    lastEventAt: latest.lastEventAt.toISOString(), receivedAt: latest.receivedAt.toISOString(),
    occurrences: rows.map(row => ({ ruleId: row.ruleId, occurrenceKey: row.occurrenceKey,
      targetFixtureIds: row.targetFixtureIds, restorationPending: row.restorationPending,
      restorationReason: row.restorationReason, health: row.health, degradedSince: row.degradedSince?.toISOString() ?? null }))
  };
}

function readbackSequence(row: Row) {
  return (row.configurationReadback as { sequence: number }).sequence;
}
