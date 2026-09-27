import { BadRequestException } from "@nestjs/common";
import { comparisonRanges, customComparisonRanges, parseComparisonPreset } from "./energy-comparison-query";

describe("energy comparison query", () => {
  it("parses only the three published presets", () => {
    expect(parseComparisonPreset("last_7_days")).toBe("last_7_days");
    expect(parseComparisonPreset("current_month")).toBe("current_month");
    expect(parseComparisonPreset("current_year")).toBe("current_year");
    expect(() => parseComparisonPreset("custom")).toThrow(BadRequestException);
    expect(() => parseComparisonPreset(undefined)).toThrow(BadRequestException);
  });

  it("builds the current month display and completed comparison ranges in site time", () => {
    expect(comparisonRanges("current_month", new Date("2026-09-10T03:00:00.000Z"), "Asia/Seoul")).toEqual({
      display: { from: "2026-09-01", to: "2026-09-30" },
      completed: { from: "2026-09-01", to: "2026-09-09" },
      completedThrough: "2026-09-09",
      previousPeriod: { from: "2026-08-01", to: "2026-08-09" },
      previousYear: { from: "2025-09-01", to: "2025-09-09" },
      pointGranularity: "day"
    });
  });

  it("uses the seven completed local dates and the immediately preceding seven dates", () => {
    expect(comparisonRanges("last_7_days", new Date("2026-09-10T03:00:00.000Z"), "Asia/Seoul")).toEqual({
      display: { from: "2026-09-03", to: "2026-09-09" },
      completed: { from: "2026-09-03", to: "2026-09-09" },
      completedThrough: "2026-09-09",
      previousPeriod: { from: "2026-08-27", to: "2026-09-02" },
      previousYear: { from: "2025-09-03", to: "2025-09-09" },
      pointGranularity: "day"
    });
  });

  it("caps a leap-day previous-year range at the last valid February date", () => {
    expect(comparisonRanges("current_year", new Date("2024-03-01T12:00:00.000Z"), "UTC")).toEqual({
      display: { from: "2024-01-01", to: "2024-02-29" },
      completed: { from: "2024-01-01", to: "2024-02-29" },
      completedThrough: "2024-02-29",
      previousPeriod: null,
      previousYear: { from: "2023-01-01", to: "2023-02-28" },
      pointGranularity: "month"
    });
  });

  it("represents the first local day of a month without inventing a completed day", () => {
    expect(comparisonRanges("current_month", new Date("2026-09-01T00:00:00.000Z"), "Asia/Seoul")).toEqual({
      display: { from: "2026-09-01", to: "2026-09-30" },
      completed: null,
      completedThrough: "2026-08-31",
      previousPeriod: null,
      previousYear: null,
      pointGranularity: "day"
    });
  });

  it("derives today from the site timezone rather than UTC", () => {
    expect(comparisonRanges("current_month", new Date("2026-03-01T04:30:00.000Z"), "America/New_York")).toMatchObject({
      display: { from: "2026-02-01", to: "2026-02-28" },
      completed: { from: "2026-02-01", to: "2026-02-27" },
      completedThrough: "2026-02-27"
    });
  });
});

describe("custom comparison ranges", () => {
  const generatedAt = new Date("2026-03-01T05:30:00.000Z");

  it("uses completed site-local dates and adjacent equal-length comparison windows", () => {
    expect(customComparisonRanges({ from: "2026-02-27", to: "2026-02-28" }, generatedAt, "America/New_York")).toEqual({
      display: { from: "2026-02-27", to: "2026-02-28" },
      completed: { from: "2026-02-27", to: "2026-02-28" },
      completedThrough: "2026-02-28",
      previousPeriod: { from: "2026-02-25", to: "2026-02-26" },
      previousYear: { from: "2025-02-27", to: "2025-02-28" },
      pointGranularity: "day"
    });
  });

  it("clamps leap-day prior-year anchor and preserves selected length", () => {
    expect(customComparisonRanges({ from: "2024-02-28", to: "2024-02-29" }, new Date("2024-03-02T00:00:00.000Z"), "UTC").previousYear)
      .toEqual({ from: "2023-02-27", to: "2023-02-28" });
  });

  it.each([
    { from: "2026-02-30", to: "2026-02-28" },
    { from: "2026-03-01", to: "2026-03-01" },
    { from: "2026-02-28", to: "2026-02-27" },
    { from: "2025-01-01", to: "2026-02-28" }
  ])("rejects malformed, incomplete, reversed or overlong selection %j", (query) => {
    expect(() => customComparisonRanges(query, generatedAt, "America/New_York")).toThrow(BadRequestException);
  });

  it("rejects extra query keys with a sanitized validation error", () => {
    expect(() => customComparisonRanges({ from: "2026-02-27", to: "2026-02-28", unexpected: "secret" }, generatedAt, "America/New_York"))
      .toThrow(new BadRequestException("invalid energy comparison range"));
  });
});
