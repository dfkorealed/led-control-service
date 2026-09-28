import { z } from "zod";
import { energyHeatmapMetricSchema, energyScopeSchema } from "./energy-p2-contracts.js";
import { energyRangeComparisonQuerySchema } from "./energy-range-contracts.js";

const dateRangeShape = energyRangeComparisonQuerySchema.innerType().shape;

export const energyObservedMeanQuerySchema = z.object({
  scope: energyScopeSchema,
  identityId: z.string().uuid(),
  metric: energyHeatmapMetricSchema,
  ...dateRangeShape
}).strict().superRefine((query, context) => {
  const range = energyRangeComparisonQuerySchema.safeParse({ from: query.from, to: query.to });
  if (!range.success) {
    for (const issue of range.error.issues) context.addIssue(issue);
  }
});

const cellSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  value: z.number().finite().nonnegative().nullable(),
  knownSeconds: z.number().int().nonnegative(),
  expectedSeconds: z.number().int().nonnegative(),
  observedLocalDays: z.number().int().nonnegative(),
  eligibleLocalDays: z.number().int().nonnegative(),
  coverageRate: z.number().min(0).max(1).nullable()
}).strict().superRefine((cell, context) => {
  if (cell.knownSeconds > cell.expectedSeconds || cell.observedLocalDays > cell.eligibleLocalDays) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "observed coverage cannot exceed expected coverage" });
  }
  if (cell.value !== null && (cell.expectedSeconds === 0 || cell.knownSeconds !== cell.expectedSeconds)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "value requires complete observation" });
  }
  const expectedCoverage = cell.expectedSeconds === 0 ? null : cell.knownSeconds / cell.expectedSeconds;
  if (expectedCoverage === null ? cell.coverageRate !== null : cell.coverageRate === null || Math.abs(cell.coverageRate - expectedCoverage) > 1e-9) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverageRate"], message: "coverage must match seconds" });
  }
});

export const energyObservedMeanResponseSchema = z.object({
  siteId: z.string().uuid(),
  timeZone: z.string().min(1),
  generatedAt: z.string().datetime(),
  metric: energyHeatmapMetricSchema,
  scope: energyScopeSchema,
  identityId: z.string().uuid(),
  range: z.object({ from: z.string().date(), to: z.string().date() }).strict(),
  cells: z.array(cellSchema).length(168)
}).strict().superRefine((response, context) => {
  const query = energyObservedMeanQuerySchema.safeParse({
    scope: response.scope, identityId: response.identityId, metric: response.metric,
    from: response.range.from, to: response.range.to
  });
  if (!query.success) {
    for (const issue of query.error.issues) context.addIssue({ ...issue, path: ["range", ...issue.path] });
  }
  response.cells.forEach((cell, index) => {
    if (cell.weekday !== Math.floor(index / 24) || cell.hour !== index % 24) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["cells", index], message: "cells must be ordered by weekday and hour" });
    }
  });
});

export type EnergyObservedMeanQuery = z.infer<typeof energyObservedMeanQuerySchema>;
export type EnergyObservedMeanResponse = z.infer<typeof energyObservedMeanResponseSchema>;
