import {
  listDaysInclusive,
  listMonthsInclusive,
  parseCalendarDate,
  startOfLocalDate
} from "./energy-periods";

describe("energy period boundaries", () => {
  it("uses 23 and 25 hour local days across DST", () => {
    const springStart = startOfLocalDate(parseCalendarDate("2026-03-08"), "America/New_York");
    const springEnd = startOfLocalDate(parseCalendarDate("2026-03-09"), "America/New_York");
    const fallStart = startOfLocalDate(parseCalendarDate("2026-11-01"), "America/New_York");
    const fallEnd = startOfLocalDate(parseCalendarDate("2026-11-02"), "America/New_York");

    expect((springEnd.getTime() - springStart.getTime()) / 3_600_000).toBe(23);
    expect((fallEnd.getTime() - fallStart.getTime()) / 3_600_000).toBe(25);
  });

  it("includes both requested range boundaries", () => {
    expect(listDaysInclusive(parseCalendarDate("2026-08-01"), parseCalendarDate("2026-08-03"))).toHaveLength(3);
    expect(listMonthsInclusive(parseCalendarDate("2026-01-31"), parseCalendarDate("2026-12-01"))).toHaveLength(12);
  });

  it("rejects invalid dates and reversed ranges", () => {
    expect(() => parseCalendarDate("2026-02-30")).toThrow("valid calendar date");
    expect(() => listDaysInclusive(parseCalendarDate("2026-08-03"), parseCalendarDate("2026-08-01"))).toThrow(
      "from must not be after to"
    );
  });
});
