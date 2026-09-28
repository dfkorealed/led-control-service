import type { MonitoringActivityItem } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { formatMonitoringActivity } from "./monitoring-activity-presentation";

const base: MonitoringActivityItem = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "fixture_brightness_changed",
  recordedAt: "2026-09-25T00:00:00.000Z",
  displayName: "B-04",
  brightnessPercent: 70
};

describe("formatMonitoringActivity", () => {
  it("uses event-time name, measured value and the site's absolute time zone", () => {
    expect(formatMonitoringActivity(base, "Asia/Seoul")).toContain("09:00");
    expect(formatMonitoringActivity(base, "Asia/Seoul")).toContain("B-04");
    expect(formatMonitoringActivity(base, "Asia/Seoul")).toContain("70%");
  });

  it("uses a result snapshot after command originals expire and never invents a device", () => {
    expect(formatMonitoringActivity({ ...base, kind: "command_result", brightnessPercent: undefined, commandOutcome: "not_applied", displayName: undefined }, "Asia/Seoul")).toContain("적용되지 않음");
    expect(formatMonitoringActivity({ ...base, kind: "monitoring_refresh_result", brightnessPercent: undefined, displayName: undefined, refreshStatus: "partial" }, "Asia/Seoul")).toContain("일부 완료");
  });
});
