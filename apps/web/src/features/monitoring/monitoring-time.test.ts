import { describe, expect, it } from "vitest";
import { formatMonitoringTimestamp } from "./monitoring-time";

describe("formatMonitoringTimestamp", () => {
  it("uses the site time zone for a real observation instead of the browser time zone", () => {
    expect(formatMonitoringTimestamp("2026-09-25T00:00:00.000Z", "Asia/Seoul")).toMatch(/2026.*09.*25.*09:00/);
    expect(formatMonitoringTimestamp("2026-09-25T00:00:00.000Z", "America/Los_Angeles")).toMatch(/2026.*09.*24.*17:00/);
  });
});
