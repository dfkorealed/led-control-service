import { parseDate, parseTime, toCalendarDate, type CalendarDate, type Time } from "@internationalized/date";
import type { DateValue, TimeValue } from "react-aria-components";

export interface DateRangeValue { start: string; end: string }

/** Domain boundaries accept canonical date-only/local minute strings, never timestamps. */
export function parseIsoDate(value: string): CalendarDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("Expected YYYY-MM-DD");
  return parseDate(value);
}
export function formatIsoDate(value: DateValue): string { return toCalendarDate(value).toString(); }
export function parseLocalTime(value: string): Time {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new RangeError("Expected HH:mm");
  return parseTime(value);
}
export function formatLocalTime(value: TimeValue): string {
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

export function parseBounds<T extends { compare(other: T): number }>(min: string | undefined, max: string | undefined, parse: (value: string) => T) {
  const minValue = min === undefined ? undefined : parse(min);
  const maxValue = max === undefined ? undefined : parse(max);
  if (minValue && maxValue && minValue.compare(maxValue) > 0) throw new RangeError("minValue must not exceed maxValue");
  return { minValue, maxValue };
}
export function parseDateRange(value: DateRangeValue | null) {
  if (value === null) return null;
  const start = parseIsoDate(value.start);
  const end = parseIsoDate(value.end);
  // A reversed pair is a valid editing state, not a malformed string. React
  // Aria reports it as invalid so the user can finish editing the other end.
  return { start, end };
}
