import { useEffect, useState } from "react";
import { detailRetentionAnchorSchema } from "@led-control/shared/monitoring-activity-contracts";

export interface RetentionClock { generatedAt: number; requestStartedAt: number; retentionEnabled: boolean }
export async function withRetentionClock<T>(read: () => Promise<T>): Promise<T & { retentionClock?: RetentionClock }> {
  const requestStartedAt = performance.now();
  const response = await read();
  const parsed = detailRetentionAnchorSchema.safeParse(response);
  const generatedAt = parsed.success ? Date.parse(parsed.data.generatedAt) : NaN;
  const valid = parsed.success && Date.parse(parsed.data.retainedFrom) === detailRetainedFrom(generatedAt);
  // Counting the full request RTT as elapsed server time deliberately hides a
  // boundary response early. Starting at receipt could expose expired content.
  return { ...response, retentionClock: valid ? { generatedAt, requestStartedAt, retentionEnabled: parsed.data.retentionEnabled !== false } : undefined };
}

export function retentionNow(clock: RetentionClock | undefined): number {
  if (!clock) return NaN;
  const elapsed = performance.now() - clock.requestStartedAt;
  return elapsed >= 0 ? clock.generatedAt + elapsed : NaN;
}

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

export function isDetailRetained(createdAt: string | undefined, now: number): boolean {
  return typeof createdAt === "string" && Number.isFinite(now) && Date.parse(createdAt) >= detailRetainedFrom(now);
}

export function isRetainedByClock(createdAt: string | undefined, clock?: RetentionClock): boolean {
  if (!clock || !Number.isFinite(retentionNow(clock))) return false;
  if (!clock.retentionEnabled) return true;
  // Clamping can move the cutoff backwards at midnight. Once this response
  // crosses its FIRST exclusion, only a new authorized read may restore it.
  return Boolean(createdAt && isDetailRetained(createdAt, clock.generatedAt)
    && retentionNow(clock) < detailDeadline(createdAt, clock.generatedAt));
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
export function useDetailRetentionClock(timestamps: Array<string | undefined>, clock?: RetentionClock, revalidate?: () => unknown) {
  const [, setRevision] = useState(0);
  const now = retentionNow(clock);
  const deadline = clock?.retentionEnabled === false ? Infinity : Math.min(...timestamps.filter((value): value is string => Boolean(value))
    .map((value) => detailDeadline(value, clock?.generatedAt ?? NaN)).filter((value) => value > now));
  useEffect(() => {
    const wake = () => setRevision((value) => value + 1);
    const regainFocus = () => { wake(); if (document.visibilityState === "visible") void revalidate?.(); };
    const timer = Number.isFinite(deadline) ? window.setTimeout(wake, Math.max(0, Math.min(deadline - retentionNow(clock), 2_147_483_647))) : undefined;
    window.addEventListener("focus", regainFocus);
    document.addEventListener("visibilitychange", regainFocus);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", regainFocus); document.removeEventListener("visibilitychange", regainFocus); };
  }, [deadline, now, clock, revalidate]);
  return now;
}
