import type { LightingScheduleSnapshotV1, ScheduleRecurrenceKind } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { schedulesOverlap } from "./overlap";

const emptyRecurrenceFields = {
  weeklyDays: [],
  monthlyDay: null,
  yearlyMonth: null,
  yearlyDay: null
};

function schedule(
  id: string,
  patch: Partial<LightingScheduleSnapshotV1> & {
    recurrence?: Partial<LightingScheduleSnapshotV1["recurrence"]> & { kind: ScheduleRecurrenceKind };
  } = {}
): LightingScheduleSnapshotV1 {
  const recurrence = patch.recurrence ?? { kind: "daily" as const };

  return {
    id,
    name: id,
    status: "enabled",
    activeFrom: "2026-01-01T00:00:00Z",
    activeUntil: "2027-12-31T23:59:59Z",
    localStartTime: "10:00",
    localEndTime: "11:00",
    action: { dimmingEnabled: true, brightnessPercent: 60 },
    fixtureIds: ["fixture-1"],
    ...patch,
    recurrence: { ...emptyRecurrenceFields, ...recurrence }
  };
}

describe("schedule overlap", () => {
  it("requires a common fixture and enabled rules", () => {
    const left = schedule("left");

    expect(schedulesOverlap(left, schedule("other-fixture", { fixtureIds: ["fixture-2"] }), "UTC")).toBe(false);
    expect(schedulesOverlap(left, schedule("disabled", { status: "disabled" }), "UTC")).toBe(false);
    expect(schedulesOverlap(left, schedule("overlap", { localStartTime: "10:30", localEndTime: "11:30" }), "UTC")).toBe(true);
  });

  it("treats intervals as half-open so touching endpoints do not overlap", () => {
    const left = schedule("left", { localStartTime: "10:00", localEndTime: "11:00" });
    const right = schedule("right", { localStartTime: "11:00", localEndTime: "12:00" });

    expect(schedulesOverlap(left, right, "UTC")).toBe(false);
  });

  it("detects overlap across midnight on adjacent active date ranges", () => {
    const left = schedule("left", {
      activeFrom: "2026-08-29T00:00:00Z",
      activeUntil: "2026-08-29T23:59:59Z",
      localStartTime: "23:00",
      localEndTime: "02:00"
    });
    const right = schedule("right", {
      activeFrom: "2026-08-30T00:00:00Z",
      activeUntil: "2026-08-30T23:59:59Z",
      localStartTime: "01:00",
      localEndTime: "03:00"
    });

    expect(schedulesOverlap(left, right, "UTC")).toBe(true);
  });

  it("finds a leap-day overlap in 2104 without sampling current dates", () => {
    const leapDay = schedule("leap-day", {
      activeFrom: "2099-01-01T00:00:00Z",
      activeUntil: "2105-12-31T23:59:59Z",
      localStartTime: "23:30",
      localEndTime: "00:30",
      recurrence: { kind: "yearly", yearlyMonth: 2, yearlyDay: 29 }
    });
    const marchFirst = schedule("march-first", {
      activeFrom: "2099-01-01T00:00:00Z",
      activeUntil: "2105-12-31T23:59:59Z",
      localStartTime: "00:00",
      localEndTime: "00:15",
      recurrence: { kind: "yearly", yearlyMonth: 3, yearlyDay: 1 }
    });

    expect(schedulesOverlap(leapDay, marchFirst, "UTC")).toBe(true);
  });

  it("does not invent a monthly day 31 occurrence in April", () => {
    const april31 = schedule("april-31", {
      activeFrom: "2026-04-01T00:00:00Z",
      activeUntil: "2026-04-30T23:59:59Z",
      localStartTime: "23:30",
      localEndTime: "00:30",
      recurrence: { kind: "monthly", monthlyDay: 31 }
    });
    const mayFirst = schedule("may-first", {
      activeFrom: "2026-05-01T00:00:00Z",
      activeUntil: "2026-05-01T23:59:59Z",
      localStartTime: "00:00",
      localEndTime: "00:15",
      recurrence: { kind: "once" }
    });

    expect(schedulesOverlap(april31, mayFirst, "UTC")).toBe(false);
  });

  it("uses actual DST-compatible instants instead of nominal wall-clock overlap", () => {
    const shiftedPastGap = schedule("shifted", {
      activeFrom: "2026-03-08T05:00:00Z",
      activeUntil: "2026-03-09T03:59:59Z",
      localStartTime: "02:30",
      localEndTime: "04:00"
    });
    const beforeShiftedStart = schedule("before", {
      activeFrom: "2026-03-08T05:00:00Z",
      activeUntil: "2026-03-09T03:59:59Z",
      localStartTime: "03:15",
      localEndTime: "03:25"
    });

    expect(schedulesOverlap(shiftedPastGap, beforeShiftedStart, "America/New_York")).toBe(false);
  });

  it("checks weekly and monthly recurrence from their bounded active period", () => {
    const monday = schedule("monday", {
      activeFrom: "2099-01-01T00:00:00Z",
      activeUntil: "2100-12-31T23:59:59Z",
      recurrence: { kind: "weekly", weeklyDays: [1] }
    });
    const monthEnd = schedule("month-end", {
      activeFrom: "2099-01-01T00:00:00Z",
      activeUntil: "2100-12-31T23:59:59Z",
      localStartTime: "10:30",
      localEndTime: "11:30",
      recurrence: { kind: "monthly", monthlyDay: 31 }
    });

    expect(schedulesOverlap(monday, monthEnd, "UTC")).toBe(true);
  });

  it("covers the full Gregorian weekday cycle for weekly and monthly rules", () => {
    const tuesday = schedule("tuesday", {
      activeFrom: "2003-01-01T00:00:00Z",
      activeUntil: "2004-12-31T23:59:59Z",
      recurrence: { kind: "weekly", weeklyDays: [2] }
    });
    const monthEnd = schedule("month-end", {
      activeFrom: "2003-01-01T00:00:00Z",
      activeUntil: "2004-12-31T23:59:59Z",
      localStartTime: "10:30",
      localEndTime: "11:30",
      recurrence: { kind: "monthly", monthlyDay: 31 }
    });

    expect(schedulesOverlap(tuesday, monthEnd, "UTC")).toBe(true);
  });

  it("returns false when bounded recurrence dates never share actual time", () => {
    const leapMorning = schedule("leap-morning", {
      activeFrom: "2000-01-01T00:00:00Z",
      activeUntil: "2600-12-31T23:59:59Z",
      recurrence: { kind: "yearly", yearlyMonth: 2, yearlyDay: 29 }
    });
    const marchMorning = schedule("march-morning", {
      activeFrom: "2000-01-01T00:00:00Z",
      activeUntil: "2600-12-31T23:59:59Z",
      recurrence: { kind: "yearly", yearlyMonth: 3, yearlyDay: 1 }
    });

    expect(schedulesOverlap(leapMorning, marchMorning, "UTC")).toBe(false);
  });
});
