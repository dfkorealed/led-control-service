import { z } from "zod";

export type GatewayCommandKind =
  | "dimming"
  | "status-check"
  | "provisioning/scan-start"
  | "provisioning/scan-stop"
  | "provisioning/provision-device"
  | "provisioning/identify-device";

export const mqttTopicsV2 = {
  gatewayCommand: (siteId: string, gatewayId: string, kind: GatewayCommandKind) =>
    `sites/${siteId}/gateways/${gatewayId}/commands/${kind}`,
  acceptanceAck: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/acks/acceptance`,
  deviceStatusAck: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/acks/device-status`,
  stateIngestedAck: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/acks/state-ingested`,
  provisioningScanTerminalIngestedAck: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/acks/provisioning/scan-terminal-ingested`,
  provisioningDeviceTerminalIngestedAck: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/acks/provisioning/device-terminal-ingested`,
  provisioningScanFound: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-found`,
  provisioningScanCompleted: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-completed`,
  provisioningScanFailed: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-failed`,
  provisioningDeviceTerminal: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning/device-terminal`,
  fixtureState: (siteId: string, gatewayId: string) => `sites/${siteId}/gateways/${gatewayId}/state/fixtures`,
  fixturePresence: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/state/fixture-presence`,
  fixturePresenceCheck: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/commands/fixture-presence-check`,
  fixtureUnreachable: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/fixture-unreachable`,
  fixturePresenceCheckCompleted: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/fixture-presence-check-completed`,
  fixturePresenceCheckCompletedAck: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/acks/fixture-presence-check-completed`,
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

const monitoringRefreshIdentitySchema = z.object({
  refreshId: z.string().uuid(),
  batchId: z.string().uuid()
});

const monitoringTargetFixtureIdsSchema = z.array(z.string().uuid()).min(1).max(64).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "fixture ids must be unique" });
  }
});

export const fixturePresenceCheckCommandV1Schema = gatewayScopeSchema
  .merge(monitoringRefreshIdentitySchema)
  .extend({
    idempotencyKey: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    targetFixtureIds: monitoringTargetFixtureIdsSchema,
    requestedAt: z.string().datetime(),
    expiresAt: z.string().datetime()
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.requestedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must follow requestedAt" });
    }
  });

export const fixtureUnreachableV1Schema = orderedGatewayEventSchema
  .merge(monitoringRefreshIdentitySchema)
  .extend({
    fixtureId: z.string().uuid(),
    reason: z.enum(["not_found", "read_timeout", "read_failed"])
  })
  .strict();

export const fixturePresenceCheckCompletedV1Schema = orderedGatewayEventSchema
  .merge(monitoringRefreshIdentitySchema)
  .extend({ targetFixtureIds: monitoringTargetFixtureIdsSchema })
  .strict();

export const fixturePresenceCheckCompletedAckV1Schema = gatewayScopeSchema
  .merge(monitoringRefreshIdentitySchema)
  .strict();

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

function validateDimmingExpiry(
  command: Parameters<typeof validateDimmingDelivery>[0] & { expiresAt: string },
  context: z.RefinementCtx
) {
  validateDimmingDelivery(command, context);
}

function validatePublishedDimmingCommand(
  command: Parameters<typeof validateDimmingDelivery>[0] & {
    expiresAt: string;
    deliveryGeneratedAt: string;
    deliveryWindowMs: number;
  },
  context: z.RefinementCtx
) {
  validateDimmingDelivery(command, context);
  validatePublishedDeliveryExpiry(command, context);
}

function validateLegacyPublishedDimmingCommand(
  command: Parameters<typeof validateDimmingDelivery>[0] & {
    expiresAt: string;
    deliveryGeneratedAt: string;
    deliveryWindowMs: number;
    overrideUntil?: string;
    overrideRemainingMs?: number;
  },
  context: z.RefinementCtx
) {
  validatePublishedDimmingCommand(command, context);
  const generatedAt = Date.parse(command.deliveryGeneratedAt);
  if (command.overrideUntil) {
    const expectedRemaining = Date.parse(command.overrideUntil) - generatedAt;
    if (command.overrideRemainingMs !== expectedRemaining) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overrideRemainingMs"],
        message: "overrideRemainingMs must match overrideUntil at delivery generation"
      });
    }
    if (command.deliveryWindowMs > expectedRemaining) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveryWindowMs"],
        message: "deliveryWindowMs must not exceed overrideRemainingMs"
      });
    }
  } else if (command.overrideRemainingMs !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overrideRemainingMs"],
      message: "overrideRemainingMs requires overrideUntil"
    });
  }
}

// The API stores this draft until the publisher durably fixes one delivery generation.
const gatewayDimmingCommandDraftV2BaseSchema = commandIdentitySchema.extend(gatewayDimmingCommandFields).strict();
export const gatewayDimmingCommandDraftV2Schema = gatewayDimmingCommandDraftV2BaseSchema.superRefine(
  validateDimmingDelivery
);

const gatewayDimmingCommandLegacyV2Schema = gatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime()
}).strict().superRefine(validateDimmingDelivery);

export const gatewayDimmingCommandV2Schema = gatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime()
}).strict().superRefine(validateDimmingExpiry);

export const gatewayDimmingCommandPublishedV2Schema = gatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime(),
  deliveryGeneration: z.string().uuid(),
  deliveryGeneratedAt: z.string().datetime(),
  deliveryWindowMs: z.number().int().positive().max(10_000)
}).strict().superRefine(validatePublishedDimmingCommand);

const legacyTimedGatewayDimmingCommandDraftV2BaseSchema = commandIdentitySchema.extend({
  ...gatewayDimmingCommandFields,
  overrideUntil: z.string().datetime().optional()
}).strict();
const historicalGatewayDimmingCommandDraftV2BaseSchema = legacyTimedGatewayDimmingCommandDraftV2BaseSchema.extend({
  requestedBy: z.string().uuid()
}).strict();
const legacyTimedGatewayDimmingCommandDraftV2Schema = legacyTimedGatewayDimmingCommandDraftV2BaseSchema
  .superRefine(validateDimmingDelivery);
const historicalGatewayDimmingCommandDraftV2Schema = historicalGatewayDimmingCommandDraftV2BaseSchema
  .superRefine(validateDimmingDelivery);
export const gatewayDimmingCommandDraftV2CompatibilitySchema = z.union([
  gatewayDimmingCommandDraftV2Schema,
  legacyTimedGatewayDimmingCommandDraftV2Schema,
  historicalGatewayDimmingCommandDraftV2Schema
]);
const legacyTimedGatewayDimmingCommandLegacyV2Schema = legacyTimedGatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime()
}).strict().superRefine(validateDimmingDelivery);
const historicalGatewayDimmingCommandLegacyV2Schema = historicalGatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime()
}).strict().superRefine(validateDimmingDelivery);
const legacyTimedGatewayDimmingCommandV2Schema = legacyTimedGatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime()
}).strict().superRefine(validateDimmingExpiry);
const historicalGatewayDimmingCommandV2Schema = historicalGatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime()
}).strict().superRefine(validateDimmingExpiry);
const legacyTimedGatewayDimmingCommandPublishedV2Schema = legacyTimedGatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime(),
  deliveryGeneration: z.string().uuid(),
  deliveryGeneratedAt: z.string().datetime(),
  deliveryWindowMs: z.number().int().positive().max(10_000),
  overrideRemainingMs: z.number().int().positive().optional()
}).strict().superRefine(validateLegacyPublishedDimmingCommand);
const historicalGatewayDimmingCommandPublishedV2Schema = historicalGatewayDimmingCommandDraftV2BaseSchema.extend({
  expiresAt: z.string().datetime(),
  deliveryGeneration: z.string().uuid(),
  deliveryGeneratedAt: z.string().datetime(),
  deliveryWindowMs: z.number().int().positive().max(10_000),
  overrideRemainingMs: z.number().int().positive().optional()
}).strict().superRefine(validateLegacyPublishedDimmingCommand);

// Persisted journals and rolling deployments can still contain the pre-invariant wire shape.
// Keep this parser at compatibility boundaries only; new producers must use gatewayDimmingCommandPublishedV2Schema.
export const gatewayDimmingCommandV2CompatibilitySchema = z.union([
  gatewayDimmingCommandPublishedV2Schema,
  gatewayDimmingCommandV2Schema,
  gatewayDimmingCommandLegacyV2Schema,
  legacyTimedGatewayDimmingCommandPublishedV2Schema,
  legacyTimedGatewayDimmingCommandV2Schema,
  legacyTimedGatewayDimmingCommandLegacyV2Schema,
  historicalGatewayDimmingCommandPublishedV2Schema,
  historicalGatewayDimmingCommandV2Schema,
  historicalGatewayDimmingCommandLegacyV2Schema
]);

function validatePublishedDeliveryExpiry(
  command: { expiresAt: string; deliveryGeneratedAt: string; deliveryWindowMs: number },
  context: z.RefinementCtx
) {
  if (command.deliveryWindowMs % 1_000 !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["deliveryWindowMs"],
      message: "deliveryWindowMs must use whole MQTT seconds"
    });
  }
  if (Date.parse(command.expiresAt) !== Date.parse(command.deliveryGeneratedAt) + command.deliveryWindowMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "expiresAt must match the delivery window"
    });
  }
}

export const gatewayStatusCheckCommandDraftV2Schema = commandIdentitySchema.extend({
  originalCommandId: z.string().uuid(),
  targetFixtureIds: z.array(z.string().uuid()).min(1).max(64).refine(
    (ids) => new Set(ids).size === ids.length, "targetFixtureIds must be unique"
  ),
  expectedBrightness: z.number().int().min(0).max(100),
  verificationAttempt: z.number().int().min(1).max(3),
  requestedAt: z.string().datetime()
}).strict();

export const gatewayStatusCheckCommandPublishedV2Schema = gatewayStatusCheckCommandDraftV2Schema.extend({
  expiresAt: z.string().datetime(),
  deliveryGeneration: z.string().uuid(),
  deliveryGeneratedAt: z.string().datetime(),
  deliveryWindowMs: z.number().int().positive().max(10_000)
}).strict().superRefine(validatePublishedDeliveryExpiry);

// Status checks have no historical requester-bearing or absolute-expiry-only wire format.
// Keep named compatibility boundaries for consumers without weakening the new wire contract.
export const gatewayStatusCheckCommandDraftV2CompatibilitySchema = gatewayStatusCheckCommandDraftV2Schema;
export const gatewayStatusCheckCommandV2Schema = gatewayStatusCheckCommandPublishedV2Schema;
export const gatewayStatusCheckCommandV2CompatibilitySchema = gatewayStatusCheckCommandPublishedV2Schema;

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

export function deriveDeviceStatusAckStatus(
  results: ReadonlyArray<{ status: "succeeded" | "failed" | "timed_out" }>
): "succeeded" | "partially_succeeded" | "failed" | "timed_out" {
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  if (succeeded === results.length) return "succeeded";
  if (succeeded > 0) return "partially_succeeded";
  // Without a success, a concrete failure takes precedence over any timeout.
  if (results.some((result) => result.status === "failed")) return "failed";
  return "timed_out";
}

// Broker PUBACK only confirms transport; this acknowledgement permits durable state outbox deletion.
export const applicationStateIngestedAckV2Schema = z.object({
  eventId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  fixtureId: z.string().uuid(),
  status: z.enum([
    "ingested",
    "duplicate",
    "stale_sequence",
    "reverse_time",
    "stale_checkpoint",
    "rejected_future_timestamp"
  ]),
  ingestedAt: z.string().datetime()
}).strict();

// Broker PUBACK only confirms transport; this acknowledgement confirms the terminal transaction committed.
export const applicationProvisioningScanTerminalIngestedAckV2Schema = z.object({
  eventId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  sessionId: z.string().uuid(),
  scanCorrelationId: z.string().uuid(),
  scanAttempt: z.number().int().positive(),
  ingestedAt: z.string().datetime()
}).strict();

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
  hopCount: z.number().int().nonnegative().nullable(),
  refreshId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional()
}).superRefine((value, context) => {
  if ((value.refreshId === undefined) !== (value.batchId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refreshId"], message: "refreshId and batchId must be provided together" });
  }
});

// Presence는 liveness/control telemetry만 보고하며 fixture 출력 상태는 별도 계약인
// fixtureStateV2Schema가 소유하므로 이 계약에 brightness/powerOn 등을 섞지 않습니다.
export const fixturePresenceV2Schema = orderedGatewayEventSchema.extend({
  fixtureId: z.string().uuid(),
  controlMode: z.enum(["sensor", "force-off", "force-on"]),
  rawHighBrightness: z.number().int().min(0).max(0xff),
  configuredBrightness: z.number().int().min(0).max(100).nullable(),
  rssi: z.number().max(0).nullable(),
  hopCount: z.number().int().nonnegative().nullable(),
  refreshId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional()
}).strict().superRefine((value, context) => {
  if ((value.refreshId === undefined) !== (value.batchId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refreshId"], message: "refreshId and batchId must be provided together" });
  }
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
export type GatewayDimmingCommandPublishedV2 = z.infer<typeof gatewayDimmingCommandPublishedV2Schema>;
export type GatewayDimmingCommandV2Compatible = z.infer<typeof gatewayDimmingCommandV2CompatibilitySchema>;
export type GatewayDimmingCommandDraftV2 = z.infer<typeof gatewayDimmingCommandDraftV2Schema>;
export type GatewayStatusCheckCommandDraftV2 = z.infer<typeof gatewayStatusCheckCommandDraftV2Schema>;
export type GatewayStatusCheckCommandPublishedV2 = z.infer<typeof gatewayStatusCheckCommandPublishedV2Schema>;
export type GatewayStatusCheckCommandV2 = z.infer<typeof gatewayStatusCheckCommandV2Schema>;
export type GatewayStatusCheckCommandV2Compatible = z.infer<typeof gatewayStatusCheckCommandV2CompatibilitySchema>;
export type AcceptanceAckV2 = z.infer<typeof acceptanceAckV2Schema>;
export type DeviceStatusAckV2 = z.infer<typeof deviceStatusAckV2Schema>;
export type ApplicationStateIngestedAckV2 = z.infer<typeof applicationStateIngestedAckV2Schema>;
export type ApplicationProvisioningScanTerminalIngestedAckV2 = z.infer<
  typeof applicationProvisioningScanTerminalIngestedAckV2Schema
>;
export type FixtureStateV2 = z.infer<typeof fixtureStateV2Schema>;
export type FixturePresenceV2 = z.infer<typeof fixturePresenceV2Schema>;
export type FixturePresenceCheckCommandV1 = z.infer<typeof fixturePresenceCheckCommandV1Schema>;
export type FixtureUnreachableV1 = z.infer<typeof fixtureUnreachableV1Schema>;
export type FixturePresenceCheckCompletedV1 = z.infer<typeof fixturePresenceCheckCompletedV1Schema>;
export type FixturePresenceCheckCompletedAckV1 = z.infer<typeof fixturePresenceCheckCompletedAckV1Schema>;
export type GatewayHeartbeatV2 = z.infer<typeof gatewayHeartbeatV2Schema>;
export type MeshGroupResyncRequestV2 = z.infer<typeof meshGroupResyncRequestV2Schema>;
export type MeshGroupResyncAckV2 = z.infer<typeof meshGroupResyncAckV2Schema>;

export function mapHealthFaults(faultCodes: readonly number[]) {
  return [...new Set(faultCodes.filter((code) => code !== 0))].sort((left, right) => left - right);
}

export function statusFromHealth(faultCodes: readonly number[]): "online" | "fault" {
  return faultCodes.length > 0 ? "fault" : "online";
}
