import type { HolidayDatasetSnapshot, LightingScheduleSnapshotV3 } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { projectScheduleCalendar } from "./index";

const rule: LightingScheduleSnapshotV3 = {
  id: "schedule-1", name: "Schedule", status: "enabled", activeFrom: "2026-10-01T00:00:00Z", activeUntil: "2026-10-07T00:00:00Z",
  localStartTime: "23:00", localEndTime: "02:00", recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
  action: { dimmingEnabled: true, brightnessPercent: 60 }, fixtureIds: ["fixture-1"], excludeWeekends: true, excludeHolidays: true
};
const dataset: HolidayDatasetSnapshot = {
  country: "KR", source: "kasi", year: 2026, revision: "2026-1", fetchedAt: "2026-10-01T00:00:00Z",
  coverageFrom: "2026-01-01", coverageUntil: "2026-12-31", payloadHash: `sha256:${"a".repeat(64)}`,
  dates: [{ date: "2026-10-05", names: ["임시공휴일"] }]
};
const input = { rules: [rule], from: "2026-10-02", to: "2026-10-06", timeZone: "Asia/Seoul", datasets: [dataset] };

describe("complete schedule calendar projection", () => {
  it("includes both start-date boundaries, filters exclusions, and keeps overnight ends", () => {
    expect(projectScheduleCalendar(input)).toEqual([
      { scheduleId: "schedule-1", key: "schedule-1:2026-10-02", localDate: "2026-10-02", startsAt: "2026-10-02T14:00:00.000Z", endsAt: "2026-10-02T17:00:00.000Z" },
      { scheduleId: "schedule-1", key: "schedule-1:2026-10-06", localDate: "2026-10-06", startsAt: "2026-10-06T14:00:00.000Z", endsAt: "2026-10-06T17:00:00.000Z" }
    ]);
  });

  it("projects every one of 101 rules without list pagination", () => {
    const rules = Array.from({ length: 101 }, (_, index) => ({ ...rule, id: `schedule-${index}` }));
    const occurrences = projectScheduleCalendar({ ...input, rules, from: "2026-10-06", to: "2026-10-06" });
    expect(occurrences.length).toBe(101);
    expect(new Set(occurrences.map(item => item.scheduleId)).size).toBe(101);
  });

  it("filters unknown holiday starts and disabled rules", () => {
    expect(projectScheduleCalendar({ ...input, datasets: [] })).toEqual([]);
    expect(projectScheduleCalendar({ ...input, rules: [{ ...rule, status: "disabled" }] })).toEqual([]);
  });

  it("returns deterministic ordering by instant then schedule identity", () => {
    const later = { ...rule, id: "later", localStartTime: "23:30" };
    expect(projectScheduleCalendar({ ...input, from: "2026-10-06", to: "2026-10-06", rules: [later, { ...rule, id: "b" }, { ...rule, id: "a" }] }).map(item => item.scheduleId))
      .toEqual(["a", "b", "later"]);
  });

  it("uses inclusive 42-day limits and rejects reversed or 43-day ranges", () => {
    expect(projectScheduleCalendar({ ...input, rules: [], from: "2026-10-01", to: "2026-11-11" })).toEqual([]);
    expect(() => projectScheduleCalendar({ ...input, from: "2026-10-01", to: "2026-11-12" })).toThrow(RangeError);
    expect(() => projectScheduleCalendar({ ...input, from: "2026-10-06", to: "2026-10-02" })).toThrow(RangeError);
  });
});
