import { z } from "zod";
import { energyComparisonResponseSchema } from "./energy-contracts.js";

const calendarDateSchema = z.string().date();
const dateRangeShape = { from: calendarDateSchema, to: calendarDateSchema };

export const energyRangeComparisonQuerySchema = z.object(dateRangeShape).strict().superRefine((range, context) => {
  const from = Date.parse(`${range.from}T00:00:00.000Z`);
  const to = Date.parse(`${range.to}T00:00:00.000Z`);
  if (from > to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "range must not end before it starts" });
  } else if (Math.floor((to - from) / 86_400_000) + 1 > 400) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "range must not exceed 400 days" });
  }
});

// Reuse the existing nested comparison contracts without changing the preset endpoint.
const legacy = energyComparisonResponseSchema.innerType().shape;
const customPriorComparisonSchema = legacy.priorComparisons.element.innerType().superRefine((comparison, context) => {
  // Custom ranges can contain observed energy without complete fixture-second coverage.
  // Keep those kWh values, but do not claim a comparable percentage for partial periods.
  const comparable = comparison.currentKwh !== null && comparison.comparisonKwh !== null &&
    comparison.comparisonKwh !== 0 && comparison.currentCoverageRate === 1 && comparison.comparisonCoverageRate === 1;
  // Coverage alone cannot prove structural comparability when a fixture began
  // tracking mid-period. The API may conservatively return null even at rate 1.
  if (comparison.changeRatePercent !== null && !comparable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["changeRatePercent"],
      message: "change rate requires complete comparable periods" });
  }
});
export const energyRangeComparisonResponseSchema = z.object({
  siteId: legacy.siteId,
  timeZone: legacy.timeZone,
  source: legacy.source,
  generatedAt: legacy.generatedAt,
  selection: z.object({ kind: z.literal("custom"), ...dateRangeShape }).strict(),
  range: legacy.range,
  summary: legacy.summary,
  priorComparisons: z.array(customPriorComparisonSchema).max(2),
  points: legacy.points
}).strict().superRefine((response, context) => {
  if (response.summary.forecastReason !== "not_applicable") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["summary", "forecastReason"], message: "custom range has no forecast" });
  }
  if (response.selection.from !== response.range.from || response.selection.to !== response.range.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["range"], message: "range must match selection" });
  }
  if (response.range.completedThrough < response.range.from || response.range.completedThrough > response.range.to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["range", "completedThrough"], message: "completed date must belong to range" });
  }
  const dates = energyRangeComparisonQuerySchema.safeParse({ from: response.selection.from, to: response.selection.to });
  if (!dates.success) {
    for (const issue of dates.error.issues) context.addIssue({ ...issue, path: ["selection", ...issue.path] });
  }
});

export type EnergyRangeComparisonQuery = z.infer<typeof energyRangeComparisonQuerySchema>;
export type EnergyRangeComparisonResponse = z.infer<typeof energyRangeComparisonResponseSchema>;
