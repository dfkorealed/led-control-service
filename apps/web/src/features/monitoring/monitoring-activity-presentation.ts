import type { MonitoringActivityItem } from "@led-control/shared/monitoring-activity-contracts";
import type { RecentActivityRow } from "../../components/ui";
import { StatusBadge, type StatusTone } from "../../components/ui";
import { createElement } from "react";
import { CircleAlert, CircleCheck, CircleX, Clock3, type LucideIcon } from "lucide-react";
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

export function monitoringActivityContent(item: MonitoringActivityItem) {
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
  return content;
}

export function monitoringActivityStatus(item: MonitoringActivityItem): { label: string; tone: StatusTone; icon: LucideIcon } | null {
  if (item.kind === "command_result") {
    const outcome = item.commandOutcome ?? "unknown";
    return { label: commandOutcomeLabel[outcome], tone: outcome === "applied" ? "success" : outcome === "partially_applied" ? "warning" : outcome === "not_applied" ? "danger" : "neutral", icon: outcome === "applied" ? CircleCheck : outcome === "unknown" ? Clock3 : CircleAlert };
  }
  if (item.kind === "monitoring_refresh_result") {
    const status = item.refreshStatus;
    return status ? { label: refreshStatusLabel[status], tone: status === "completed" ? "success" : status === "partial" ? "warning" : "danger", icon: status === "completed" ? CircleCheck : CircleAlert } : { label: "결과 확인 불가", tone: "neutral", icon: Clock3 };
  }
  const status = item.kind === "fixture_online" ? "online" : item.kind === "fixture_offline" ? "offline" : item.status;
  return status ? { label: statusLabel[status], tone: status === "online" ? "success" : status === "fault" ? "danger" : "neutral", icon: status === "online" ? CircleCheck : status === "fault" ? CircleAlert : CircleX } : null;
}

export function formatMonitoringActivity(item: MonitoringActivityItem, timeZone: string) {
  return `${formatMonitoringTimestamp(item.recordedAt, timeZone)} · ${monitoringActivityContent(item)}`;
}

/** Keep the recorded event's actual meaning; the shared ticker never owns query/retention. */
export function monitoringActivityRows(items: readonly MonitoringActivityItem[], timeZone: string): readonly RecentActivityRow[] {
  return items.map(item => {
    const status = monitoringActivityStatus(item);
    return { id: item.id, timestampLabel: formatMonitoringTimestamp(item.recordedAt, timeZone), content: monitoringActivityContent(item),
      status: status ? createElement(StatusBadge, { tone: status.tone, icon: status.icon, children: status.label }) : undefined };
  });
}
