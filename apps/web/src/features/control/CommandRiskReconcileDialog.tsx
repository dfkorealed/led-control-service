import { useEffect, useState } from "react";
import type { CommandCaseReconcileInput, CommandVerificationCase } from "../../api/commands";
import { Button, Checkbox, ModalDialog, RadioGroup, Text, TextArea } from "../../components/ui";
import { formatControlTimestamp } from "./control-time";

export function CommandRiskReconcileDialog({ open, caseRecord, timeZone = "UTC", onClose, onSubmit }: {
  open: boolean;
  caseRecord: CommandVerificationCase;
  timeZone?: string;
  onClose: () => void;
  onSubmit: (input: CommandCaseReconcileInput) => Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [method, setMethod] = useState<CommandCaseReconcileInput["verificationMethod"] | "">("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    setMethod("");
    setReason("");
    setError("");
  }, [open, caseRecord.caseId]);
  const valid = acknowledged && Boolean(method) && reason.trim().length > 0 && reason.trim().length <= 500;

  async function submit() {
    if (!valid || !method || pending) return;
    setPending(true);
    setError("");
    try {
      await onSubmit({ acknowledgeRisk: true, verificationMethod: method, reason: reason.trim() });
    } catch {
      setError("위험 승인 처리 결과를 확인하지 못했습니다. 잠금은 유지됩니다. case를 다시 조회하세요.");
    } finally {
      setPending(false);
    }
  }

  return <ModalDialog isOpen={open} title="확인 불가 명령 위험 승인" description="이 작업은 명령을 재전송하지 않습니다. 실제 조명 상태를 확인한 책임과 사유가 감사 기록에 남습니다." onClose={onClose} isPending={pending}
    actions={<Button type="button" variant="primary" disabled={!valid || pending} onClick={() => void submit()}>위험 승인 및 차단 해제</Button>}>
    <div className="grid gap-4">
      <Text>영향 대상 {caseRecord.targetCount}개 조명 · 원본 명령 {caseRecord.originalCommandId}</Text>
      <RadioGroup label="확인 방법" value={method} onChange={(value) => setMethod(value as CommandCaseReconcileInput["verificationMethod"])} items={[
        { value: "verified_physical_state", label: "물리 상태 확인 완료" },
        { value: "unable_to_verify", label: "물리 상태를 확인할 수 없음" }
      ]} />
      {method === "unable_to_verify" ? <div role="alert" className="rounded-panel border border-status-warning-foreground p-3">
        <Text tone="warning">결과가 불확실한 상태입니다. 영향 대상 {caseRecord.targetCount}개 조명, 마지막 확인 {caseRecord.lastCheckedAt ? formatControlTimestamp(caseRecord.lastCheckedAt, timeZone) : "기록 없음"} ({timeZone}). 상태를 확인하지 못한 위험을 승인합니다.</Text>
      </div> : null}
      <TextArea label="승인 사유" value={reason} onChange={setReason} maxLength={500} rows={3} description="500자 이내로 구체적인 판단 근거를 남기세요." />
      <Checkbox label="실제 상태가 불확실할 수 있는 위험을 이해하고 승인합니다" isSelected={acknowledged} onChange={setAcknowledged} />
      {error ? <Text role="alert" tone="danger">{error}</Text> : null}
    </div>
  </ModalDialog>;
}
