import { z } from "zod";

export const dimmingCommandSchema = z.object({
  commandId: z.string().uuid(),
  siteId: z.string().uuid(),
  targetType: z.enum(["fixture", "group"]),
  targetId: z.string().uuid(),
  brightness: z.number().int().min(0).max(100),
  requestedBy: z.string().min(1),
  requestedAt: z.string().datetime()
});

export const fixtureStateSchema = z.object({
  fixtureId: z.string().uuid(),
  brightness: z.number().int().min(0).max(100),
  powerOn: z.boolean(),
  status: z.enum(["online", "offline", "fault"]),
  rssi: z.number().nullable(),
  hopCount: z.number().int().nonnegative().nullable(),
  commandSuccessRate: z.number().min(0).max(1).nullable(),
  lastSeenAt: z.string().datetime()
});

export const commandAckSchema = z.object({
  commandId: z.string().uuid(),
  status: z.enum(["acknowledged", "failed"]),
  acknowledgedAt: z.string().datetime().optional(),
  errorMessage: z.string().optional()
});
