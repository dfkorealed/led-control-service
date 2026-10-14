import { describe, expect, it } from "vitest";
import { calendarWeekSegments, calendarMonthRange, calendarMonthInTimeZone, calendarMoveMonth } from "./calendar-segments";

describe("calendar server-date segmentation", () => {
  it("sorts and deduplicates dates, splits holes and Sunday week boundaries", () => {
    expect(calendarWeekSegments(["2026-09-28", "2026-09-23", "2026-09-21", "2026-09-22", "2026-09-22", "2026-09-27"], "2026-09-20"))
      .toEqual([{ week: 0, start: 1, end: 3, from: "2026-09-21", to: "2026-09-23" },
        { week: 1, start: 0, end: 1, from: "2026-09-27", to: "2026-09-28" }]);
  });
  it("preserves previous and next month spill dates and splits contiguous weeks", () => {
    expect(calendarWeekSegments(["2026-08-31", "2026-09-01", "2026-09-05", "2026-09-06"], "2026-08-30"))
      .toEqual([{ week: 0, start: 1, end: 2, from: "2026-08-31", to: "2026-09-01" },
        { week: 0, start: 6, end: 6, from: "2026-09-05", to: "2026-09-05" },
        { week: 1, start: 0, end: 0, from: "2026-09-06", to: "2026-09-06" }]);
  });
  it("starts in the site month and moves months without browser-zone rollover", () => {
    const instant = new Date("2026-09-30T20:00:00.000Z");
    expect(calendarMonthInTimeZone("Asia/Seoul", instant)).toBe("2026-10");
    expect(calendarMonthInTimeZone("America/Los_Angeles", instant)).toBe("2026-09");
    expect(calendarMoveMonth("2026-12", 1)).toBe("2027-01");
    expect(calendarMoveMonth("2026-01", -1)).toBe("2025-12");
  });
  it("requests inclusive whole Sunday weeks with at most 42 days", () => {
    expect(calendarMonthRange("2026-09")).toEqual({ from: "2026-08-30", to: "2026-10-03" });
    expect(calendarMonthRange("2026-05")).toEqual({ from: "2026-04-26", to: "2026-06-06" });
    expect(calendarWeekSegments([], "2026-08-30")).toEqual([]);
    expect(() => calendarWeekSegments(["2026-02-30"], "2026-02-01")).toThrow();
  });
});
