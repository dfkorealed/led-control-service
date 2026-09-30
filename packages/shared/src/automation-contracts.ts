import { z } from "zod";
import { automationExecutionActionResultPayloadV1Schema } from "./automation-action-result-contracts";

export {
  automationExecutionActionResultPayloadV1Schema,
  automationExecutionFixtureResultV1Schema
} from "./automation-action-result-contracts";
export type {
  AutomationExecutionActionResultPayloadV1,
  AutomationExecutionFixtureResultV1
} from "./automation-action-result-contracts";

export type AutomationRuleStatus = "enabled" | "disabled";
export type ScheduleRecurrenceKind = "once" | "daily" | "weekly" | "monthly" | "yearly";
export type AutomationExecutionKind =
  | "schedule_started"
  | "schedule_ended"
  | "vehicle_detected"
  | "event_started"
  | "event_extended"
  | "event_ended"
  | "action_result"
  | "telemetry_gap";

export interface AutomationActionV1 {
  dimmingEnabled: boolean;
  brightnessPercent: number;
}

export interface ScheduleRecurrenceV1 {
  kind: ScheduleRecurrenceKind;
  weeklyDays: number[];
  monthlyDay: number | null;
  yearlyMonth: number | null;
  yearlyDay: number | null;
}

export interface LightingScheduleSnapshotV1 {
  id: string;
  name: string;
  status: AutomationRuleStatus;
  activeFrom: string;
  activeUntil: string;
  localStartTime: string;
  localEndTime: string;
  recurrence: ScheduleRecurrenceV1;
  action: AutomationActionV1;
  fixtureIds: string[];
}

export interface VehicleEventRuleSnapshotV1 {
  id: string;
  name: string;
  status: AutomationRuleStatus;
  sourceFixtureIds: string[];
  targetFixtureIds: string[];
  action: AutomationActionV1;
  holdSeconds: number;
}

export type VehicleSensorProtocol = "bluez-stateful" | "bio-usb-pulse";

export interface VehicleEventRuleSnapshotV2 extends VehicleEventRuleSnapshotV1 {
  sensorProtocol: VehicleSensorProtocol;
}

export interface AutomationSnapshotV1 {
  schemaVersion: 1;
  siteId: string;
  gatewayId: string;
  revision: number;
  timeZone: string;
  schedules: LightingScheduleSnapshotV1[];
  vehicleEventRules: VehicleEventRuleSnapshotV1[];
  generatedAt: string;
  payloadHash: `sha256:${string}`;
}

export interface AutomationSnapshotV2 extends Omit<AutomationSnapshotV1, "schemaVersion" | "vehicleEventRules"> {
  schemaVersion: 2;
  vehicleEventRules: VehicleEventRuleSnapshotV2[];
}

export interface AutomationConfigAppliedV1 {
  schemaVersion: 1;
  gatewayId: string;
  revision: number;
  payloadHash: `sha256:${string}`;
  status: "applied" | "rejected";
  errorCode: string | null;
  appliedAt: string;
}

export interface AutomationConfigAppliedV2 extends Omit<AutomationConfigAppliedV1, "schemaVersion"> {
  schemaVersion: 2;
}

export interface AutomationCurrentConfigRequestV1 {
  schemaVersion: 1;
  requestId: string;
  siteId: string;
  gatewayId: string;
  requestedAt: string;
}

export interface AutomationConfigAppliedDeliveryV1 {
  schemaVersion: 1;
  acknowledgementId: string;
  siteId: string;
  gatewayId: string;
  acknowledgement: AutomationConfigAppliedV1;
}

export interface AutomationConfigAppliedReceiptV1 extends AutomationConfigAppliedDeliveryV1 {
  ingestedAt: string;
}

/** A protocol declaration is configuration transport ability, never sensor readiness. */
export interface AutomationCurrentConfigRequestV2 extends Omit<AutomationCurrentConfigRequestV1, "schemaVersion"> {
  schemaVersion: 2;
  assignmentVersion: number;
  declarationRevision: number;
  maxSnapshotVersion: 1 | 2;
}

export interface AutomationConfigAppliedDeliveryV2 extends Omit<AutomationConfigAppliedDeliveryV1, "schemaVersion" | "acknowledgement"> {
  schemaVersion: 2;
  acknowledgement: AutomationConfigAppliedV2;
}

export interface AutomationConfigAppliedReceiptV2 extends AutomationConfigAppliedDeliveryV2 {
  ingestedAt: string;
}

export type AutomationSnapshot = AutomationSnapshotV1 | AutomationSnapshotV2;
export type AutomationConfigApplied = AutomationConfigAppliedV1 | AutomationConfigAppliedV2;
export type AutomationConfigAppliedDelivery = AutomationConfigAppliedDeliveryV1 | AutomationConfigAppliedDeliveryV2;
export type AutomationConfigAppliedReceipt = AutomationConfigAppliedReceiptV1 | AutomationConfigAppliedReceiptV2;
export type AutomationCurrentConfigRequest = AutomationCurrentConfigRequestV1 | AutomationCurrentConfigRequestV2;

export interface AutomationExecutionEventV1 {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  gatewayId: string;
  revision: number;
  ruleId: string | null;
  occurrenceKey: string | null;
  kind: AutomationExecutionKind;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface AutomationExecutionIngestedAckV1 {
  schemaVersion: 1;
  gatewayId: string;
  eventId: string;
  sequence: number;
  reportPayloadHash: `sha256:${string}`;
  ingestedAt: string;
}

export interface VehicleSensorCapabilityReportV1 {
  schemaVersion: 1;
  eventId: string;
  siteId: string;
  gatewayId: string;
  meshNodeId: string;
  capabilityRevision: number;
  status: "supported" | "unsupported";
  verifiedAt: string;
  sensorServerBound: boolean;
  vendorVehicleEventModelBound: boolean;
}

export interface VehicleSensorCapabilityReportV2 {
  schemaVersion: 2;
  eventId: string;
  siteId: string;
  gatewayId: string;
  meshNodeId: string;
  capabilityRevision: number;
  sensorProtocol: "bio-usb-pulse";
  readiness: "off" | "shadow" | "ready" | "degraded";
  verifiedFingerprintId: string | null;
  sensorModeVerifiedAt: string | null;
  verifiedAt: string;
}

export interface VehicleSensorCapabilityIngestedAckV1 {
  schemaVersion: 1;
  eventId: string;
  gatewayId: string;
  meshNodeId: string;
  capabilityRevision: number;
  reportPayloadHash: string;
  status: "applied" | "stale" | "duplicate" | "rejected";
  errorCode: string | null;
  ingestedAt: string;
}

const identifierSchema = z.string().uuid();
const timestampSchema = z.string().datetime();
const payloadHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

function isIanaTimeZone(value: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function addIssue(context: z.RefinementCtx, path: string, message: string) {
  context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
}

const fixtureIdsSchema = z.array(identifierSchema).min(1).superRefine((fixtureIds, context) => {
  if (new Set(fixtureIds).size !== fixtureIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "fixtureIds must be unique" });
  }
});

export const automationActionV1Schema = z.object({
  dimmingEnabled: z.boolean(),
  brightnessPercent: z.number().int().min(0).max(100)
}).strict();

export const scheduleRecurrenceV1Schema = z.object({
  kind: z.enum(["once", "daily", "weekly", "monthly", "yearly"]),
  weeklyDays: z.array(z.number().int().min(1).max(7)),
  monthlyDay: z.number().int().min(1).max(31).nullable(),
  yearlyMonth: z.number().int().min(1).max(12).nullable(),
  yearlyDay: z.number().int().min(1).max(31).nullable()
}).strict().superRefine((recurrence, context) => {
  if (new Set(recurrence.weeklyDays).size !== recurrence.weeklyDays.length) {
    addIssue(context, "weeklyDays", "weeklyDays must be unique");
  }

  const hasOnlyWeeklyFields = recurrence.monthlyDay === null && recurrence.yearlyMonth === null && recurrence.yearlyDay === null;
  if (recurrence.kind === "weekly") {
    if (recurrence.weeklyDays.length === 0) addIssue(context, "weeklyDays", "weekly recurrence requires at least one day");
    if (!hasOnlyWeeklyFields) addIssue(context, "kind", "weekly recurrence cannot include monthly or yearly fields");
    return;
  }

  if (recurrence.weeklyDays.length > 0) addIssue(context, "weeklyDays", "only weekly recurrence can include weekly days");
  if (recurrence.kind === "monthly") {
    if (recurrence.monthlyDay === null) addIssue(context, "monthlyDay", "monthly recurrence requires monthlyDay");
    if (recurrence.yearlyMonth !== null || recurrence.yearlyDay !== null) {
      addIssue(context, "kind", "monthly recurrence cannot include yearly fields");
    }
    return;
  }

  if (recurrence.kind === "yearly") {
    if (recurrence.yearlyMonth === null) addIssue(context, "yearlyMonth", "yearly recurrence requires yearlyMonth");
    if (recurrence.yearlyDay === null) addIssue(context, "yearlyDay", "yearly recurrence requires yearlyDay");
    if (recurrence.monthlyDay !== null) addIssue(context, "kind", "yearly recurrence cannot include monthly fields");
    return;
  }

  if (recurrence.monthlyDay !== null || recurrence.yearlyMonth !== null || recurrence.yearlyDay !== null) {
    addIssue(context, "kind", "once and daily recurrence cannot include recurrence fields");
  }
});

export const lightingScheduleSnapshotV1Schema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1),
  status: z.enum(["enabled", "disabled"]),
  activeFrom: timestampSchema,
  activeUntil: timestampSchema,
  localStartTime: localTimeSchema,
  localEndTime: localTimeSchema,
  recurrence: scheduleRecurrenceV1Schema,
  action: automationActionV1Schema,
  fixtureIds: fixtureIdsSchema
}).strict().superRefine((schedule, context) => {
  if (Date.parse(schedule.activeFrom) > Date.parse(schedule.activeUntil)) {
    addIssue(context, "activeUntil", "activeUntil must not precede activeFrom");
  }
  if (schedule.localStartTime === schedule.localEndTime) {
    addIssue(context, "localEndTime", "localEndTime must differ from localStartTime");
  }
});

export const vehicleEventRuleSnapshotV1Schema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1),
  status: z.enum(["enabled", "disabled"]),
  sourceFixtureIds: fixtureIdsSchema,
  targetFixtureIds: fixtureIdsSchema,
  action: automationActionV1Schema,
  holdSeconds: z.number().int().min(5).max(1_800)
}).strict();

export const vehicleEventRuleSnapshotV2Schema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1),
  status: z.enum(["enabled", "disabled"]),
  sourceFixtureIds: fixtureIdsSchema,
  targetFixtureIds: fixtureIdsSchema,
  action: automationActionV1Schema,
  holdSeconds: z.number().int().min(5).max(1_800),
  sensorProtocol: z.enum(["bluez-stateful", "bio-usb-pulse"])
}).strict().superRefine((rule, context) => {
  // BlueZ stateful rules retain the V1 five-second floor; BIO pulses need at least ten seconds.
  if (rule.sensorProtocol === "bio-usb-pulse" && rule.holdSeconds < 10) {
    addIssue(context, "holdSeconds", "BIO pulse holdSeconds must be at least 10");
  }
});

export const automationSnapshotV1Schema = z.object({
  schemaVersion: z.literal(1),
  siteId: identifierSchema,
  gatewayId: identifierSchema,
  revision: z.number().int().nonnegative(),
  timeZone: z.string().min(1).refine(isIanaTimeZone, "timeZone must be a valid IANA time zone"),
  schedules: z.array(lightingScheduleSnapshotV1Schema),
  vehicleEventRules: z.array(vehicleEventRuleSnapshotV1Schema),
  generatedAt: timestampSchema,
  payloadHash: payloadHashSchema
}).strict();

export const automationSnapshotV2Schema = z.object({
  schemaVersion: z.literal(2),
  siteId: identifierSchema,
  gatewayId: identifierSchema,
  revision: z.number().int().nonnegative(),
  timeZone: z.string().min(1).refine(isIanaTimeZone, "timeZone must be a valid IANA time zone"),
  schedules: z.array(lightingScheduleSnapshotV1Schema),
  vehicleEventRules: z.array(vehicleEventRuleSnapshotV2Schema),
  generatedAt: timestampSchema,
  payloadHash: payloadHashSchema
}).strict();

const automationConfigAppliedFields = {
  gatewayId: identifierSchema,
  revision: z.number().int().nonnegative(),
  payloadHash: payloadHashSchema,
  status: z.enum(["applied", "rejected"]),
  errorCode: z.string().trim().min(1).nullable(),
  appliedAt: timestampSchema
};

function validateAutomationConfigApplied(
  configuration: { status: "applied" | "rejected"; errorCode: string | null },
  context: z.RefinementCtx
) {
  if (configuration.status === "applied" && configuration.errorCode !== null) {
    addIssue(context, "errorCode", "applied configuration cannot include an errorCode");
  }
  if (configuration.status === "rejected" && configuration.errorCode === null) {
    addIssue(context, "errorCode", "rejected configuration requires an errorCode");
  }
}

export const automationConfigAppliedV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...automationConfigAppliedFields
}).strict().superRefine(validateAutomationConfigApplied);

export const automationConfigAppliedV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...automationConfigAppliedFields
}).strict().superRefine(validateAutomationConfigApplied);

export const automationCurrentConfigRequestV1Schema = z.object({
  schemaVersion: z.literal(1),
  requestId: identifierSchema,
  siteId: identifierSchema,
  gatewayId: identifierSchema,
  requestedAt: timestampSchema
}).strict();

export const automationCurrentConfigRequestV2Schema = automationCurrentConfigRequestV1Schema.extend({
  schemaVersion: z.literal(2),
  assignmentVersion: z.number().int().nonnegative().safe(),
  declarationRevision: z.number().int().positive().safe(),
  maxSnapshotVersion: z.union([z.literal(1), z.literal(2)])
}).strict();

const automationConfigAppliedDeliveryShape = {
  schemaVersion: z.literal(1),
  acknowledgementId: identifierSchema,
  siteId: identifierSchema,
  gatewayId: identifierSchema,
  acknowledgement: automationConfigAppliedV1Schema
};

export const automationConfigAppliedDeliveryV1Schema = z.object(
  automationConfigAppliedDeliveryShape
).strict().superRefine((delivery, context) => {
  if (delivery.gatewayId !== delivery.acknowledgement.gatewayId) {
    addIssue(context, "gatewayId", "config acknowledgement Gateway scope must match its delivery");
  }
});

export const automationConfigAppliedReceiptV1Schema = z.object({
  ...automationConfigAppliedDeliveryShape,
  ingestedAt: timestampSchema
}).strict().superRefine((receipt, context) => {
  if (receipt.gatewayId !== receipt.acknowledgement.gatewayId) {
    addIssue(context, "gatewayId", "config acknowledgement Gateway scope must match its receipt");
  }
});

const automationConfigAppliedDeliveryV2Shape = {
  ...automationConfigAppliedDeliveryShape,
  schemaVersion: z.literal(2),
  acknowledgement: automationConfigAppliedV2Schema
};

function validateConfigDeliveryScope(
  delivery: { gatewayId: string; acknowledgement: { gatewayId: string } },
  context: z.RefinementCtx
) {
  if (delivery.gatewayId !== delivery.acknowledgement.gatewayId) {
    addIssue(context, "gatewayId", "config acknowledgement Gateway scope must match its delivery");
  }
}

export const automationConfigAppliedDeliveryV2Schema = z.object(automationConfigAppliedDeliveryV2Shape)
  .strict().superRefine(validateConfigDeliveryScope);
export const automationConfigAppliedReceiptV2Schema = z.object({
  ...automationConfigAppliedDeliveryV2Shape, ingestedAt: timestampSchema
}).strict().superRefine(validateConfigDeliveryScope);
export const automationSnapshotSchema = z.union([automationSnapshotV1Schema, automationSnapshotV2Schema]);
export const automationConfigAppliedSchema = z.union([automationConfigAppliedV1Schema, automationConfigAppliedV2Schema]);
export const automationConfigAppliedDeliverySchema = z.union([automationConfigAppliedDeliveryV1Schema, automationConfigAppliedDeliveryV2Schema]);
export const automationConfigAppliedReceiptSchema = z.union([automationConfigAppliedReceiptV1Schema, automationConfigAppliedReceiptV2Schema]);
export const automationCurrentConfigRequestSchema = z.union([automationCurrentConfigRequestV1Schema, automationCurrentConfigRequestV2Schema]);

export const automationExecutionEventV1Schema = z.object({
  schemaVersion: z.literal(1),
  eventId: identifierSchema,
  sequence: z.number().int().nonnegative(),
  gatewayId: identifierSchema,
  revision: z.number().int().nonnegative(),
  ruleId: identifierSchema.nullable(),
  occurrenceKey: z.string().trim().min(1).nullable(),
  kind: z.enum([
    "schedule_started",
    "schedule_ended",
    "vehicle_detected",
    "event_started",
    "event_extended",
    "event_ended",
    "action_result",
    "telemetry_gap"
  ]),
  occurredAt: timestampSchema,
  payload: z.record(z.unknown())
}).strict().superRefine((event, context) => {
  if (event.kind === "action_result") {
    const parsedPayload = automationExecutionActionResultPayloadV1Schema.safeParse(event.payload);
    if (!parsedPayload.success) {
      addIssue(context, "payload", "action_result requires a valid source and terminal fixture results");
      return;
    }
    const expectsRuleId = parsedPayload.data.sourceType !== "manual_override";
    if ((expectsRuleId && event.ruleId !== parsedPayload.data.sourceId) || (!expectsRuleId && event.ruleId !== null)) {
      addIssue(context, "ruleId", "action_result ruleId must match its source");
    }
    return;
  }

  if (["schedule_started", "schedule_ended", "vehicle_detected", "event_started", "event_extended", "event_ended"].includes(event.kind)) {
    if (event.ruleId === null) addIssue(context, "ruleId", "rule execution requires ruleId");
    return;
  }
  if (event.ruleId !== null) addIssue(context, "ruleId", "telemetry_gap cannot include ruleId");
});

export const automationExecutionIngestedAckV1Schema = z.object({
  schemaVersion: z.literal(1),
  gatewayId: identifierSchema,
  eventId: identifierSchema,
  sequence: z.number().int().nonnegative(),
  reportPayloadHash: payloadHashSchema,
  ingestedAt: timestampSchema
}).strict();

export const vehicleSensorCapabilityReportV1Schema = z.object({
  schemaVersion: z.literal(1),
  eventId: identifierSchema,
  siteId: identifierSchema,
  gatewayId: identifierSchema,
  meshNodeId: identifierSchema,
  capabilityRevision: positiveSafeIntegerSchema,
  status: z.enum(["supported", "unsupported"]),
  verifiedAt: z.string().datetime({ offset: true }),
  sensorServerBound: z.boolean(),
  vendorVehicleEventModelBound: z.boolean()
}).strict().superRefine((report, context) => {
  const bothModelsBound = report.sensorServerBound && report.vendorVehicleEventModelBound;
  if (report.status === "supported" && !bothModelsBound) {
    addIssue(context, "status", "supported capability requires both vehicle sensor models");
  }
  if (report.status === "unsupported" && bothModelsBound) {
    addIssue(context, "status", "unsupported capability requires at least one unbound vehicle sensor model");
  }
});

export const vehicleSensorCapabilityReportV2Schema = z.object({
  schemaVersion: z.literal(2),
  eventId: identifierSchema,
  siteId: identifierSchema,
  gatewayId: identifierSchema,
  meshNodeId: identifierSchema,
  capabilityRevision: positiveSafeIntegerSchema,
  sensorProtocol: z.literal("bio-usb-pulse"),
  readiness: z.enum(["off", "shadow", "ready", "degraded"]),
  verifiedFingerprintId: z.string().trim().min(1).nullable(),
  sensorModeVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  verifiedAt: z.string().datetime({ offset: true })
}).strict().superRefine((report, context) => {
  // Structural readiness is not product support; live health and approved profiles are checked by consumers.
  if (report.readiness !== "ready") return;
  if (report.verifiedFingerprintId === null) {
    addIssue(context, "verifiedFingerprintId", "ready BIO capability requires a verified fingerprint profile");
  }
  if (report.sensorModeVerifiedAt === null) {
    addIssue(context, "sensorModeVerifiedAt", "ready BIO capability requires sensor-mode verification");
  }
});

export const vehicleSensorCapabilityIngestedAckV1Schema = z.object({
  schemaVersion: z.literal(1),
  eventId: identifierSchema,
  gatewayId: identifierSchema,
  meshNodeId: identifierSchema,
  capabilityRevision: positiveSafeIntegerSchema,
  reportPayloadHash: payloadHashSchema,
  status: z.enum(["applied", "stale", "duplicate", "rejected"]),
  errorCode: z.string().trim().min(1).nullable(),
  ingestedAt: z.string().datetime({ offset: true })
}).strict();
