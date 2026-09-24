import type { EnergyReportFormat, EnergyReportRequest, EnergyReportTargetsResponse, EnergyScope } from "@led-control/shared/energy-p2-contracts";
import { useState } from "react";
import { energyReportRequestErrorMessage, type EnergyReportRequestAction } from "../../../api/energy";
import { Button, DatePicker, formatIsoDate, ModalDialog, parseIsoDate, SelectBox, Text } from "../../../components/ui";

const scopeItems: Array<{ id: EnergyScope; label: string }> = [
  { id: "site", label: "현장" },
  { id: "fixture", label: "조명" },
  { id: "floor", label: "층" },
  { id: "group", label: "그룹" }
];
const formatItems: Array<{ id: EnergyReportFormat; label: string }> = [
  { id: "xlsx", label: "XLSX" },
  { id: "pdf", label: "PDF" }
];
const reportDatePickerClass = "[&_[role=spinbutton]]:relative [&_[role=spinbutton]]:z-10 [&_[role=spinbutton]]:rounded-none! [&_button]:min-h-14 [&_button]:min-w-14";

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
  const [selectedFrom, setFrom] = useState<string | null>();
  const [selectedTo, setTo] = useState<string | null>();
  const completedDate = targetData?.lastCompletedDate ?? "";
  const to = selectedTo === undefined ? completedDate : selectedTo ?? "";
  const from = selectedFrom === undefined
    ? (completedDate ? formatIsoDate(parseIsoDate(completedDate).subtract({ days: 29 })) : "")
    : selectedFrom ?? "";
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
  async function perform(actionType: EnergyReportRequestAction, action: () => Promise<void>) {
    if (!canSubmit) return;
    setError("");
    setIsPending(true);
    try {
      await action();
      onClose();
    } catch (requestError) {
      setError(energyReportRequestErrorMessage(requestError, actionType));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <ModalDialog
      className="max-w-[var(--container-lg)] [&_[data-dialog-close]]:h-14! [&_[data-dialog-close]]:min-h-14! [&_[data-dialog-close]]:w-14! [&_[data-dialog-close]]:min-w-14!"
      title="에너지 사용량 보고서 만들기"
      description="XLSX와 PDF는 동일한 표준 보고서 내용을 파일 형식만 다르게 제공합니다."
      onClose={onClose}
      isPending={isPending}
      actions={<><Button variant="secondary" disabled={!canSubmit} onClick={() => void perform("csv", () => onExportCsv(({ from, to, scope, identityId })))} isLoading={isPending} loadingLabel="내보내는 중">CSV 내보내기</Button><Button variant="primary" disabled={!canSubmit} onClick={() => void perform("create", () => onCreate({ from, to, scope, identityId, format }))} isLoading={isPending} loadingLabel="요청 중">보고서 요청</Button></>}
    >
      <div className="grid min-w-0 grid-cols-2 gap-3 max-compact:grid-cols-1">
        <Text variant="body-sm" tone="secondary" className="col-span-full">보고서 대상 기간은 현장 시간대의 마지막 완료일까지 선택할 수 있습니다.</Text>
        <DatePicker className={reportDatePickerClass} label="기간 시작" value={from || null} maxValue={to && to < completedDate ? to : completedDate || undefined}
          onChange={setFrom} />
        <DatePicker className={reportDatePickerClass} label="기간 종료" value={to || null} minValue={from || undefined} maxValue={completedDate || undefined}
          onChange={setTo} />
        <SelectBox label="범위" items={scopeItems} selectedKey={scope} onSelectionChange={(value) => value && setReportScope(value)} />
        <SelectBox label="대상" items={targets.map((target) => ({ id: target.identityId, label: target.label }))}
          selectedKey={hasValidTarget ? identityId : null} isDisabled={Boolean(targetMessage)} onSelectionChange={(value) => value && setIdentityId(value)} />
        <SelectBox label="파일 형식" items={formatItems} selectedKey={format} onSelectionChange={(value) => value && setFormat(value)} />
        {targetMessage ? <Text role="status" variant="body-sm" tone="secondary" className="col-span-full">{targetMessage}</Text> : null}
        {error ? <Text role="alert" variant="body-sm" tone="danger" className="col-span-full">{error}</Text> : null}
      </div>
    </ModalDialog>
  );
}
