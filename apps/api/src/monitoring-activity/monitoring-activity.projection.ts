import { Prisma } from "@prisma/client";
import { monitoringActivityKindSchema } from "@led-control/shared";
import { z } from "zod";

const inputSchema = z.object({
  siteId: z.string().uuid(),
  floorId: z.string().uuid(),
  sourceType: z.enum(["fixture_state", "fixture_presence", "fixture_health", "gateway_freshness", "monitoring_refresh", "command"]),
  sourceKey: z.string().min(1).max(200),
  kind: monitoringActivityKindSchema,
  observedAt: z.date().optional(),
  fixtureId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(200).optional(),
  status: z.enum(["online", "offline", "fault"]).optional(),
  brightnessPercent: z.number().int().min(0).max(100).optional(),
  commandOutcome: z.enum(["applied", "not_applied", "partially_applied", "unknown"]).optional(),
  refreshStatus: z.enum(["completed", "partial", "failed", "expired"]).optional()
}).strict().superRefine((activity, context) => {
  if ((activity.kind === "command_result") !== (activity.commandOutcome !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["commandOutcome"], message: "command result requires its actual outcome" });
  }
  if ((activity.kind === "monitoring_refresh_result") !== (activity.refreshStatus !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refreshStatus"], message: "refresh result requires its terminal status" });
  }
});

export type MonitoringActivityInput = z.infer<typeof inputSchema>;

/** Call only inside the transaction that applies the verified source transition. */
export async function recordMonitoringActivity(tx: Prisma.TransactionClient, input: MonitoringActivityInput): Promise<void> {
  await recordMonitoringActivities(tx, [input]);
}

/** Batch validation keeps freshness sweeps from issuing one floor ownership query per fixture. */
export async function recordMonitoringActivities(tx: Prisma.TransactionClient, inputs: MonitoringActivityInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const activities = inputs.map(input => inputSchema.parse(input));
  const floorIdsBySite = new Map<string, Set<string>>();
  for (const activity of activities) {
    const floorIds = floorIdsBySite.get(activity.siteId) ?? new Set<string>();
    floorIds.add(activity.floorId);
    floorIdsBySite.set(activity.siteId, floorIds);
  }
  for (const [siteId, floorIds] of floorIdsBySite) {
    const floors = await tx.floor.findMany({ where: { siteId, id: { in: [...floorIds] } }, select: { id: true } });
    if (floors.length !== floorIds.size) throw new Error("monitoring activity floor does not belong to site");
  }
  // recordedAt comes from the database default, never from device event time or producer input.
  await tx.monitoringActivity.createMany({ data: activities, skipDuplicates: true });
}
