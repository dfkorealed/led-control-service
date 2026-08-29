import { Temporal } from "@js-temporal/polyfill";
import type { LightingScheduleSnapshotV1 } from "@led-control/shared";
import {
  iterateScheduleOccurrences,
  OCCURRENCE_SPILL_LOOKBACK_DAYS,
  type ScheduleOccurrence
} from "./recurrence";

function activeDate(instant: string, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate();
}

function laterDate(left: Temporal.PlainDate, right: Temporal.PlainDate): Temporal.PlainDate {
  return Temporal.PlainDate.compare(left, right) >= 0 ? left : right;
}

function earlierDate(left: Temporal.PlainDate, right: Temporal.PlainDate): Temporal.PlainDate {
  return Temporal.PlainDate.compare(left, right) <= 0 ? left : right;
}

function hasCommonFixture(left: LightingScheduleSnapshotV1, right: LightingScheduleSnapshotV1): boolean {
  const leftFixtures = new Set(left.fixtureIds);
  return right.fixtureIds.some((fixtureId) => leftFixtures.has(fixtureId));
}

function intervalsOverlap(
  left: Generator<ScheduleOccurrence>,
  right: Generator<ScheduleOccurrence>
): boolean {
  let leftResult = left.next();
  let rightResult = right.next();

  while (!leftResult.done && !rightResult.done) {
    const leftOccurrence = leftResult.value;
    const rightOccurrence = rightResult.value;

    if (
      leftOccurrence.startsAtEpochMs < rightOccurrence.endsAtEpochMs
      && rightOccurrence.startsAtEpochMs < leftOccurrence.endsAtEpochMs
    ) {
      return true;
    }

    if (leftOccurrence.endsAtEpochMs <= rightOccurrence.endsAtEpochMs) {
      leftResult = left.next();
    } else {
      rightResult = right.next();
    }
  }

  return false;
}

export function schedulesOverlap(
  left: LightingScheduleSnapshotV1,
  right: LightingScheduleSnapshotV1,
  timeZone: string
): boolean {
  if (left.status !== "enabled" || right.status !== "enabled" || !hasCommonFixture(left, right)) {
    return false;
  }

  const leftFrom = activeDate(left.activeFrom, timeZone);
  const leftUntil = activeDate(left.activeUntil, timeZone);
  const rightFrom = activeDate(right.activeFrom, timeZone);
  const rightUntil = activeDate(right.activeUntil, timeZone);

  // Expand both sides by the maximum spill distance so schedules whose active
  // start-date ranges are separated by a skipped local date can still meet.
  // Each iterator continues to clamp candidates to its own active date range.
  const comparisonStart = laterDate(leftFrom, rightFrom).subtract({
    days: OCCURRENCE_SPILL_LOOKBACK_DAYS
  });
  const comparisonEnd = earlierDate(leftUntil, rightUntil).add({
    days: OCCURRENCE_SPILL_LOOKBACK_DAYS
  });
  if (Temporal.PlainDate.compare(comparisonStart, comparisonEnd) > 0) {
    return false;
  }

  return intervalsOverlap(
    iterateScheduleOccurrences(left, comparisonStart, comparisonEnd, timeZone),
    iterateScheduleOccurrences(right, comparisonStart, comparisonEnd, timeZone)
  );
}
