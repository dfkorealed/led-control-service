import { Temporal } from "@js-temporal/polyfill";
import type { HolidayDatasetSnapshot, LightingScheduleSnapshot, ScheduleCalendarOccurrence } from "@led-control/shared";
import { iterateScheduleOccurrences } from "./recurrence";

export function projectScheduleCalendar(input: {
  rules: readonly LightingScheduleSnapshot[];
  from: string;
  to: string;
  timeZone: string;
  datasets: readonly HolidayDatasetSnapshot[];
}): ScheduleCalendarOccurrence[] {
  const firstDate = Temporal.PlainDate.from(input.from);
  const lastDate = Temporal.PlainDate.from(input.to);
  const days = firstDate.until(lastDate).days + 1;
  if (days < 1 || days > 42) {
    throw new RangeError("Inclusive calendar range must be 1 to 42 days");
  }

  const occurrences: ScheduleCalendarOccurrence[] = [];
  for (const rule of input.rules) {
    // Calendar membership follows the original execution start date. An
    // overnight/DST spill end remains intact even beyond the final view date.
    for (const occurrence of iterateScheduleOccurrences(rule, firstDate, lastDate, input.timeZone, input.datasets)) {
      occurrences.push({
        scheduleId: rule.id,
        key: occurrence.key,
        localDate: occurrence.localDate,
        startsAt: new Date(occurrence.startsAtEpochMs).toISOString(),
        endsAt: new Date(occurrence.endsAtEpochMs).toISOString()
      });
    }
  }
  return occurrences.sort((left, right) => {
    if (left.startsAt !== right.startsAt) return left.startsAt < right.startsAt ? -1 : 1;
    if (left.scheduleId !== right.scheduleId) return left.scheduleId < right.scheduleId ? -1 : 1;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
}
