import type { EnergyReportRequest, EnergyReportTargetsResponse, EnergyScope } from "@led-control/shared/energy-p2-contracts";
import { useEffect, useRef, useState } from "react";
import type { MobileFileDownloadOutcome } from "../../mobile/file-download";
import { energyReportRequestErrorMessage, type EnergyReportRequestAction } from "../../../api/energy";
import { Button, DatePicker, formatIsoDate, ModalDialog, parseIsoDate, SelectBox, Text } from "../../../components/ui";
import { completedDateBounds } from "../completed-date-bounds";

const scopeItems: Array<{ id: EnergyScope; label: string }> = [
  { id: "site", label: "현장" },
  { id: "fixture", label: "조명" },
  { id: "floor", label: "층" },
  { id: "group", label: "그룹" }
];
const reportDatePickerClass = "[&_[role=spinbutton]]:relative [&_[role=spinbutton]]:z-10 [&_[role=spinbutton]]:rounded-none! [&_button]:min-h-14 [&_button]:min-w-14";

export function ReportCreateDialog({
  siteId,
  targetData,
  isTargetsLoading,
  isTargetsError,
  onClose,
  onCreate,
  onExportCsv,
  onFileNotice
}: {
  siteId: string;
  targetData?: EnergyReportTargetsResponse;
  isTargetsLoading: boolean;
  isTargetsError: boolean;
  onClose: () => void;
  onCreate: (request: EnergyReportRequest) => Promise<void>;
  onExportCsv: (request: Omit<EnergyReportRequest, "format">, signal: AbortSignal) => Promise<MobileFileDownloadOutcome | void>;
  onFileNotice?: (notice: string) => void;
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
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingAction, setPendingAction] = useState<EnergyReportRequestAction>();
  const operationRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    // Unmount/site replacement must not share the previous site's late file or close its new dialog.
    operationRef.current?.abort(); operationRef.current = null;
  }, []);
  const targets = targetData?.targets.filter(target => target.scope === scope) ?? [];
  const identityId = selectedIdentityId ?? targets[0]?.identityId ?? "";
  const hasValidTarget = targets.some((target) => target.identityId === identityId);
  const targetMessage = isTargetsLoading ? "대상을 불러오는 중입니다."
    : isTargetsError || !targetData ? "대상 정보를 불러오지 못했습니다."
    : !targets.length ? "선택한 범위에 등록된 대상이 없습니다." : "";
  const validPeriod = Boolean(from && to && from <= to && to <= completedDate);
  const dateBounds = completedDateBounds(from, to, completedDate);
  const canSubmit = hasValidTarget && !targetMessage && validPeriod;

  function setReportScope(nextScope: EnergyScope) {
    setScope(nextScope);
    setIdentityId(targetData?.targets.find(target => target.scope === nextScope)?.identityId);
  }
  async function perform(actionType: EnergyReportRequestAction, action: (signal: AbortSignal) => Promise<MobileFileDownloadOutcome | void>) {
    if (!canSubmit || operationRef.current) return;
    const operation = new AbortController();
    operationRef.current = operation;
    setError("");
    setNotice("");
    setPendingAction(actionType);
    setIsPending(true);
    try {
      const outcome = await action(operation.signal);
      if (operationRef.current !== operation) return;
      if (outcome === "cancelled" || operation.signal.aborted) {
        setNotice("파일 공유를 취소했습니다."); return;
      }
      if (outcome === "handoff") onFileNotice?.("공유창을 닫았습니다.");
      onClose();
    } catch (requestError) {
      if (operationRef.current !== operation) return;
      if (operation.signal.aborted) setNotice("파일 공유를 취소했습니다.");
      else setError(energyReportRequestErrorMessage(requestError, actionType));
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null; setIsPending(false); setPendingAction(undefined);
      }
    }
  }

  return (
    <ModalDialog
      className="flex max-w-[var(--container-lg)] flex-col overflow-hidden [&_[data-dialog-header]]:shrink-0 [&_[data-dialog-actions]]:shrink-0 [&_[data-dialog-close]]:h-14! [&_[data-dialog-close]]:min-h-14! [&_[data-dialog-close]]:w-14! [&_[data-dialog-close]]:min-w-14!"
      bodyClassName="min-h-0 overflow-y-auto"
      title="에너지 사용량 보고서 만들기"
      description="선택한 기간과 대상의 에너지 사용량을 PDF 보고서로 만듭니다. 원본 자료는 CSV로 내보낼 수 있습니다."
      onClose={onClose}
      isPending={isPending}
      actions={<>
        {error ? <Text role="alert" variant="body-sm" tone="danger" className="basis-full">{error}</Text> : null}
        {notice ? <Text role="status" variant="body-sm" className="basis-full">{notice}</Text> : null}
        {pendingAction === "csv" ? <Button variant="secondary" onClick={() => operationRef.current?.abort()}>파일 준비 취소</Button> : null}
        <Button variant="secondary" disabled={!canSubmit}
          onClick={() => void perform("csv", (signal) => onExportCsv({ from, to, scope, identityId }, signal))}
          isLoading={isPending} loadingLabel="내보내는 중">CSV 내보내기</Button>
        <Button variant="primary" disabled={!canSubmit}
          onClick={() => void perform("create", () => onCreate({ from, to, scope, identityId, format: "pdf" }))}
          isLoading={isPending} loadingLabel="요청 중">보고서 요청</Button>
      </>}
    >
      <div className="grid min-w-0 grid-cols-2 gap-3 max-compact:grid-cols-1">
        <Text variant="body-sm" tone="secondary" className="col-span-full">보고서 대상 기간은 현장 시간대의 마지막 완료일까지 선택할 수 있습니다.</Text>
        <Text variant="body-sm" tone="muted" className="col-span-full">보고서와 CSV 비용은 당시 적용 단가의 저장 비용입니다.</Text>
        <DatePicker className={reportDatePickerClass} label="기간 시작" value={from || null} {...dateBounds.start} isInvalid={Boolean(completedDate) && !validPeriod}
          onChange={setFrom} />
        <DatePicker className={reportDatePickerClass} label="기간 종료" value={to || null} {...dateBounds.end} isInvalid={Boolean(completedDate) && !validPeriod}
          onChange={setTo} />
        <SelectBox label="범위" items={scopeItems} selectedKey={scope} onSelectionChange={(value) => value && setReportScope(value)} />
        <SelectBox label="대상" items={targets.map((target) => ({ id: target.identityId, label: target.label }))}
          selectedKey={hasValidTarget ? identityId : null} isDisabled={Boolean(targetMessage)} onSelectionChange={(value) => value && setIdentityId(value)} />
        {targetMessage ? <Text role="status" variant="body-sm" tone="secondary" className="col-span-full">{targetMessage}</Text> : null}
        {completedDate && !validPeriod ? <Text role="alert" variant="body-sm" tone="danger" className="col-span-full">시작일과 종료일을 마지막 완료일 이내의 순서대로 선택해 주세요.</Text> : null}
      </div>
    </ModalDialog>
  );
}
