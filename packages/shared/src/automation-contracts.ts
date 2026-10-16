import { z } from "zod";
import { automationExecutionActionResultPayloadV1Schema } from "./automation-action-result-contracts.js";
import { holidayDatasetSnapshotSchema, type HolidayDatasetSnapshot } from "./holiday-calendar-contracts.js";

export {
  automationExecutionActionResultPayloadV1Schema,
  automationExecutionFixtureResultV1Schema
} from "./automation-action-result-contracts.js";
export type {
  AutomationExecutionActionResultPayloadV1,
  AutomationExecutionFixtureResultV1
} from "./automation-action-result-contracts.js";

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

/** Omitted for old rules/wire peers; only V3 may explicitly configure native self control. */
export interface VehicleEventRuleSnapshotV3 extends VehicleEventRuleSnapshotV2 {
  selfControlEnabled?: boolean;
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

export type LightingScheduleSnapshotV3 = LightingScheduleSnapshotV1 & { excludeWeekends: boolean; excludeHolidays: boolean };
export type LightingScheduleSnapshot = LightingScheduleSnapshotV1 | LightingScheduleSnapshotV3;
export type AutomationSnapshotV3 = Omit<AutomationSnapshotV2, "schemaVersion" | "schedules" | "vehicleEventRules"> & {
  schemaVersion: 3; schedules: LightingScheduleSnapshotV3[]; holidayDatasets: HolidayDatasetSnapshot[]; vehicleEventRules: VehicleEventRuleSnapshotV3[];
};
export type AutomationCurrentConfigRequestV3 = Omit<AutomationCurrentConfigRequestV2, "schemaVersion" | "maxSnapshotVersion"> & {
  schemaVersion: 3; maxSnapshotVersion: 3; temporaryControlVersion: 1; bioConfigurationReadback: true; durableFixtureLease: true; bioNativeSelfControlVersion?: 1;
};
export type AutomationConfigAppliedV3 = Omit<AutomationConfigAppliedV2, "schemaVersion"> & { schemaVersion: 3 };
export type AutomationConfigAppliedDeliveryV3 = Omit<AutomationConfigAppliedDeliveryV2, "schemaVersion" | "acknowledgement"> & {
  schemaVersion: 3; acknowledgement: AutomationConfigAppliedV3;
};
export type AutomationConfigAppliedReceiptV3 = AutomationConfigAppliedDeliveryV3 & { ingestedAt: string };
export type AutomationSnapshot = AutomationSnapshotV1 | AutomationSnapshotV2 | AutomationSnapshotV3;
export type AutomationConfigApplied = AutomationConfigAppliedV1 | AutomationConfigAppliedV2 | AutomationConfigAppliedV3;
export type AutomationConfigAppliedDelivery = AutomationConfigAppliedDeliveryV1 | AutomationConfigAppliedDeliveryV2 | AutomationConfigAppliedDeliveryV3;
export type AutomationConfigAppliedReceipt = AutomationConfigAppliedReceiptV1 | AutomationConfigAppliedReceiptV2 | AutomationConfigAppliedReceiptV3;
export type AutomationCurrentConfigRequest = AutomationCurrentConfigRequestV1 | AutomationCurrentConfigRequestV2 | AutomationCurrentConfigRequestV3;

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

/** Assignment-bound transport for existing BIO qualification evidence, not live health or enablement. */
export interface VehicleSensorCapabilityDeliveryV2 {
  schemaVersion: 2;
  assignmentVersion: number;
  report: VehicleSensorCapabilityReportV2;
}

export interface VehicleSensorCapabilityIngestedAckV2 {
  schemaVersion: 2;
  siteId: string;
  gatewayId: string;
  assignmentVersion: number;
  eventId: string;
  meshNodeId: string;
  capabilityRevision: number;
  /** Canonical hash of the complete delivery envelope, including assignmentVersion. */
  deliveryPayloadHash: `sha256:${string}`;
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

export const lightingScheduleSnapshotV3Schema = lightingScheduleSnapshotV1Schema.innerType().extend({
  excludeWeekends: z.boolean(), excludeHolidays: z.boolean()
}).strict().superRefine((schedule, context) => {
  // Preserve V1 time/recurrence checks while requiring both explicit exclusion flags.
  const { excludeWeekends: _weekends, excludeHolidays: _holidays, ...legacy } = schedule;
  const parsed = lightingScheduleSnapshotV1Schema.safeParse(legacy);
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue(issue);
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
  holdSeconds: z.number().int().min(1).max(1_800),
  sensorProtocol: z.enum(["bluez-stateful", "bio-usb-pulse"])
}).strict().superRefine((rule, context) => {
  // BIO supports a one-second service hold; preserve the legacy stateful floor.
  // Short pulse holds may expire between detections; do not silently lengthen them.
  if (rule.sensorProtocol === "bluez-stateful" && rule.holdSeconds < 5) {
    addIssue(context, "holdSeconds", "BlueZ stateful holdSeconds must be at least 5");
  }
});

export const vehicleEventRuleSnapshotV3Schema = vehicleEventRuleSnapshotV2Schema.innerType().extend({
  selfControlEnabled: z.boolean().optional(),
  targetFixtureIds: z.array(identifierSchema)
}).strict().superRefine((rule, context) => {
  if (new Set(rule.targetFixtureIds).size !== rule.targetFixtureIds.length) addIssue(context, "targetFixtureIds", "fixture IDs must be distinct");
  if (!rule.selfControlEnabled && rule.targetFixtureIds.length === 0) addIssue(context, "targetFixtureIds", "at least one output required");
  if (rule.sensorProtocol === "bluez-stateful" && rule.holdSeconds < 5) addIssue(context, "holdSeconds", "BlueZ hold must be at least 5 seconds");
  if (rule.selfControlEnabled && (rule.sensorProtocol !== "bio-usb-pulse" || rule.sourceFixtureIds.length !== 1 || rule.targetFixtureIds.some(id => rule.sourceFixtureIds.includes(id)))) {
    addIssue(context, "selfControlEnabled", "native self control requires one distinct BIO source");
  }
  if (rule.selfControlEnabled && rule.holdSeconds > 127 && rule.holdSeconds % 60 !== 0) addIssue(context, "holdSeconds", "native interval must be represented exactly");
  if (rule.selfControlEnabled && rule.action.dimmingEnabled && rule.action.brightnessPercent < 1) addIssue(context, "action", "native detection brightness must be positive");
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

export const automationSnapshotV3Schema = automationSnapshotV2Schema.extend({
  schemaVersion: z.literal(3), revision: z.number().int().nonnegative().safe(),
  vehicleEventRules: z.array(vehicleEventRuleSnapshotV3Schema),
  // Both public browser entrypoints can initialize first; resolve the cross-module
  // dataset schema at parse time rather than during ESM module evaluation.
  schedules: z.array(lightingScheduleSnapshotV3Schema), holidayDatasets: z.array(z.lazy(() => holidayDatasetSnapshotSchema))
}).strict().superRefine((snapshot, context) => {
  if (new Set(snapshot.holidayDatasets.map(dataset => dataset.year)).size !== snapshot.holidayDatasets.length) {
    addIssue(context, "holidayDatasets", "one complete revision per holiday year required");
  }
  if (snapshot.timeZone !== "Asia/Seoul" && snapshot.schedules.some(schedule => schedule.excludeHolidays)) {
    addIssue(context, "timeZone", "Korean holiday exclusion requires Asia/Seoul");
  }
});

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

export const automationCurrentConfigRequestV3Schema = automationCurrentConfigRequestV2Schema.extend({
  schemaVersion: z.literal(3), maxSnapshotVersion: z.literal(3), temporaryControlVersion: z.literal(1),
  bioConfigurationReadback: z.literal(true), durableFixtureLease: z.literal(true), bioNativeSelfControlVersion: z.literal(1).optional()
}).strict();
export const automationConfigAppliedV3Schema = z.object({ schemaVersion: z.literal(3), ...automationConfigAppliedFields,
  revision: z.number().int().nonnegative().safe() }).strict().superRefine(validateAutomationConfigApplied);

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
const automationConfigAppliedDeliveryV3Shape = { ...automationConfigAppliedDeliveryShape,
  schemaVersion: z.literal(3), acknowledgement: automationConfigAppliedV3Schema };
export const automationConfigAppliedDeliveryV3Schema = z.object(automationConfigAppliedDeliveryV3Shape)
  .strict().superRefine(validateConfigDeliveryScope);
export const automationConfigAppliedReceiptV3Schema = z.object({ ...automationConfigAppliedDeliveryV3Shape,
  ingestedAt: timestampSchema }).strict().superRefine(validateConfigDeliveryScope);
export const automationSnapshotSchema = z.union([automationSnapshotV1Schema, automationSnapshotV2Schema, automationSnapshotV3Schema]);
export const automationConfigAppliedSchema = z.union([automationConfigAppliedV1Schema, automationConfigAppliedV2Schema, automationConfigAppliedV3Schema]);
export const automationConfigAppliedDeliverySchema = z.union([automationConfigAppliedDeliveryV1Schema, automationConfigAppliedDeliveryV2Schema, automationConfigAppliedDeliveryV3Schema]);
export const automationConfigAppliedReceiptSchema = z.union([automationConfigAppliedReceiptV1Schema, automationConfigAppliedReceiptV2Schema, automationConfigAppliedReceiptV3Schema]);
export const automationCurrentConfigRequestSchema = z.union([automationCurrentConfigRequestV1Schema, automationCurrentConfigRequestV2Schema, automationCurrentConfigRequestV3Schema]);

/** Attribution only: a matched rejected receipt never proves configuration was applied. */
export function matchesAutomationConfigAppliedReceiptV3(delivery: AutomationConfigAppliedDeliveryV3, receipt: AutomationConfigAppliedReceiptV3): boolean {
  const expected = automationConfigAppliedDeliveryV3Schema.safeParse(delivery);
  const actual = automationConfigAppliedReceiptV3Schema.safeParse(receipt);
  if (!expected.success || !actual.success) return false;
  const left = expected.data, right = actual.data;
  return left.siteId === right.siteId && left.gatewayId === right.gatewayId
    && left.acknowledgementId === right.acknowledgementId
    && left.acknowledgement.revision === right.acknowledgement.revision
    && left.acknowledgement.payloadHash === right.acknowledgement.payloadHash
    && left.acknowledgement.status === right.acknowledgement.status
    && left.acknowledgement.errorCode === right.acknowledgement.errorCode
    && left.acknowledgement.appliedAt === right.acknowledgement.appliedAt;
}

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

export const vehicleSensorCapabilityDeliveryV2Schema = z.object({
  schemaVersion: z.literal(2),
  assignmentVersion: positiveSafeIntegerSchema,
  report: vehicleSensorCapabilityReportV2Schema
}).strict();

export const vehicleSensorCapabilityIngestedAckV2Schema = z.object({
  schemaVersion: z.literal(2),
  siteId: identifierSchema,
  gatewayId: identifierSchema,
  assignmentVersion: positiveSafeIntegerSchema,
  eventId: identifierSchema,
  meshNodeId: identifierSchema,
  capabilityRevision: positiveSafeIntegerSchema,
  deliveryPayloadHash: payloadHashSchema,
  status: z.enum(["applied", "stale", "duplicate", "rejected"]),
  errorCode: z.string().trim().min(1).max(128).nullable(),
  ingestedAt: z.string().datetime({ offset: true })
}).strict();

/**
 * The consumer computes expectedDeliveryPayloadHash with its existing canonical hash
 * helper over the current complete envelope, not the nested report alone. This pure
 * check verifies ACK attribution only: true also covers rejected receipts and never
 * proves applied qualification, live readiness, authenticated transport or enablement.
 */
export function matchesVehicleSensorCapabilityIngestedAckV2(
  delivery: unknown,
  acknowledgement: unknown,
  expectedDeliveryPayloadHash: string
): boolean {
  const parsedDelivery = vehicleSensorCapabilityDeliveryV2Schema.safeParse(delivery);
  const parsedAck = vehicleSensorCapabilityIngestedAckV2Schema.safeParse(acknowledgement);
  if (!parsedDelivery.success || !parsedAck.success
    || !payloadHashSchema.safeParse(expectedDeliveryPayloadHash).success) return false;
  const { report, assignmentVersion } = parsedDelivery.data;
  const ack = parsedAck.data;
  return ack.siteId === report.siteId && ack.gatewayId === report.gatewayId
    && ack.assignmentVersion === assignmentVersion && ack.eventId === report.eventId
    && ack.meshNodeId === report.meshNodeId && ack.capabilityRevision === report.capabilityRevision
    && ack.deliveryPayloadHash === expectedDeliveryPayloadHash;
}
