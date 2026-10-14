import type { HolidayDatasetSnapshot, LightingScheduleSnapshotV3 } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { evaluateScheduleStartDate } from "./index";

const rule: LightingScheduleSnapshotV3 = {
  id: "schedule-1", name: "Schedule", status: "enabled", activeFrom: "2026-01-01T00:00:00Z", activeUntil: "2026-12-31T00:00:00Z",
  localStartTime: "23:00", localEndTime: "02:00", recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
  action: { dimmingEnabled: true, brightnessPercent: 60 }, fixtureIds: ["fixture-1"], excludeWeekends: false, excludeHolidays: false
};
const dataset: HolidayDatasetSnapshot = {
  country: "KR", source: "kasi", year: 2026, revision: "2026-1", fetchedAt: "2026-10-01T00:00:00Z",
  coverageFrom: "2026-01-01", coverageUntil: "2026-12-31", payloadHash: `sha256:${"a".repeat(64)}`,
  dates: [{ date: "2026-10-05", names: ["임시공휴일"] }]
};

describe("schedule start-date exclusions", () => {
  it.each([
    ["weekend false", {}, "2026-10-03", [], { allowed: true, reason: null }],
    ["Saturday", { excludeWeekends: true }, "2026-10-03", [], { allowed: false, reason: "weekend" }],
    ["Sunday", { excludeWeekends: true }, "2026-10-04", [], { allowed: false, reason: "weekend" }],
    ["weekday", { excludeWeekends: true }, "2026-10-05", [], { allowed: true, reason: null }],
    ["holiday", { excludeHolidays: true }, "2026-10-05", [dataset], { allowed: false, reason: "holiday" }],
    ["covered empty day", { excludeHolidays: true }, "2026-10-06", [dataset], { allowed: true, reason: null }],
    ["missing coverage", { excludeHolidays: true }, "2026-10-06", [], { allowed: false, reason: "coverage_unknown" }],
    ["other year", { excludeHolidays: true }, "2027-01-01", [dataset], { allowed: false, reason: "coverage_unknown" }],
    ["partial year", { excludeHolidays: true }, "2026-10-06", [{ ...dataset, coverageFrom: "2026-10-01" }], { allowed: false, reason: "coverage_unknown" }],
    ["duplicate revisions", { excludeHolidays: true }, "2026-10-06", [dataset, { ...dataset, revision: "2026-2" }], { allowed: false, reason: "coverage_unknown" }],
    ["weekend precedence", { excludeWeekends: true, excludeHolidays: true }, "2026-10-03", [], { allowed: false, reason: "weekend" }]
  ])("%s", (_label, flags, date, datasets, expected) => {
    expect(evaluateScheduleStartDate({ ...rule, ...flags }, date, "Asia/Seoul", datasets)).toEqual(expected);
  });

  it("only applies Korean holidays in Asia/Seoul, while weekends use the caller's local day", () => {
    expect(evaluateScheduleStartDate({ ...rule, excludeHolidays: true }, "2026-10-06", "UTC", [dataset]))
      .toEqual({ allowed: false, reason: "coverage_unknown" });
    expect(evaluateScheduleStartDate({ ...rule, excludeWeekends: true }, "2026-10-03", "America/New_York", []))
      .toEqual({ allowed: false, reason: "weekend" });
  });

  it("preserves V1 behavior without datasets", () => {
    const { excludeWeekends: _weekends, excludeHolidays: _holidays, ...legacy } = rule;
    expect(evaluateScheduleStartDate(legacy, "2026-10-03", "UTC", []))
      .toEqual({ allowed: true, reason: null });
  });
});
