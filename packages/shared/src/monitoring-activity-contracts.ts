import { z } from "zod";

export const monitoringActivityKindSchema = z.enum([
  "fixture_status_changed", "fixture_brightness_changed", "fixture_health_changed",
  "fixture_offline", "fixture_online", "monitoring_refresh_result", "command_result"
]);

export const monitoringActivityItemSchema = z.object({
  id: z.string().uuid(),
  kind: monitoringActivityKindSchema,
  recordedAt: z.string().datetime(),
  observedAt: z.string().datetime().optional(),
  fixtureId: z.string().uuid().optional(),
  displayName: z.string().min(1).optional(),
  status: z.enum(["online", "offline", "fault"]).optional(),
  brightnessPercent: z.number().int().min(0).max(100).optional(),
  commandOutcome: z.enum(["applied", "not_applied", "partially_applied", "unknown"]).optional(),
  refreshStatus: z.enum(["completed", "partial", "failed", "expired"]).optional()
}).strict();

/** DB transaction UTC anchor shared by retained command detail/history and activity. */
export const detailRetentionAnchorSchema = z.object({
  generatedAt: z.string().datetime(),
  retainedFrom: z.string().datetime(),
  // Monitoring always enforces retention; command GETs expose rollout state.
  retentionEnabled: z.boolean().optional()
});
export type DetailRetentionAnchor = z.infer<typeof detailRetentionAnchorSchema>;

export const monitoringActivityResponseSchema = detailRetentionAnchorSchema.extend({
  items: z.array(monitoringActivityItemSchema),
  nextCursor: z.string().min(1).nullable()
}).strict();

export type MonitoringActivityKind = z.infer<typeof monitoringActivityKindSchema>;
export type MonitoringActivityItem = z.infer<typeof monitoringActivityItemSchema>;
export type MonitoringActivityResponse = z.infer<typeof monitoringActivityResponseSchema>;
