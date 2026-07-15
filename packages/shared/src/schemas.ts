import { z } from "zod";

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

export const provisionDeviceSchema = z.object({
  sessionId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  meshAddress: z.string().min(1),
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

export const provisioningCompletedSchema = z.object({
  sessionId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  meshAddress: z.string().min(1),
  firmwareVersion: z.string().min(1).optional(),
  rssi: z.number().max(0).nullable().optional(),
  hopCount: z.number().int().nonnegative().nullable().optional(),
  completedAt: z.string().datetime()
});

export const provisioningFailedSchema = z.object({
  sessionId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  errorMessage: z.string().min(1),
  failedAt: z.string().datetime()
});
