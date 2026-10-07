import type { MonitoringActivityItem } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import { formatMonitoringActivity, monitoringActivityRows } from "./monitoring-activity-presentation";

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

describe("monitoringActivityRows", () => {
  it.each([
    ["fixture_status_changed", { status: "online" }, "정상"],
    ["fixture_status_changed", { status: "offline" }, "오프라인"],
    ["fixture_health_changed", { status: "fault" }, "점검 필요"],
    ["fixture_brightness_changed", { brightnessPercent: 0 }, "밝기 0%"],
    ["command_result", { commandOutcome: "applied" }, "적용 완료"],
    ["command_result", { commandOutcome: "partially_applied" }, "일부 적용"],
    ["command_result", { commandOutcome: "not_applied" }, "적용되지 않음"],
    ["command_result", { commandOutcome: "unknown" }, "결과 확인 불가"],
    ["monitoring_refresh_result", { refreshStatus: "completed" }, "완료"],
    ["monitoring_refresh_result", { refreshStatus: "partial" }, "일부 완료"],
    ["monitoring_refresh_result", { refreshStatus: "failed" }, "실패"],
    ["monitoring_refresh_result", { refreshStatus: "expired" }, "응답 시간 만료"]
  ] as const)("preserves actual %s event meaning (%j)", (kind, fields, content) => {
    const item = Object.freeze({ ...base, kind, ...fields } as MonitoringActivityItem);
    const input = Object.freeze([item]);
    const rows = monitoringActivityRows(input, "America/Los_Angeles");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(item.id);
    expect(rows[0].timestampLabel).toBe("2026-09-24 17:00:00");
    expect(rows[0].content).toContain(content);
    expect(rows[0].content).not.toContain("2026-09-24");
    expect(input[0]).toBe(item);
  });
});
