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

function detailDeadline(createdAt: string): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 0;
  // Adding three months is not the inverse of a clamped subtraction (Nov 30
  // remains retained through February). Find the first excluded millisecond.
  let low = created;
  let high = created + 124 * 86_400_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (detailRetainedFrom(middle) > created) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Wake an open surface at its next retention boundary, including suspended tabs. */
export function useDetailRetentionClock(timestamps: Array<string | undefined>) {
  const [, setRevision] = useState(0);
  const now = Date.now();
  const deadline = Math.min(...timestamps.filter((value): value is string => Boolean(value))
    .map(detailDeadline).filter((value) => value > now));
  useEffect(() => {
    const wake = () => setRevision((value) => value + 1);
    const timer = Number.isFinite(deadline) ? window.setTimeout(wake, Math.min(deadline - Date.now(), 2_147_483_647)) : undefined;
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", wake); document.removeEventListener("visibilitychange", wake); };
  }, [deadline, now]);
  return now;
}
