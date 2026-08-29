import { z } from "zod";

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

export interface AutomationConfigAppliedV1 {
  schemaVersion: 1;
  gatewayId: string;
  revision: number;
  payloadHash: `sha256:${string}`;
  status: "applied" | "rejected";
  errorCode: string | null;
  appliedAt: string;
}

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
  eventId: string;
  sequence: number;
  ingestedAt: string;
}

export interface ManualOverrideWindow {
  fixtureIds: string[];
  brightnessPercent: number;
  startedAt: string;
  overrideUntil: string;
}

const identifierSchema = z.string().uuid();
const timestampSchema = z.string().datetime();
const payloadHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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

export const automationConfigAppliedV1Schema = z.object({
  schemaVersion: z.literal(1),
  gatewayId: identifierSchema,
  revision: z.number().int().nonnegative(),
  payloadHash: payloadHashSchema,
  status: z.enum(["applied", "rejected"]),
  errorCode: z.string().trim().min(1).nullable(),
  appliedAt: timestampSchema
}).strict().superRefine((configuration, context) => {
  if (configuration.status === "applied" && configuration.errorCode !== null) {
    addIssue(context, "errorCode", "applied configuration cannot include an errorCode");
  }
  if (configuration.status === "rejected" && configuration.errorCode === null) {
    addIssue(context, "errorCode", "rejected configuration requires an errorCode");
  }
});

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
}).strict();

export const automationExecutionIngestedAckV1Schema = z.object({
  eventId: identifierSchema,
  sequence: z.number().int().nonnegative(),
  ingestedAt: timestampSchema
}).strict();

export const manualOverrideWindowSchema = z.object({
  fixtureIds: fixtureIdsSchema,
  brightnessPercent: z.number().int().min(0).max(100),
  startedAt: timestampSchema,
  overrideUntil: timestampSchema
}).strict().superRefine((override, context) => {
  if (Date.parse(override.startedAt) >= Date.parse(override.overrideUntil)) {
    addIssue(context, "overrideUntil", "overrideUntil must be after startedAt");
  }
});
