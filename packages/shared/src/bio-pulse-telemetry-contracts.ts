import { z } from "zod";
import { automationExecutionEventV1Schema, automationExecutionIngestedAckV1Schema, type AutomationExecutionEventV1 } from "./automation-contracts";

const id = z.string().uuid();
const timestamp = z.string().datetime();
const protocol = z.literal("bio-usb-pulse");
const targets = z.array(id).min(1).max(10000).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length);
const releaseReason = z.enum(["operator_release", "hold_expired", "configuration_changed"]);
const configuration = z.object({ configuredHighBrightnessPercent: z.number().int().min(0).max(100),
  bioMode: z.enum(["sensor", "force-on", "force-off"]) }).strict();
const result = z.object({ fixtureId: id, status: z.enum(["pending", "succeeded", "failed", "timed_out", "superseded"]),
  configuration: configuration.nullable() }).strict().superRefine((value, context) => {
  if ((value.status === "succeeded" && value.configuration === null) ||
    ((value.status === "pending" || value.status === "superseded") && value.configuration !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "configuration must match verification status" });
  }
});
const results = z.array(result).min(1).max(10000)
  .refine(values => new Set(values.map(value => value.fixtureId.toLowerCase())).size === values.length);
const pulse = z.object({ sensorProtocol: protocol, sourceFixtureId: id, inputType: z.literal("pulse") }).strict();
const extendedPulse = pulse.extend({ holdUntil: timestamp, brightnessPercent: z.number().int().min(0).max(100), targetFixtureIds: targets }).strict();
const health = z.object({ sensorProtocol: protocol, reason: z.enum(["bio_source_degraded", "bio_health_recovered"]),
  health: z.enum(["healthy", "degraded", "unverified"]),
  healthReason: z.enum(["qualified", "usb_disconnected", "identity_changed", "liveness_failed", "decoder_failed",
    "fingerprint_changed", "connection_changed", "health_unverified"]),
  targetFixtureIds: targets, restorationPending: z.literal(true).optional(), holdUntil: timestamp.optional()
}).strict().superRefine((value, context) => {
  if ((value.reason === "bio_health_recovered") !== (value.health === "healthy") ||
    (value.health === "healthy") !== (value.healthReason === "qualified")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "health and reason must agree" });
  }
});
const releasePending = z.object({ sensorProtocol: protocol, reason: z.literal("bio_release_pending"),
  releaseReason, restorationPending: z.literal(true), targetFixtureIds: targets }).strict();
const revived = z.object({ sensorProtocol: protocol,
  reason: z.enum(["bio_completed_release_reopened", "bio_automatic_release_cancelled"]),
  targetFixtureIds: targets, previousRestores: z.array(result).max(10000), restorationPending: z.literal(false) }).strict();
const ended = z.object({ sensorProtocol: protocol, reason: releaseReason, targetFixtureIds: targets,
  restorationPending: z.literal(false) }).strict();
const action = z.object({ sensorProtocol: protocol, verification: z.literal("configuration_readback"),
  phase: z.enum(["apply", "restore"]), results }).strict();
const payloadSchemas = {
  vehicle_detected: pulse, event_started: extendedPulse, event_extended: z.union([extendedPulse, health, releasePending, revived]),
  event_ended: ended, action_result: action
};
const recordShape = { revision: z.number().int().nonnegative().safe(), ruleId: id,
  occurrenceKey: z.string().min(1).max(512), kind: z.enum(["vehicle_detected", "event_started", "event_extended", "event_ended", "action_result"]),
  occurredAt: timestamp, payload: z.record(z.unknown()) };
function validatePayload(value: { kind: keyof typeof payloadSchemas; payload: Record<string, unknown> }, context: z.RefinementCtx) {
  if (!payloadSchemas[value.kind].safeParse(value.payload).success) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["payload"], message: "invalid redacted BIO telemetry payload" });
  }
}

/** Validate before journaling. Configuration GET is not optical output or power. */
export const bioPulseTelemetryRecordV2Schema = z.object(recordShape).strict().superRefine(validatePayload);
export const bioPulseExecutionEventV2Schema = z.object({ schemaVersion: z.literal(2), eventId: id,
  assignmentVersion: z.number().int().positive().safe(),
  sequence: z.number().int().nonnegative().safe(), gatewayId: id, ...recordShape }).strict().superRefine(validatePayload);
export type BioPulseExecutionEventV2 = z.infer<typeof bioPulseExecutionEventV2Schema>;
export type AutomationExecutionEvent = AutomationExecutionEventV1 | BioPulseExecutionEventV2;
export const automationExecutionEventSchema = z.union([automationExecutionEventV1Schema, bioPulseExecutionEventV2Schema]);

export const bioPulseExecutionIngestedAckV2Schema = automationExecutionIngestedAckV1Schema.extend({
  schemaVersion: z.literal(2), assignmentVersion: z.number().int().positive().safe(),
  sequence: z.number().int().nonnegative().safe()
}).strict();
export const automationExecutionIngestedAckSchema = z.union([
  automationExecutionIngestedAckV1Schema, bioPulseExecutionIngestedAckV2Schema
]);
