import { BadRequestException } from "@nestjs/common";
import { resolveLogDateRange } from "./log-date-range";

type Input = { fromDate?: string; toDate?: string };
type Boundary = { generatedAt: Date; retainedFrom?: Date };
function resolveRange(input: Input, zone: string, boundary: Boundary) {
  return resolveLogDateRange(input, zone, boundary);
}
const clock = { generatedAt: new Date("2026-10-02T12:00:00.123Z"),
  retainedFrom: new Date("2026-07-02T12:00:00.123Z") };

describe("operation log calendar range", () => {
  it.each([
    { fromDate: "2026-10-01" }, { toDate: "2026-10-01" },
    { fromDate: "2026-02-29", toDate: "2026-03-01" },
    { fromDate: "2026-04-31", toDate: "2026-05-01" },
    { fromDate: "2026-10-02", toDate: "2026-10-01" },
    { fromDate: "2026-1-01", toDate: "2026-10-01" },
    { fromDate: "", toDate: "" },
  ])("log_dates_pair_invalid_and_site_day_inclusive rejects %p", input => {
    expect(() => resolveRange(input, "Asia/Seoul", clock)).toThrow(BadRequestException);
  });

  it("log_dates_pair_invalid_and_site_day_inclusive includes the Seoul ending day", () => {
    expect(resolveRange({ fromDate: "2026-10-01", toDate: "2026-10-01" }, "Asia/Seoul", clock))
      .toEqual({ start: new Date("2026-09-30T15:00:00.000Z"), end: new Date("2026-10-01T15:00:00.000Z") });
  });

  it.each([
    ["2026-03-08", "2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z"],
    ["2026-11-01", "2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"],
  ])("log_dates_clamp_db_clock_dst_month_end honors the LA DST day %s", (date, start, end) => {
    expect(resolveRange({ fromDate: date, toDate: date }, "America/Los_Angeles",
      { generatedAt: new Date("2026-12-01T00:00:00.000Z") }))
      .toEqual({ start: new Date(start), end: new Date(end) });
  });

  it("log_dates_clamp_db_clock_dst_month_end uses the precise DB cutoff, not 90 days or host time", () => {
    expect(resolveRange({ fromDate: "2026-02-01", toDate: "2026-06-01" }, "UTC", {
      generatedAt: new Date("2026-05-31T12:04:05.123Z"), retainedFrom: new Date("2026-02-28T12:04:05.123Z")
    })).toEqual({ start: new Date("2026-02-28T12:04:05.123Z"), end: new Date("2026-05-31T12:04:05.123Z") });
  });

  it("preserves OFF-mode no-cutoff defaults and accepts a real leap day", () => {
    expect(resolveRange({}, "Asia/Seoul", { generatedAt: clock.generatedAt }))
      .toEqual({ start: undefined, end: clock.generatedAt });
    expect(resolveRange({}, "Asia/Seoul", clock)).toEqual({ start: clock.retainedFrom, end: clock.generatedAt });
    expect(resolveRange({ fromDate: "2024-02-29", toDate: "2024-02-29" }, "UTC",
      { generatedAt: clock.generatedAt })).toEqual({ start: new Date("2024-02-29T00:00:00.000Z"), end: new Date("2024-03-01T00:00:00.000Z") });
  });

  it("represents an empty intersection rather than expanding it to retained rows", () => {
    expect(resolveRange({ fromDate: "2026-01-01", toDate: "2026-01-02" }, "UTC", clock))
      .toEqual({ start: clock.retainedFrom, end: new Date("2026-01-03T00:00:00.000Z") });
  });

  it.each([undefined, "", "not/a-zone"])("never falls back to the host zone for missing/invalid persisted zone %s", zone => {
    expect(() => resolveRange({ fromDate: "2026-10-01", toDate: "2026-10-01" }, zone as string, clock)).toThrow();
  });
});
