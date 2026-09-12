import { CircleCheck, TriangleAlert } from "lucide-react";
import { hasPendingStatusCheck, type CommandStatusResponse } from "../../api/commands";
import { Button, Card, StatusBadge } from "../../components/ui";
import { humanizeDeviceResponseMessage } from "./control-copy";

export interface CommandOutcomeActionsProps {
  status: CommandStatusResponse;
  onCheck: () => void;
  onRetry: () => void;
  disabled?: boolean;
  checkResponseLost?: boolean;
}

export function CommandOutcomeActions({ status, onCheck, onRetry, disabled = false, checkResponseLost = false }: CommandOutcomeActionsProps) {
  const unknown = status.stage === "verification_required";
  const notApplied = status.stage === "verified_not_applied";
  const applied = status.stage === "verified_applied";
  const partial = status.stage === "verified_partial";
  if (!unknown && !notApplied && !applied && !partial) return null;

  const attempts = status.verificationAttemptCount ?? 0;
  const checking = hasPendingStatusCheck(status);
  const latestResults = status.dispatches.filter((dispatch) => dispatch.kind === "status_check"
    && dispatch.verificationAttempt === attempts).flatMap((dispatch) => dispatch.results);
  const reasons = [...new Set(status.dispatches.map((dispatch) => dispatch.errorCode ?? dispatch.errorMessage)
    .filter((reason): reason is string => Boolean(reason)))];

  return (
    <Card className="command-outcome-actions" aria-label="명령 결과 후속 조치">
      <StatusBadge tone={applied ? "success" : "warning"} icon={applied ? CircleCheck : TriangleAlert}>
        {unknown ? "실제 상태 확인 필요" : notApplied ? "미적용 확인" : applied ? "적용 확인" : "일부 적용 확인"}
      </StatusBadge>
      {unknown ? <>
        <p>현장 상태를 확인하지 못했습니다. 현재 밝기를 읽어 적용 여부를 확인하세요.</p>
        {status.errorMessage ? <small>{verificationReason(status.errorMessage)}</small> : null}
        {reasons.map((reason) => <small key={reason}>{verificationReason(reason)}</small>)}
        <small>상태 확인 {attempts} / 3회</small>
        {checking || attempts < 3 || checkResponseLost ? (
          <Button variant="secondary" type="button" disabled={disabled || checking} onClick={onCheck}>
            {checking ? "실제 상태 확인 중" : checkResponseLost ? "동일 상태 확인 요청 조회" : "실제 상태 확인"}
          </Button>
        ) : <p className="danger-text">3회 확인 후에도 상태가 불확실합니다. 현장 확인이 필요합니다.</p>}
      </> : null}
      {notApplied ? <>
        <p>원래 요청한 밝기가 적용되지 않았습니다. 원래 대상과 밝기로 새 명령을 만듭니다.</p>
        <Button variant="secondary" type="button" disabled={disabled} onClick={onRetry}>안전하게 다시 적용</Button>
      </> : null}
      {applied ? <p>요청한 밝기가 이미 적용되어 있습니다.</p> : null}
      {partial ? <>
        <p>일부 조명의 밝기가 다릅니다. 대상별 현재값을 확인한 뒤 필요한 조명과 밝기를 선택해 새로 제어하세요.</p>
        {latestResults.map((result) => <small key={result.fixtureId}>
          {result.fixtureName}: {result.brightness == null ? "현재 밝기 확인 불가" : `현재 ${result.brightness}%`}
        </small>)}
      </> : null}
    </Card>
  );
}

function verificationReason(value: string) {
  const labels: Record<string, string> = {
    STATUS_TIMEOUT: "조명 상태 응답 시간 초과",
    ACCEPTANCE_TIMEOUT: "게이트웨이 수신 응답 시간 초과",
    gateway_restarted: "게이트웨이 재시작으로 결과 확인 필요",
    GATEWAY_RESTARTED: "게이트웨이 재시작으로 결과 확인 필요"
  };
  return labels[value] ?? humanizeDeviceResponseMessage(value);
}
