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

export const gatewayHeartbeatSchema = z.object({
  siteId: z.string().uuid(),
  gatewaySerial: z.string().min(1),
  sentAt: z.string().datetime()
});

export const provisioningScanStartSchema = z.object({
  sessionId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  floorId: z.string().uuid(),
  requestedBy: z.string().uuid(),
  requestedAt: z.string().datetime()
});

export const identifyDeviceSchema = z.object({
  sessionId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  requestedAt: z.string().datetime()
});

export const unprovisionedDeviceFoundSchema = z.object({
  sessionId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  serialNumber: z.string().min(1),
  rssi: z.number().max(0),
  oobCapability: z.enum(["none", "static-oob", "output-oob", "input-oob"]),
  firmwareVersion: z.string().min(1),
  discoveredAt: z.string().datetime()
});
