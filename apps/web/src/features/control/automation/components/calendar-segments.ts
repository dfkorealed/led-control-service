export interface CalendarWeekSegment {
  week: number;
  start: number;
  end: number;
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
function dateEpoch(date: string) {
  const epoch = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== date) {
    throw new Error("invalid calendar date");
  }
  return epoch;
}
export function calendarAddDays(date: string, days: number) {
  return new Date(dateEpoch(date) + days * DAY_MS).toISOString().slice(0, 10);
}
export function calendarMonthRange(month: string) {
  const first = `${month}-01`;
  const epoch = dateEpoch(first);
  const next = new Date(epoch);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(next.getTime() - DAY_MS);
  return { from: calendarAddDays(first, -new Date(epoch).getUTCDay()),
    to: calendarAddDays(last.toISOString().slice(0, 10), 6 - last.getUTCDay()) };
}
export function calendarMoveMonth(month: string, delta: number) {
  const date = new Date(dateEpoch(`${month}-01`));
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}
export function calendarMonthInTimeZone(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find(part => part.type === "year")!.value.padStart(4, "0")}-${parts.find(part => part.type === "month")!.value}`;
}

/** Only segment server-projected start dates; never infer recurrence or fill excluded holes. */
export function calendarWeekSegments(dates: readonly string[], rangeStart: string): CalendarWeekSegment[] {
  const origin = dateEpoch(rangeStart);
  const unique = [...new Set(dates)].sort();
  const segments: CalendarWeekSegment[] = [];
  for (const date of unique) {
    const offset = (dateEpoch(date) - origin) / DAY_MS;
    if (offset < 0) throw new Error("calendar date precedes range");
    const week = Math.floor(offset / 7), column = offset % 7;
    const previous = segments.at(-1);
    if (previous && previous.week === week && calendarAddDays(previous.to, 1) === date) {
      previous.end = column; previous.to = date;
    } else segments.push({ week, start: column, end: column, from: date, to: date });
  }
  return segments;
}
