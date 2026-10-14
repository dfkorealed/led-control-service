import { z } from "zod";
import { lightingScheduleSnapshotV1Schema, lightingScheduleSnapshotV3Schema } from "./automation-contracts.js";

/** Dates are local civil dates, not UTC instants. Invalid month/day rollover is rejected. */
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}, "valid civil date required");
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nameSchema = z.string().trim().min(1);
export const holidayDatasetSnapshotSchema = z.object({
  country: z.literal("KR"), source: z.literal("kasi"), year: z.number().int().min(1).max(9999),
  revision: nameSchema, fetchedAt: z.string().datetime(), coverageFrom: dateSchema, coverageUntil: dateSchema,
  payloadHash: hashSchema, dates: z.array(z.object({ date: dateSchema, names: z.array(nameSchema).min(1)
    .refine(names => new Set(names).size === names.length, "holiday names must be unique") }).strict())
}).strict().superRefine((dataset, context) => {
  const year = String(dataset.year).padStart(4, "0");
  if (dataset.coverageFrom !== `${year}-01-01` || dataset.coverageUntil !== `${year}-12-31`) {
    context.addIssue({ code: "custom", path: ["coverageFrom"], message: "complete year coverage required" });
  }
  if (new Set(dataset.dates.map(entry => entry.date)).size !== dataset.dates.length
    || dataset.dates.some(entry => !entry.date.startsWith(`${year}-`))) {
    context.addIssue({ code: "custom", path: ["dates"], message: "unique holidays in covered year required" });
  }
});

export const scheduleCalendarOccurrenceSchema = z.object({ scheduleId: z.string().uuid(), key: nameSchema,
  localDate: dateSchema, startsAt: z.string().datetime(), endsAt: z.string().datetime()
}).strict().refine(value => Date.parse(value.endsAt) > Date.parse(value.startsAt), "occurrence end must follow start");
export const scheduleCalendarResponseSchema = z.object({
  from: dateSchema, to: dateSchema, timeZone: nameSchema.refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "valid IANA time zone required"), complete: z.literal(true), revisionKey: hashSchema,
  holidayCoverage: z.array(holidayDatasetSnapshotSchema),
  // Lazy boundary avoids a module initialization cycle with V3 holiday datasets.
  schedules: z.array(z.lazy(() => z.union([lightingScheduleSnapshotV1Schema, lightingScheduleSnapshotV3Schema]))),
  occurrences: z.array(scheduleCalendarOccurrenceSchema)
}).strict().superRefine((calendar, context) => {
  const span = (Date.parse(`${calendar.to}T00:00:00Z`) - Date.parse(`${calendar.from}T00:00:00Z`)) / 86400000 + 1;
  const scheduleIds = new Set(calendar.schedules.map(schedule => schedule.id));
  const occurrenceIds = calendar.occurrences.map(occurrence => `${occurrence.scheduleId}:${occurrence.key}`);
  if (span < 1 || span > 42) context.addIssue({ code: "custom", path: ["to"], message: "inclusive calendar range must be 1 to 42 days" });
  if (scheduleIds.size !== calendar.schedules.length || new Set(occurrenceIds).size !== occurrenceIds.length
    || new Set(calendar.holidayCoverage.map(dataset => dataset.year)).size !== calendar.holidayCoverage.length) {
    context.addIssue({ code: "custom", message: "duplicate projection identity" });
  }
  calendar.occurrences.forEach((occurrence, index) => {
    if (!scheduleIds.has(occurrence.scheduleId) || occurrence.localDate < calendar.from || occurrence.localDate > calendar.to) {
      context.addIssue({ code: "custom", path: ["occurrences", index], message: "occurrence must belong to projected schedule and date range" });
    }
  });
});
export type HolidayDatasetSnapshot = z.infer<typeof holidayDatasetSnapshotSchema>;
export type ScheduleCalendarOccurrence = z.infer<typeof scheduleCalendarOccurrenceSchema>;
export type ScheduleCalendarResponse = z.infer<typeof scheduleCalendarResponseSchema>;
