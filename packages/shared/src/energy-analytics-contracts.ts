import { z } from "zod";
import { energyDataStatusSchema, energySourceSchema } from "./schemas.js";

const calendarDateSchema = z.string().date();
const durationSecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const nullableEnergySchema = z.number().nonnegative().nullable();

export const energyRankingDimensionSchema = z.enum(["fixture", "floor", "group"]);
export const energyRankingMetricSchema = z.enum(["usage", "cost", "contribution", "per_fixture_average"]);
export const energyRankingSortSchema = z.enum(["desc", "asc"]);
export const energyHistoryQualitySchema = z.enum(["observed", "legacy_structure_unknown"]);

export const energyRankingQuerySchema = z.object({
  dimension: energyRankingDimensionSchema,
  metric: energyRankingMetricSchema,
  from: calendarDateSchema,
  to: calendarDateSchema,
  sort: energyRankingSortSchema.default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(10)
}).strict().superRefine((query, context) => {
  const from = Date.parse(`${query.from}T00:00:00.000Z`);
  const to = Date.parse(`${query.to}T00:00:00.000Z`);
  if (from > to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "range must not end before it starts" });
    return;
  }
  const inclusiveDays = Math.floor((to - from) / 86_400_000) + 1;
  if (inclusiveDays > 400) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "range must not exceed 400 days" });
  }
});

const dailyPointSchema = z.object({
  period: calendarDateSchema,
  estimatedKwh: nullableEnergySchema,
  dataStatus: energyDataStatusSchema
}).strict();

const fixtureBreakdownSchema = z.object({
  identityId: z.string().uuid(),
  name: z.string().min(1),
  estimatedKwh: nullableEnergySchema
}).strict();

const previousPeriodSchema = z.object({
  estimatedKwh: nullableEnergySchema,
  changeRatePercent: z.number().nullable(),
  rank: z.number().int().positive().nullable()
}).strict();

const rankingItemSchema = z.object({
  identityId: z.string().uuid(),
  operationalId: z.string().uuid().nullable(),
  name: z.string().min(1),
  rank: z.number().int().positive().nullable(),
  fixtureCount: z.number().int().min(0),
  estimatedKwh: nullableEnergySchema,
  estimatedCost: nullableEnergySchema,
  contributionRate: z.number().min(0).max(1).nullable(),
  perFixtureAverageKwh: nullableEnergySchema,
  metricValue: nullableEnergySchema,
  knownSeconds: durationSecondsSchema,
  unknownSeconds: durationSecondsSchema,
  coverageRate: z.number().min(0).max(1).nullable(),
  dataStatus: energyDataStatusSchema,
  historyQuality: energyHistoryQualitySchema,
  unrankedReason: z.enum(["insufficient_coverage", "legacy_structure_unknown"]).nullable(),
  previousPeriod: previousPeriodSchema.nullable(),
  dailyPoints: z.array(dailyPointSchema).max(400),
  fixtures: z.array(fixtureBreakdownSchema).max(1000)
}).strict();

const rankedItemSchema = rankingItemSchema.superRefine((item, context) => {
  if (item.rank === null || item.metricValue === null || item.unrankedReason !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ranked items require rank and metric value without an unranked reason" });
  }
});

const unrankedItemSchema = rankingItemSchema.superRefine((item, context) => {
  if (item.rank !== null || item.metricValue !== null || item.unrankedReason === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "unranked items require a reason and must not expose rank or metric value" });
  }
});

export const energyRankingResponseSchema = z.object({
  siteId: z.string().uuid(),
  timeZone: z.string().min(1),
  source: energySourceSchema,
  generatedAt: z.string().datetime(),
  dimension: energyRankingDimensionSchema,
  metric: energyRankingMetricSchema,
  sort: energyRankingSortSchema,
  range: z.object({ from: calendarDateSchema, to: calendarDateSchema }).strict(),
  siteTotalKwh: z.number().nonnegative(),
  siteTotalCost: z.number().nonnegative(),
  overlappingMemberships: z.boolean(),
  legacyExcludedBefore: calendarDateSchema.nullable(),
  ranked: z.array(rankedItemSchema).max(100),
  unranked: z.array(unrankedItemSchema).max(1000)
}).strict();

export type EnergyRankingDimension = z.infer<typeof energyRankingDimensionSchema>;
export type EnergyRankingMetric = z.infer<typeof energyRankingMetricSchema>;
export type EnergyRankingSort = z.infer<typeof energyRankingSortSchema>;
export type EnergyRankingQuery = z.infer<typeof energyRankingQuerySchema>;
export type EnergyRankingResponse = z.infer<typeof energyRankingResponseSchema>;
export type EnergyRankingItem = z.infer<typeof rankingItemSchema>;
