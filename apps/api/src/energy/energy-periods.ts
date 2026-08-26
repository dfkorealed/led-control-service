export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export function parseCalendarDate(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("date must use YYYY-MM-DD");
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const checked = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    checked.getUTCFullYear() !== date.year ||
    checked.getUTCMonth() + 1 !== date.month ||
    checked.getUTCDate() !== date.day
  ) throw new RangeError("date is not a valid calendar date");
  return date;
}

export function formatCalendarDate(date: CalendarDate) {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: 1 };
}

export function localDateAt(instant: Date, timeZone: string): CalendarDate {
  const parts = formatter(timeZone).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

export function startOfLocalDate(date: CalendarDate, timeZone: string): Date {
  const localFormatter = formatter(timeZone);
  const target = formatCalendarDate(date);
  const naiveUtc = Date.UTC(date.year, date.month - 1, date.day);
  let low = naiveUtc - 36 * 60 * 60 * 1000;
  let high = naiveUtc + 36 * 60 * 60 * 1000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (formatInstantDate(new Date(middle), localFormatter) < target) low = middle + 1;
    else high = middle;
  }
  if (formatInstantDate(new Date(low), localFormatter) !== target) {
    throw new RangeError(`local date does not exist in ${timeZone}: ${target}`);
  }
  return new Date(low);
}

export function listDaysInclusive(from: CalendarDate, to: CalendarDate, maximum = 400) {
  const values: CalendarDate[] = [];
  for (let cursor = from; formatCalendarDate(cursor) <= formatCalendarDate(to); cursor = addCalendarDays(cursor, 1)) {
    values.push(cursor);
    if (values.length > maximum) throw new RangeError(`day range must not exceed ${maximum} points`);
  }
  if (values.length === 0) throw new RangeError("from must not be after to");
  return values;
}

export function listMonthsInclusive(from: CalendarDate, to: CalendarDate, maximum = 120) {
  const first = { ...from, day: 1 };
  const last = { ...to, day: 1 };
  const values: CalendarDate[] = [];
  for (let cursor = first; monthKey(cursor) <= monthKey(last); cursor = addCalendarMonths(cursor, 1)) {
    values.push(cursor);
    if (values.length > maximum) throw new RangeError(`month range must not exceed ${maximum} points`);
  }
  if (values.length === 0) throw new RangeError("from must not be after to");
  return values;
}

export function monthKey(date: CalendarDate) {
  return formatCalendarDate(date).slice(0, 7);
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function formatInstantDate(instant: Date, localFormatter: Intl.DateTimeFormat) {
  const parts = localFormatter.formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
