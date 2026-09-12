import type { EnergyReportFormat, EnergyReportRequest, EnergyReportTargetsResponse, EnergyScope } from "@led-control/shared/energy-p2-contracts";
import { useState } from "react";
import { Button, ModalDialog } from "../../../components/ui";

export function ReportCreateDialog({
  siteId,
  targetData,
  isTargetsLoading,
  isTargetsError,
  onClose,
  onCreate,
  onExportCsv
}: {
  siteId: string;
  targetData?: EnergyReportTargetsResponse;
  isTargetsLoading: boolean;
  isTargetsError: boolean;
  onClose: () => void;
  onCreate: (request: EnergyReportRequest) => Promise<void>;
  onExportCsv: (request: Omit<EnergyReportRequest, "format">) => Promise<void>;
}) {
  const [selectedFrom, setFrom] = useState<string>();
  const [selectedTo, setTo] = useState<string>();
  const completedDate = targetData?.lastCompletedDate ?? "";
  const to = selectedTo ?? completedDate;
  const from = selectedFrom ?? (completedDate ? new Date(Date.parse(`${completedDate}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10) : "");
  const [scope, setScope] = useState<EnergyScope>("site");
  const [selectedIdentityId, setIdentityId] = useState<string | undefined>(siteId);
  const [format, setFormat] = useState<EnergyReportFormat>("xlsx");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  const targets = targetData?.targets.filter(target => target.scope === scope) ?? [];
  const identityId = selectedIdentityId ?? targets[0]?.identityId ?? "";
  const hasValidTarget = targets.some((target) => target.identityId === identityId);
  const targetMessage = isTargetsLoading ? "대상을 불러오는 중입니다."
    : isTargetsError || !targetData ? "대상 정보를 불러오지 못했습니다."
    : !targets.length ? "선택한 범위에 등록된 대상이 없습니다." : "";
  const canSubmit = hasValidTarget && !targetMessage && Boolean(from && to && from <= to && to <= completedDate);

  function setReportScope(nextScope: EnergyScope) {
    setScope(nextScope);
    setIdentityId(targetData?.targets.find(target => target.scope === nextScope)?.identityId);
  }
  async function perform(action: () => Promise<void>) {
    if (!canSubmit) return;
    setError("");
    setIsPending(true);
    try {
      await action();
      onClose();
    } catch {
      setError("요청을 완료하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <ModalDialog
      className="statistics-report-dialog"
      title="에너지 사용량 보고서 만들기"
      description="XLSX와 PDF는 동일한 표준 보고서 내용을 파일 형식만 다르게 제공합니다."
      onClose={onClose}
      isPending={isPending}
      actions={<><Button variant="secondary" disabled={!canSubmit} onClick={() => void perform(() => onExportCsv(({ from, to, scope, identityId })))} isLoading={isPending} loadingLabel="내보내는 중">CSV 내보내기</Button><Button variant="primary" disabled={!canSubmit} onClick={() => void perform(() => onCreate({ from, to, scope, identityId, format }))} isLoading={isPending} loadingLabel="요청 중">보고서 요청</Button></>}
    >
      <div className="statistics-report-form">
        <label>기간 시작<input aria-label="기간 시작" type="date" value={from} max={to && to < completedDate ? to : completedDate} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>기간 종료<input aria-label="기간 종료" type="date" value={to} min={from} max={completedDate} onChange={(event) => setTo(event.target.value)} /></label>
        <label>범위<select aria-label="범위" value={scope} onChange={(event) => setReportScope(event.target.value as EnergyScope)}>
          <option value="site">현장</option><option value="fixture">조명</option><option value="floor">층</option><option value="group">그룹</option>
        </select></label>
        <label>대상<select aria-label="대상" value={identityId} disabled={Boolean(targetMessage)} onChange={(event) => setIdentityId(event.target.value)}>
          {targets.map((target) => <option key={target.identityId} value={target.identityId}>{target.label}</option>)}
        </select></label>
        <label>파일 형식<select aria-label="파일 형식" value={format} onChange={(event) => setFormat(event.target.value as EnergyReportFormat)}>
          <option value="xlsx">XLSX</option><option value="pdf">PDF</option>
        </select></label>
        {targetMessage ? <p role="status">{targetMessage}</p> : null}
        {error ? <p role="alert" className="danger-text">{error}</p> : null}
      </div>
    </ModalDialog>
  );
}
