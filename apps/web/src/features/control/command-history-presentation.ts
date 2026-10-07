import type { CommandStage, CommandStatusResponse } from "../../api/commands";
import type { RecentActivityRow } from "../../components/ui";
import { formatControlTimestamp } from "./control-time";

export const COMMAND_STAGE_LABELS: Record<CommandStage, string> = {
  queued: "명령 접수 완료", published: "게이트웨이 전송 완료", accepted: "게이트웨이 수신 완료",
  completed: "조명 적용 완료", partial_failed: "일부 조명 적용 실패", failed: "명령 처리 실패", timed_out: "명령 응답 시간 초과",
  verification_required: "실제 상태 확인 필요", verified_applied: "적용 확인", verified_not_applied: "미적용 확인", verified_partial: "일부 적용 확인"
};
export const clockRefusalExplanation = "게이트웨이 시각을 확인할 수 없어 조명에 전송하기 전 거부했습니다. 자동 재실행되지 않습니다.";

export function isClockRefusal(item: Omit<CommandStatusResponse, "dispatches">): boolean {
  // History has no dispatch details. Only this exact terminal not-applied
  // outcome identifies refusal before RF; unknown/partial retain verification.
  return item.errorCode === "GATEWAY_CLOCK_UNTRUSTED" && item.stage === "failed" && item.outcome === "not_applied";
}

export function commandHistoryRows(items: readonly Omit<CommandStatusResponse, "dispatches">[], timeZone: string): readonly RecentActivityRow[] {
  return items.map(item => ({
    id: item.id,
    timestampLabel: item.createdAt ? formatControlTimestamp(item.createdAt, timeZone) : "시각 미확인",
    content: `${isClockRefusal(item) ? "시각 확인 실패 · 조명 전송 전 거부 · " : ""}${item.totalFixtureCount}개 조명 · ${item.brightness ?? "—"}%`,
    status: isClockRefusal(item) ? clockRefusalExplanation : COMMAND_STAGE_LABELS[item.stage]
  }));
}
