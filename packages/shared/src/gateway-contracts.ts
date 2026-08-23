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
  heartbeat: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/state/heartbeat`,
  meshGroupResyncRequest: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/mesh-group/resync-request`,
  meshGroupResyncAck: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/commands/mesh-group/resync-ack`
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

const meshGroupAddressSchema = z.string().regex(/^0x[0-9a-f]{4}$/i).refine(
  (value) => {
    const address = Number.parseInt(value.slice(2), 16);
    return address >= 0xc000 && address <= 0xfeff;
  },
  "destinationAddress must be a BLE Mesh group address from 0xc000 to 0xfeff"
);

const gatewayDimmingCommandFields = {
  targetType: z.enum(["fixture", "fixtures", "floor", "group"]),
  targetId: z.string().uuid().nullable(),
  targetFixtureIds: z.array(z.string().uuid()).min(1).max(1_000),
  deliveryMode: z.enum(["unicast", "parallel_unicast", "mesh_group"]),
  destinationAddress: meshGroupAddressSchema.optional(),
  meshControlGroupId: z.string().uuid().optional(),
  meshControlGroupVersion: z.number().int().positive().optional(),
  brightness: z.number().int().min(0).max(100),
  requestedBy: z.string().uuid(),
  requestedAt: z.string().datetime()
};

function validateDimmingDelivery(
  command: {
    targetType: "fixture" | "fixtures" | "floor" | "group";
    targetId: string | null;
    targetFixtureIds: string[];
    deliveryMode: "unicast" | "parallel_unicast" | "mesh_group";
    destinationAddress?: string;
    meshControlGroupId?: string;
    meshControlGroupVersion?: number;
  },
  context: z.RefinementCtx
) {
  const issue = (path: string, message: string) => context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message
  });
  if (new Set(command.targetFixtureIds).size !== command.targetFixtureIds.length) {
    issue("targetFixtureIds", "targetFixtureIds must be unique");
  }

  if (command.targetType === "fixture") {
    if (!command.targetId) issue("targetId", "fixture targetId is required");
    if (command.targetFixtureIds.length !== 1 || command.targetFixtureIds[0] !== command.targetId) {
      issue("targetFixtureIds", "fixture targetId must match its only targetFixtureId");
    }
    if (command.deliveryMode !== "unicast") issue("deliveryMode", "fixture target requires unicast delivery");
  } else if (command.targetType === "fixtures") {
    if (command.targetId !== null) issue("targetId", "fixtures targetId must be null");
    if (command.targetFixtureIds.length === 1 && command.deliveryMode !== "unicast") {
      issue("deliveryMode", "one fixtures target requires unicast delivery");
    }
    if (
      command.targetFixtureIds.length > 1 &&
      command.deliveryMode !== "parallel_unicast" &&
      command.deliveryMode !== "mesh_group"
    ) {
      issue("deliveryMode", "multiple fixtures require parallel_unicast or mesh_group delivery");
    }
  } else {
    if (!command.targetId) issue("targetId", `${command.targetType} targetId is required`);
    if (command.deliveryMode !== "mesh_group") {
      issue("deliveryMode", `${command.targetType} target requires mesh_group delivery`);
    }
  }

  if (command.deliveryMode === "mesh_group") {
    if (!command.destinationAddress) issue("destinationAddress", "destinationAddress is required for mesh_group delivery");
    if (!command.meshControlGroupId) issue("meshControlGroupId", "meshControlGroupId is required for mesh_group delivery");
    if (!command.meshControlGroupVersion) {
      issue("meshControlGroupVersion", "meshControlGroupVersion is required for mesh_group delivery");
    }
  } else {
    if (command.destinationAddress !== undefined) {
      issue("destinationAddress", "destinationAddress is only allowed for mesh_group delivery");
    }
    if (command.meshControlGroupId !== undefined || command.meshControlGroupVersion !== undefined) {
      issue("deliveryMode", "group metadata is only allowed for mesh_group delivery");
    }
  }
}

// An outbox record is completed immediately before MQTT publish so its expiry starts at the real publish time.
const gatewayDimmingCommandDraftV2BaseSchema = commandIdentitySchema.extend(gatewayDimmingCommandFields).strict();
export const gatewayDimmingCommandDraftV2Schema = gatewayDimmingCommandDraftV2BaseSchema.superRefine(
  validateDimmingDelivery
);

export const gatewayDimmingCommandV2Schema = gatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime()
}).strict().superRefine(validateDimmingDelivery);

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

export const healthFaultCodesSchema = z.array(z.number().int().min(0).max(0xff)).max(0xff);

export const fixtureHealthSnapshotSchema = z.object({
  faultCodes: healthFaultCodesSchema,
  observedAt: z.string().datetime()
}).strict();

export const fixtureStateV2Schema = orderedGatewayEventSchema.extend({
  fixtureId: z.string().uuid(),
  brightness: z.number().int().min(0).max(100),
  powerOn: z.boolean(),
  status: z.enum(["online", "offline", "fault"]),
  statusReason: z.enum(["reported", "mesh_publication", "startup_resync", "fixture_stale", "gateway_offline", "command_failed"]).optional(),
  faultCode: z.string().min(1).optional(),
  health: fixtureHealthSnapshotSchema.optional(),
  rssi: z.number().max(0).nullable(),
  hopCount: z.number().int().nonnegative().nullable()
});

export const gatewayHeartbeatV2Schema = orderedGatewayEventSchema.extend({
  gatewaySerial: z.string().min(1),
  firmwareVersion: z.string().min(1),
  configVersion: z.number().int().nonnegative().optional()
});

export const meshGroupResyncRequestV2Schema = gatewayScopeSchema.extend({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  reason: z.enum(["startup", "first_run", "state_missing", "state_corrupt"])
}).strict();

export const meshGroupResyncAckV2Schema = gatewayScopeSchema.extend({
  eventId: z.string().uuid(),
  requestEventId: z.string().uuid(),
  occurredAt: z.string().datetime()
}).strict();

export type GatewayDimmingCommandV2 = z.infer<typeof gatewayDimmingCommandV2Schema>;
export type GatewayDimmingCommandDraftV2 = z.infer<typeof gatewayDimmingCommandDraftV2Schema>;
export type AcceptanceAckV2 = z.infer<typeof acceptanceAckV2Schema>;
export type DeviceStatusAckV2 = z.infer<typeof deviceStatusAckV2Schema>;
export type FixtureStateV2 = z.infer<typeof fixtureStateV2Schema>;
export type GatewayHeartbeatV2 = z.infer<typeof gatewayHeartbeatV2Schema>;
export type MeshGroupResyncRequestV2 = z.infer<typeof meshGroupResyncRequestV2Schema>;
export type MeshGroupResyncAckV2 = z.infer<typeof meshGroupResyncAckV2Schema>;

export function mapHealthFaults(faultCodes: readonly number[]) {
  return [...new Set(faultCodes.filter((code) => code !== 0))].sort((left, right) => left - right);
}

export function statusFromHealth(faultCodes: readonly number[]): "online" | "fault" {
  return faultCodes.length > 0 ? "fault" : "online";
}
