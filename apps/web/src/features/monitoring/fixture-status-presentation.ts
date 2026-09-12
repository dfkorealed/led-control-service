import type { StatusTone } from "../../components/ui/StatusBadge";

export type FixtureStatus = "online" | "offline" | "fault";
export type FixtureStatusReason =
  | "reported"
  | "mesh_publication"
  | "startup_resync"
  | "fixture_stale"
  | "gateway_offline"
  | "command_failed"
  | "provisioning_waiting_state"
  | null
  | undefined;

export interface FixtureStatusPresentation {
  label: string;
  description: string;
  recommendedAction: string;
  tone: StatusTone;
  state: "provisioning_waiting_state" | "gateway_offline" | "fixture_stale" | "command_failed" | "fault" | "online" | "offline";
}

export function presentFixtureStatus({
  status,
  statusReason,
  health
}: {
  status: FixtureStatus;
  statusReason?: FixtureStatusReason;
  health?: { faultCodes: readonly number[]; observedAt: string } | null;
}): FixtureStatusPresentation {
  if (statusReason === "provisioning_waiting_state") {
    return presentation("상태 확인 대기", "조명이 등록된 뒤 최초 상태 보고를 기다리고 있습니다.", "최초 상태 수신 대기", "warning", "provisioning_waiting_state");
  }
  if (statusReason === "gateway_offline") {
    return presentation("게이트웨이 오프라인", "연결된 게이트웨이가 현장 기준 시간 안에 응답하지 않았습니다.", "게이트웨이 연결 확인", "danger", "gateway_offline");
  }
  if (statusReason === "fixture_stale") {
    return presentation("상태 수신 지연", "조명의 마지막 상태 보고가 현장 freshness 기준을 지났습니다.", "조명 통신 상태 확인", "warning", "fixture_stale");
  }
  if (statusReason === "command_failed") {
    return presentation("명령 처리 실패", "마지막 조명 명령이 정상적으로 처리되지 않았습니다.", "명령 이력 및 조명 연결 확인", "danger", "command_failed");
  }
  if (status === "fault" || (health?.faultCodes.length ?? 0) > 0) {
    return presentation("장애", "조명 또는 Health Current가 장애를 보고했습니다.", "Health fault 확인", "danger", "fault");
  }
  if (status === "online") {
    return presentation("정상", "조명이 최신 상태를 정상적으로 보고했습니다.", "조치 불필요", "success", "online");
  }
  return presentation("오프라인", "조명의 현재 연결 상태를 확인할 수 없습니다.", "조명 연결 확인", "neutral", "offline");
}

function presentation(
  label: string,
  description: string,
  recommendedAction: string,
  tone: StatusTone,
  state: FixtureStatusPresentation["state"]
): FixtureStatusPresentation {
  return { label, description, recommendedAction, tone, state };
}
