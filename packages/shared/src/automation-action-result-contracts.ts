import { z } from "zod";

export interface AutomationExecutionFixtureResultV1 {
  fixtureId: string;
  status: "succeeded" | "failed" | "timed_out";
  brightnessPercent: number | null;
  faultCode: string | null;
  errorCode: string | null;
  occurredAt: string;
}

export interface AutomationExecutionActionResultPayloadV1 {
  sourceType: "schedule" | "vehicle_event_rule" | "manual_override";
  sourceId: string;
  results: AutomationExecutionFixtureResultV1[];
}

const identifierSchema = z.string().uuid();
const timestampSchema = z.string().datetime();

export const automationExecutionFixtureResultV1Schema = z.object({
  fixtureId: identifierSchema,
  status: z.enum(["succeeded", "failed", "timed_out"]),
  brightnessPercent: z.number().int().min(0).max(100).nullable(),
  faultCode: z.string().trim().min(1).max(128).nullable(),
  errorCode: z.string().trim().min(1).max(128).nullable(),
  occurredAt: timestampSchema
}).strict();

export const automationExecutionActionResultPayloadV1Schema = z.object({
  sourceType: z.enum(["schedule", "vehicle_event_rule", "manual_override"]),
  sourceId: identifierSchema,
  results: z.array(automationExecutionFixtureResultV1Schema).min(1)
}).strict().superRefine((payload, context) => {
  const fixtureIds = payload.results.map((result) => result.fixtureId);
  if (new Set(fixtureIds).size !== fixtureIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["results"],
      message: "action results must contain unique fixture IDs"
    });
  }
});
