export interface FormatTimestampOptions {
  /** Omit to retain the browser/device timezone, rather than assuming UTC. */
  timeZone?: string;
}

// An instant must include a time and offset. Date-only and recurring local-time
// values belong to the existing date adapters, never to timestamp display.
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function parseInstant(value: string): Date | null {
  const match = instantPattern.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59
    || Number(offsetHourText ?? 0) > 23 || Number(offsetMinuteText ?? 0) > 59) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes impossible dates (e.g. February 30). Reject them
  // before parsing, so display never silently invents a different instant.
  if (day > days[month - 1]) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatTimestamp(value: string | Date | null | undefined, options: FormatTimestampOptions = {}): string {
  const date = typeof value === "string" ? parseInstant(value) : value;
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "—";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone })
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
    return `${part("year")!.padStart(4, "0")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
  } catch {
    // Invalid zones are display failures, not permission to use another zone.
    return "—";
  }
}
