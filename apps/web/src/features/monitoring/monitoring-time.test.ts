import { describe, expect, it } from "vitest";
import { formatMonitoringTimestamp } from "./monitoring-time";

describe("formatMonitoringTimestamp", () => {
  it("renders seconds and midnight with a safe invalid value", () => {
    expect(formatMonitoringTimestamp("2026-10-01T15:00:01.123Z", "Asia/Seoul")).toBe("2026-10-02 00:00:01");
    expect(formatMonitoringTimestamp("bad timestamp", "Asia/Seoul")).toBe("—");
  });
  it("uses the site time zone for a real observation instead of the browser time zone", () => {
    expect(formatMonitoringTimestamp("2026-09-25T00:00:00.000Z", "Asia/Seoul")).toMatch(/2026.*09.*25.*09:00/);
    expect(formatMonitoringTimestamp("2026-09-25T00:00:00.000Z", "America/Los_Angeles")).toMatch(/2026.*09.*24.*17:00/);
  });
});
