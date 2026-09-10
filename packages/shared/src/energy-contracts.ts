import { z } from "zod";
import { energyDataStatusSchema, energySourceSchema } from "./schemas";

const durationSecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const coverageRateSchema = z.number().min(0).max(1).nullable();
const calendarDateSchema = z.string().date();
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const energyComparisonPresetSchema = z.enum(["last_7_days", "current_month", "current_year"]);

export const energyComparisonPointSchema = z.object({
  period: z.string().min(1),
  baselineKwh: z.number().nonnegative(),
  estimatedKwh: z.number().nonnegative().nullable(),
  phase: z.enum(["observed", "forecast", "unavailable"]),
  knownSeconds: durationSecondsSchema,
  unknownSeconds: durationSecondsSchema,
  coverageRate: coverageRateSchema,
  dataStatus: energyDataStatusSchema
}).strict().superRefine((point, context) => {
  if (point.phase === "unavailable" && point.estimatedKwh !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["estimatedKwh"],
      message: "unavailable points must not contain an energy estimate"
    });
  }
  if (point.phase !== "unavailable" && point.estimatedKwh === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["estimatedKwh"],
      message: "observed and forecast points require an energy estimate"
    });
  }
});

const comparisonRangeSchema = z.object({
  from: calendarDateSchema,
  to: calendarDateSchema
}).strict().refine((range) => range.from <= range.to, {
  path: ["to"],
  message: "range must not end before it starts"
});

const energyComparisonSummarySchema = z.object({
  baselineKwh: z.number().nonnegative(),
  estimatedKwh: z.number().nonnegative().nullable(),
  savingsKwh: z.number().nullable(),
  savingsCost: z.number().nullable(),
  savingsRatePercent: z.number().nullable(),
  outcome: z.enum(["saving", "overuse", "unavailable"]),
  forecastReason: z.enum(["available", "insufficient_state", "no_registered_fixture", "not_applicable"])
}).strict().superRefine((summary, context) => {
  const savingsValues = [summary.savingsKwh, summary.savingsCost, summary.savingsRatePercent];
  if (summary.outcome === "unavailable") {
    if (summary.estimatedKwh !== null || savingsValues.some((value) => value !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "unavailable comparisons must not contain estimate or savings values"
      });
    }
    return;
  }

  if (summary.estimatedKwh === null || savingsValues.some((value) => value === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: `${summary.outcome} comparisons require estimate and savings values`
    });
    return;
  }

  const numericSavings = savingsValues as number[];
  const signMatches = summary.outcome === "saving"
    ? numericSavings.every((value) => value >= 0)
    : numericSavings.every((value) => value < 0);
  if (!signMatches) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: `savings values do not match the ${summary.outcome} outcome`
    });
  }
});

const priorComparisonSchema = z.object({
  kind: z.enum(["previous_period", "previous_year"]),
  currentRange: comparisonRangeSchema,
  comparisonRange: comparisonRangeSchema,
  currentKwh: z.number().nonnegative().nullable(),
  comparisonKwh: z.number().nonnegative().nullable(),
  changeRatePercent: z.number().nullable(),
  currentCoverageRate: coverageRateSchema,
  comparisonCoverageRate: coverageRateSchema,
  historyQuality: z.literal("legacy_structure_unknown")
}).strict().superRefine((comparison, context) => {
  const canCalculate = comparison.currentKwh !== null
    && comparison.comparisonKwh !== null
    && comparison.comparisonKwh !== 0;
  if (canCalculate === (comparison.changeRatePercent === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["changeRatePercent"],
      message: canCalculate
        ? "change rate is required when both periods contain comparable energy"
        : "change rate must be null without a non-zero comparison period"
    });
  }
});

export const energyComparisonResponseSchema = z.object({
  siteId: z.string().uuid(),
  timeZone: z.string().min(1),
  source: energySourceSchema,
  generatedAt: z.string().datetime(),
  preset: energyComparisonPresetSchema,
  range: z.object({
    from: calendarDateSchema,
    to: calendarDateSchema,
    completedThrough: calendarDateSchema
  }).strict(),
  summary: energyComparisonSummarySchema,
  priorComparisons: z.array(priorComparisonSchema).max(2),
  points: z.array(energyComparisonPointSchema)
}).strict().superRefine((response, context) => {
  const periodSchema = response.preset === "current_year" ? monthSchema : calendarDateSchema;
  response.points.forEach((point, index) => {
    if (!periodSchema.safeParse(point.period).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points", index, "period"],
        message: response.preset === "current_year"
          ? "current year points must use YYYY-MM"
          : "daily comparison points must use YYYY-MM-DD"
      });
    }
  });
  if (response.preset !== "current_month" && response.summary.forecastReason !== "not_applicable") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary", "forecastReason"],
      message: "forecast is only applicable to the current month preset"
    });
  }
});

export type EnergyComparisonPreset = z.infer<typeof energyComparisonPresetSchema>;
export type EnergyComparisonPoint = z.infer<typeof energyComparisonPointSchema>;
export type EnergyComparisonResponse = z.infer<typeof energyComparisonResponseSchema>;
