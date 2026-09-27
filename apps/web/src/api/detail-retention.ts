import { useEffect, useState } from "react";

/** PostgreSQL's UTC `now - interval '3 months'`, including month-end clamping. */
export function detailRetainedFrom(now: number): number {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 3);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

export function isDetailRetained(createdAt: string | undefined, now = Date.now()): boolean {
  // Older API versions omit the timestamp. Server revalidation still applies.
  return createdAt === undefined || Date.parse(createdAt) >= detailRetainedFrom(now);
}

function detailDeadline(createdAt: string, now: number): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 0;
  if (!isDetailRetained(createdAt, now)) return Infinity;
  const date = new Date(created);
  const dayMilliseconds = 86_400_000;
  const timeOfDay = created - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, 1);
  const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 4, 1);
  // Month-end clamping can move the cutoff BACK at midnight: May 28 23:00
  // maps to Feb 28 23:00, but May 29 00:00 maps to Feb 28 00:00. Therefore
  // neither binary search nor adding three months finds every next boundary.
  // Within each UTC day the cutoff moves linearly. Check that day's midnight
  // and matching time + 1ms separately, then the following month's midnight.
  for (let day = monthStart; day <= nextMonth; day += dayMilliseconds) {
    for (const candidate of [day, day + timeOfDay + 1]) {
      if (candidate > now && candidate <= nextMonth && detailRetainedFrom(candidate) > created) return candidate;
    }
  }
  return Infinity;
}

/** Wake an open surface at its next retention boundary, including suspended tabs. */
export function useDetailRetentionClock(timestamps: Array<string | undefined>) {
  const [, setRevision] = useState(0);
  const now = Date.now();
  const deadline = Math.min(...timestamps.filter((value): value is string => Boolean(value))
    .map((value) => detailDeadline(value, now)).filter((value) => value > now));
  useEffect(() => {
    const wake = () => setRevision((value) => value + 1);
    const timer = Number.isFinite(deadline) ? window.setTimeout(wake, Math.min(deadline - Date.now(), 2_147_483_647)) : undefined;
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
  }, [deadline, now]);
  return now;
}
