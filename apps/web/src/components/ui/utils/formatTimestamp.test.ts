import { afterEach, describe, expect, it, vi } from "vitest";
import * as UI from "../index";

const format = UI.formatTimestamp;

afterEach(() => vi.unstubAllEnvs());

describe("formatTimestamp", () => {
  it("formats Seoul seconds and midnight with Gregorian Latin digits", () => {
    expect(format("2026-10-01T15:00:00.987654Z", { timeZone: "Asia/Seoul" })).toBe("2026-10-02 00:00:00");
    expect(format("2026-10-02T00:01:02Z", { timeZone: "Asia/Seoul" })).toBe("2026-10-02 09:01:02");
  });

  it("formats the same offset instant and respects DST transitions", () => {
    expect(format("2026-10-02T09:01:02+09:00", { timeZone: "UTC" })).toBe("2026-10-02 00:01:02");
    expect(format("2026-03-08T06:59:59Z", { timeZone: "America/New_York" })).toBe("2026-03-08 01:59:59");
    expect(format("2026-03-08T07:00:00Z", { timeZone: "America/New_York" })).toBe("2026-03-08 03:00:00");
  });

  it("preserves the device timezone when no timezone is supplied", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const date = new Date("2026-10-02T00:01:02Z");
    const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(format(date)).toBe(format(date, { timeZone: deviceZone }));
    expect(format(date, {})).toBe(format(date));
  });

  it("does not mutate the original Date or discard its milliseconds", () => {
    const date = new Date("2026-10-02T00:01:02.987Z");
    expect(format(date, { timeZone: "UTC" })).toBe("2026-10-02 00:01:02");
    expect(date.toISOString()).toBe("2026-10-02T00:01:02.987Z");
    expect(format("2024-02-29T00:00:00Z", { timeZone: "UTC" })).toBe("2024-02-29 00:00:00");
  });

  it.each([null, undefined, new Date(NaN), "", "not a date", "2026-10-02", "09:00", "0000-01-01T00:00:00Z", "2026-02-30T12:00:00Z", "2025-02-29T12:00:00Z", "2026-13-01T00:00:00Z", "2026-10-02T24:00:00Z", "2026-10-02T00:60:00Z", "2026-10-02T00:00:60Z", "2026-10-02T00:00:00+24:00", "2026-10-02T00:00:00"])("rejects invalid or non-instant input %s", (value) => {
    expect(format(value, { timeZone: "UTC" })).toBe("—");
  });

  it("rejects an invalid timezone instead of silently using the device zone", () => {
    expect(format("2026-10-02T00:00:00Z", { timeZone: "invalid/zone" })).toBe("—");
    expect(format("2026-10-02T00:00:00Z", { timeZone: "" })).toBe("—");
  });
});
