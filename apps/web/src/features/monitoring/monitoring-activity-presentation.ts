import type { MonitoringActivityItem } from "@led-control/shared";
import { formatMonitoringTimestamp } from "./monitoring-time";

const statusLabel = { online: "정상", offline: "오프라인", fault: "점검 필요" } as const;
const commandOutcomeLabel = {
  applied: "적용 완료",
  not_applied: "적용되지 않음",
  partially_applied: "일부 적용",
  unknown: "결과 확인 불가"
} as const;
const refreshStatusLabel = {
  completed: "완료",
  partial: "일부 완료",
  failed: "실패",
  expired: "응답 시간 만료"
} as const;

export function formatMonitoringActivity(item: MonitoringActivityItem, timeZone: string) {
  const recordedAt = formatMonitoringTimestamp(item.recordedAt, timeZone);
  const name = item.displayName ?? "조명";
  const brightness = item.brightnessPercent === undefined ? "" : ` · 밝기 ${item.brightnessPercent}%`;
  const status = item.status === undefined ? "" : ` · ${statusLabel[item.status]}`;
  const content = (() => {
    switch (item.kind) {
      case "fixture_status_changed": return `${name} 상태 변경${status}`;
      case "fixture_brightness_changed": return `${name} 밝기 변경${brightness}`;
      case "fixture_health_changed": return `${name} 상태 점검${status}`;
      case "fixture_offline": return `${name} 오프라인`;
      case "fixture_online": return `${name} 정상 연결`;
      case "command_result": return `${item.displayName ? `${name} ` : ""}명령 결과 · ${item.commandOutcome ? commandOutcomeLabel[item.commandOutcome] : "결과 확인 불가"}`;
      case "monitoring_refresh_result": return `장치 상태 확인 · ${item.refreshStatus ? refreshStatusLabel[item.refreshStatus] : "결과 확인 불가"}`;
    }
  })();
  return `${recordedAt} · ${content}`;
}
