import { Temporal } from "@js-temporal/polyfill";
import type { HolidayDatasetSnapshot, LightingScheduleSnapshot } from "@led-control/shared";

export function evaluateScheduleStartDate(
  rule: LightingScheduleSnapshot,
  date: string,
  timeZone: string,
  datasets: readonly HolidayDatasetSnapshot[]
): { allowed: boolean; reason: "weekend" | "holiday" | "coverage_unknown" | null } {
  const excludeWeekends = "excludeWeekends" in rule && rule.excludeWeekends;
  const excludeHolidays = "excludeHolidays" in rule && rule.excludeHolidays;
  if (!excludeWeekends && !excludeHolidays) {
    return { allowed: true, reason: null };
  }

  const startDate = Temporal.PlainDate.from(date);
  if (excludeWeekends && startDate.dayOfWeek >= 6) {
    return { allowed: false, reason: "weekend" };
  }
  if (!excludeHolidays) {
    return { allowed: true, reason: null };
  }

  // API cache and accepted Gateway V3 validate canonical content/hash before
  // this boundary. Missing, ambiguous or partial coverage never means weekday.
  const matching = datasets.filter(dataset => dataset.year === startDate.year);
  const dataset = matching.length === 1 ? matching[0] : undefined;
  const year = String(startDate.year).padStart(4, "0");
  if (timeZone !== "Asia/Seoul" || dataset === undefined
    || dataset.country !== "KR" || dataset.source !== "kasi"
    || dataset.coverageFrom !== `${year}-01-01` || dataset.coverageUntil !== `${year}-12-31`) {
    return { allowed: false, reason: "coverage_unknown" };
  }
  if (dataset.dates.some(holiday => holiday.date === date)) {
    return { allowed: false, reason: "holiday" };
  }
  return { allowed: true, reason: null };
}
