import { BadRequestException } from "@nestjs/common";
import { addCalendarDays, formatCalendarDate, parseCalendarDate, startOfLocalDate } from "../energy/energy-periods";

export type LogDateRangeInput = { fromDate?: string; toDate?: string };

/** Query validation is shared by controllers and direct service callers. */
export function isValidLogDateRange(input: LogDateRangeInput): boolean {
  if (input.fromDate === undefined && input.toDate === undefined) return true;
  if (typeof input.fromDate !== "string" || typeof input.toDate !== "string") return false;
  try {
    parseCalendarDate(input.fromDate);
    parseCalendarDate(input.toDate);
    return input.fromDate <= input.toDate;
  } catch {
    return false;
  }
}

/**
 * Intersect a site-local inclusive calendar range with one authoritative DB
 * boundary. start >= end deliberately represents an empty intersection; never
 * move either edge to expand it. Omitting retainedFrom preserves rollout OFF.
 */
export function resolveLogDateRange(input: LogDateRangeInput, timeZone: string,
  boundary: { generatedAt: Date; retainedFrom?: Date }): { start: Date | undefined; end: Date } {
  if (!isValidLogDateRange(input)) throw new BadRequestException("invalid log date range");
  if (!(boundary.generatedAt instanceof Date) || !Number.isFinite(boundary.generatedAt.getTime())
    || (boundary.retainedFrom !== undefined && (!(boundary.retainedFrom instanceof Date)
      || !Number.isFinite(boundary.retainedFrom.getTime())))) throw new Error("log DB boundary unavailable");
  if (input.fromDate === undefined || input.toDate === undefined) {
    return { start: boundary.retainedFrom, end: boundary.generatedAt };
  }
  // Undefined Intl timeZone silently uses the host zone, which is never a
  // substitute for a missing persisted Site timeZone.
  if (typeof timeZone !== "string" || !timeZone.trim()) throw new Error("site time zone unavailable");
  try { new Intl.DateTimeFormat("en", { timeZone }); }
  catch { throw new Error("site time zone unavailable"); }
  let start: Date, requestedEnd: Date;
  try {
    start = startOfLocalDate(parseCalendarDate(input.fromDate), timeZone);
    const endingDate = parseCalendarDate(input.toDate);
    // Both selected endpoints must exist locally. Only the exclusive successor
    // may skip absent days (e.g. Apia 2011-12-30), without adding fixed 24h.
    startOfLocalDate(endingDate, timeZone);
    let successor = addCalendarDays(endingDate, 1);
    for (;;) {
      // Keep the existing four-digit calendar boundary; never search beyond it.
      parseCalendarDate(formatCalendarDate(successor));
      try {
        requestedEnd = startOfLocalDate(successor, timeZone);
        break;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        successor = addCalendarDays(successor, 1);
      }
    }
  } catch {
    // A selected Gregorian endpoint can be absent locally. Do not normalize
    // that user-selected date, even when its range is older than retainedFrom.
    throw new BadRequestException("invalid log date range");
  }
  if (boundary.retainedFrom && start < boundary.retainedFrom) start = boundary.retainedFrom;
  return { start, end: requestedEnd < boundary.generatedAt ? requestedEnd : boundary.generatedAt };
}
