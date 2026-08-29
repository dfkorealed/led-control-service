import type { LightingScheduleSnapshotV1, ScheduleRecurrenceKind } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { getActiveOccurrence, getNextOccurrence, getOccurrences } from "./recurrence";

const emptyRecurrenceFields = {
  weeklyDays: [],
  monthlyDay: null,
  yearlyMonth: null,
  yearlyDay: null
};

function schedule(
  patch: Partial<LightingScheduleSnapshotV1> & {
    recurrence?: Partial<LightingScheduleSnapshotV1["recurrence"]> & { kind: ScheduleRecurrenceKind };
  } = {}
): LightingScheduleSnapshotV1 {
  const recurrence = patch.recurrence ?? { kind: "daily" as const };

  return {
    id: "schedule-1",
    name: "Test schedule",
    status: "enabled",
    activeFrom: "2024-01-01T00:00:00Z",
    activeUntil: "2031-12-31T00:00:00Z",
    localStartTime: "10:00",
    localEndTime: "11:00",
    action: { dimmingEnabled: true, brightnessPercent: 60 },
    fixtureIds: ["fixture-1"],
    ...patch,
    recurrence: { ...emptyRecurrenceFields, ...recurrence }
  };
}

describe("schedule recurrence", () => {
  it("skips monthly days that do not exist instead of rolling into the next month", () => {
    const rule = schedule({
      localStartTime: "20:00",
      localEndTime: "22:00",
      recurrence: { kind: "monthly", monthlyDay: 31 }
    });

    expect(getActiveOccurrence(rule, Date.parse("2026-04-30T12:00:00Z"), "Asia/Seoul")).toBeNull();
    expect(getNextOccurrence(rule, Date.parse("2026-04-01T00:00:00Z"), "Asia/Seoul")?.localDate).toBe("2026-05-31");
  });

  it("runs a yearly February 29 rule only in leap years", () => {
    const rule = schedule({
      recurrence: { kind: "yearly", yearlyMonth: 2, yearlyDay: 29 }
    });

    expect(getNextOccurrence(rule, Date.parse("2025-03-01T00:00:00Z"), "Asia/Seoul")?.localDate).toBe("2028-02-29");
  });

  it("keeps the starting local date in the key while active after midnight", () => {
    const rule = schedule({ localStartTime: "23:00", localEndTime: "02:00" });

    expect(getActiveOccurrence(rule, Date.parse("2026-08-29T16:30:00Z"), "Asia/Seoul")).toMatchObject({
      key: "schedule-1:2026-08-29",
      localDate: "2026-08-29",
      startsAtEpochMs: Date.parse("2026-08-29T14:00:00Z"),
      endsAtEpochMs: Date.parse("2026-08-29T17:00:00Z")
    });
  });

  it("uses compatible disambiguation once for a repeated local time", () => {
    const rule = schedule({
      activeFrom: "2026-11-01T00:00:00Z",
      activeUntil: "2026-11-01T23:59:59Z",
      localStartTime: "01:30",
      localEndTime: "01:45"
    });

    const occurrences = getOccurrences(rule, {
      startsAtEpochMs: Date.parse("2026-11-01T04:00:00Z"),
      endsAtEpochMs: Date.parse("2026-11-01T08:00:00Z")
    }, "America/New_York");

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      startsAtEpochMs: Date.parse("2026-11-01T05:30:00Z"),
      endsAtEpochMs: Date.parse("2026-11-01T05:45:00Z")
    });
  });

  it("moves a nonexistent local start forward with compatible disambiguation", () => {
    const rule = schedule({
      activeFrom: "2026-03-08T00:00:00Z",
      activeUntil: "2026-03-08T23:59:59Z",
      localStartTime: "02:30",
      localEndTime: "04:00"
    });

    expect(getNextOccurrence(rule, Date.parse("2026-03-08T00:00:00Z"), "America/New_York")).toMatchObject({
      localDate: "2026-03-08",
      startsAtEpochMs: Date.parse("2026-03-08T07:30:00Z"),
      endsAtEpochMs: Date.parse("2026-03-08T08:00:00Z")
    });
  });

  it.each([
    ["once", { kind: "once" as const }, "2026-06-10T10:30:00Z", true],
    ["daily", { kind: "daily" as const }, "2026-06-11T10:30:00Z", true],
    ["weekly included day", { kind: "weekly" as const, weeklyDays: [4] }, "2026-06-11T10:30:00Z", true],
    ["weekly excluded day", { kind: "weekly" as const, weeklyDays: [1] }, "2026-06-11T10:30:00Z", false],
    ["monthly", { kind: "monthly" as const, monthlyDay: 11 }, "2026-06-11T10:30:00Z", true],
    ["yearly", { kind: "yearly" as const, yearlyMonth: 6, yearlyDay: 11 }, "2026-06-11T10:30:00Z", true]
  ])("supports %s recurrence", (_case, recurrence, epoch, expectedActive) => {
    const rule = schedule({
      activeFrom: "2026-06-10T00:00:00Z",
      activeUntil: "2026-06-12T23:59:59Z",
      recurrence
    });

    expect(getActiveOccurrence(rule, Date.parse(epoch), "UTC") !== null).toBe(expectedActive);
  });

  it("applies inclusive local active dates and allows the last occurrence to cross midnight", () => {
    const rule = schedule({
      activeFrom: "2026-06-10T00:00:00Z",
      activeUntil: "2026-06-12T23:59:59Z",
      localStartTime: "23:00",
      localEndTime: "02:00"
    });

    expect(getNextOccurrence(rule, Date.parse("2026-06-09T00:00:00Z"), "UTC")?.localDate).toBe("2026-06-10");
    expect(getActiveOccurrence(rule, Date.parse("2026-06-13T01:00:00Z"), "UTC")?.localDate).toBe("2026-06-12");
    expect(getNextOccurrence(rule, Date.parse("2026-06-12T23:00:00Z"), "UTC")).toBeNull();
  });

  it("does not return occurrences for a disabled rule", () => {
    const rule = schedule({ status: "disabled" });

    expect(getActiveOccurrence(rule, Date.parse("2026-06-11T10:30:00Z"), "UTC")).toBeNull();
    expect(getNextOccurrence(rule, Date.parse("2026-06-11T00:00:00Z"), "UTC")).toBeNull();
  });

  it("returns the next occurrence without traversing a far-future active tail", () => {
    const rule = schedule({
      activeFrom: "2026-01-01T00:00:00Z",
      activeUntil: "3000-12-31T23:59:59Z"
    });
    const startedAt = performance.now();

    const occurrence = getNextOccurrence(rule, Date.parse("2026-06-11T00:00:00Z"), "UTC");

    expect(occurrence?.localDate).toBe("2026-06-11");
    expect(performance.now() - startedAt).toBeLessThan(250);
  }, 20_000);
});
