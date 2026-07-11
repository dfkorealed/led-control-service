import { z } from "zod";

export type GatewayCommandKind =
  | "dimming"
  | "provisioning/scan-start"
  | "provisioning/scan-stop"
  | "provisioning/provision-device"
  | "provisioning/identify-device";

export const mqttTopicsV2 = {
  gatewayCommand: (siteId: string, gatewayId: string, kind: GatewayCommandKind) =>
    `sites/${siteId}/gateways/${gatewayId}/commands/${kind}`,
  acceptanceAck: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/acks/acceptance`,
  deviceStatusAck: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/acks/device-status`,
  fixtureState: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/state/fixtures`,
  heartbeat: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/state/heartbeat`
} as const;

const gatewayScopeSchema = z.object({
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid()
});

const orderedGatewayEventSchema = gatewayScopeSchema.extend({
  eventId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime()
});

const commandIdentitySchema = gatewayScopeSchema.extend({
  commandId: z.string().uuid(),
  dispatchId: z.string().uuid(),
  idempotencyKey: z.string().min(16).max(200),
  sequence: z.number().int().nonnegative()
});

export const gatewayDimmingCommandV2Schema = commandIdentitySchema.extend({
  targetType: z.enum(["fixture", "group"]),
  targetId: z.string().uuid(),
  targetFixtureIds: z.array(z.string().uuid()).min(1),
  brightness: z.number().int().min(0).max(100),
  requestedBy: z.string().uuid(),
  requestedAt: z.string().datetime()
});

export const acceptanceAckV2Schema = commandIdentitySchema.extend({
  eventId: z.string().uuid(),
  status: z.enum(["accepted", "rejected"]),
  acceptedAt: z.string().datetime(),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional()
});

export const deviceCommandResultV2Schema = z.object({
  fixtureId: z.string().uuid(),
  status: z.enum(["succeeded", "failed", "timed_out"]),
  brightness: z.number().int().min(0).max(100).optional(),
  faultCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
  rssi: z.number().max(0).nullable().optional(),
  hopCount: z.number().int().nonnegative().nullable().optional()
});

export const deviceStatusAckV2Schema = commandIdentitySchema.extend({
  eventId: z.string().uuid(),
  status: z.enum(["succeeded", "partially_succeeded", "failed", "timed_out"]),
  occurredAt: z.string().datetime(),
  results: z.array(deviceCommandResultV2Schema).min(1)
});

export const fixtureStateV2Schema = orderedGatewayEventSchema.extend({
  fixtureId: z.string().uuid(),
  brightness: z.number().int().min(0).max(100),
  powerOn: z.boolean(),
  status: z.enum(["online", "offline", "fault"]),
  statusReason: z.enum(["reported", "fixture_stale", "gateway_offline", "command_failed"]).optional(),
  faultCode: z.string().min(1).optional(),
  rssi: z.number().max(0).nullable(),
  hopCount: z.number().int().nonnegative().nullable()
});

export const gatewayHeartbeatV2Schema = orderedGatewayEventSchema.extend({
  gatewaySerial: z.string().min(1),
  firmwareVersion: z.string().min(1),
  configVersion: z.number().int().nonnegative().optional()
});

export type GatewayDimmingCommandV2 = z.infer<typeof gatewayDimmingCommandV2Schema>;
export type AcceptanceAckV2 = z.infer<typeof acceptanceAckV2Schema>;
export type DeviceStatusAckV2 = z.infer<typeof deviceStatusAckV2Schema>;
export type FixtureStateV2 = z.infer<typeof fixtureStateV2Schema>;
export type GatewayHeartbeatV2 = z.infer<typeof gatewayHeartbeatV2Schema>;
