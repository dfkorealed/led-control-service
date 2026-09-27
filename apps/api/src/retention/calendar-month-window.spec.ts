import { threeCalendarMonthsBefore } from "./calendar-month-window";

describe("threeCalendarMonthsBefore", () => {
  it.each([
    ["2026-01-31T15:04:05.123Z", "2025-10-31T15:04:05.123Z"],
    ["2026-02-28T15:04:05.123Z", "2025-11-28T15:04:05.123Z"],
    ["2026-05-31T15:04:05.123Z", "2026-02-28T15:04:05.123Z"],
    ["2024-05-31T15:04:05.123Z", "2024-02-29T15:04:05.123Z"]
  ])("clamps %s to %s while retaining UTC time", (input, expected) => {
    expect(threeCalendarMonthsBefore(new Date(input)).toISOString()).toBe(expected);
  });

  it("includes the exact cutoff but excludes 1ms before it on May month-end", () => {
    const cutoff = threeCalendarMonthsBefore(new Date("2026-05-31T15:04:05.123Z"));
    expect(new Date("2026-02-28T15:04:05.123Z") >= cutoff).toBe(true);
    expect(new Date("2026-02-28T15:04:05.122Z") >= cutoff).toBe(false);
  });
});
