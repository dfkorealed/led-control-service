import { useEffect, useRef, useState } from "react";
import { Button, ModalDialog, NumberField, Text } from "../../components/ui";
import { temporaryControlStateLabels, temporaryControlIsTerminal } from "../../api/temporary-controls";
import { formatControlTimestamp } from "./control-time";
import type { TemporaryControlSessionController } from "./useTemporaryControlSession";

export interface TemporaryControlPanelProps {
  controller: TemporaryControlSessionController; brightness: number; fixtureIds: readonly string[]; compact: boolean;
  durationMinutes: number; onDurationChange(value: number): void; timeZone?: string; writesAllowed?: boolean;
}
export function TemporaryControlPanel({ controller, brightness, fixtureIds, compact, durationMinutes, onDurationChange, timeZone = "UTC", writesAllowed = true }: TemporaryControlPanelProps) {
  const [endConfirm, setEndConfirm] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const sample = useRef(performance.now());
  const validDraft = useRef(true);
  const current = controller.session;
  useEffect(() => {
    sample.current = performance.now(); setElapsed(0);
    if (!current) return;
    const timer = window.setInterval(() => setElapsed(Math.max(0, performance.now() - sample.current)), 1000);
    return () => clearInterval(timer);
  }, [current?.id, current?.now]);
  const uncertain = current && ["partial", "unknown", "recovery_pending"].includes(current.state);
  const remaining = current ? Math.max(0, Math.ceil((Date.parse(current.endsAt) - Date.parse(current.now) - elapsed) / 1000)) : null;
  const durationValid = Number.isInteger(durationMinutes) && durationMinutes >= 1 && durationMinutes <= 1440;
  return <section aria-label="시간제 제어" className="grid min-w-0 gap-2" data-temporary-control-panel="">
    <div role="group" aria-label="유지시간 프리셋" className="flex flex-wrap gap-1">
      {[15,30,60,120].map(value => <Button key={value} type="button" variant="ghost" aria-pressed={durationMinutes === value}
        disabled={controller.controlsLocked || !writesAllowed} onClick={() => { validDraft.current = true; onDurationChange(value); }}>{value}분</Button>)}
    </div>
    <div onInputCapture={event => {
      if (!(event.target instanceof HTMLInputElement)) return;
      const raw = event.target.value.trim(), value = Number(raw);
      validDraft.current = /^\d+$/.test(raw) && Number.isInteger(value) && value >= 1 && value <= 1440;
      onDurationChange(validDraft.current ? value : Number.NaN);
    }}>
      <NumberField label="유지시간(분)" formatOptions={{ useGrouping: false }} minValue={1} maxValue={1440} step={1} value={durationValid ? durationMinutes : null}
        isDisabled={controller.controlsLocked || !writesAllowed} isInvalid={!durationValid}
        errorMessage={!durationValid ? "1~1440 사이 정수를 입력해 주세요." : undefined}
        onChange={value => { if (validDraft.current && value !== null && Number.isInteger(value) && value >= 1 && value <= 1440) onDurationChange(value); }} />
    </div>
    {!current ? <Text variant="caption">{fixtureIds.length}개 조명 · {brightness}% · {durationValid ? `${durationMinutes}분 유지 · 예상 종료 ${formatControlTimestamp(Date.now() + durationMinutes * 60000, timeZone)}` : "유지시간 확인 필요"}</Text> : <>
      <Text role={uncertain ? undefined : "status"} variant={compact ? "caption" : "body"}>{temporaryControlStateLabels[current.state]}</Text>
      <Text variant="caption">확정 종료 {formatControlTimestamp(current.endsAt, timeZone)} · 남은 시간 {remaining}초</Text>
      {uncertain ? <Text role="alert" tone="danger">{temporaryControlStateLabels[current.state]} · 확인 전 새 제어는 잠겨 있습니다.</Text> : null}
      {current.results.some(result => result.configurationMayHaveChanged) && uncertain ? <Text variant="caption">설정 변경 가능 · 조명별 적용과 복귀 결과를 확인해 주세요.</Text> : null}
      {!temporaryControlIsTerminal(current) ? <Button type="button" variant="secondary" disabled={!writesAllowed || current.state === "releasing"} onClick={() => setEndConfirm(true)}>지금 종료</Button> : null}
    </>}
    {controller.error ? <Text role="alert" tone="danger">{controller.error}</Text> : null}
    {controller.controlsLocked ? <Button type="button" variant="secondary" onClick={() => void controller.refresh()}>접수·상태 다시 확인</Button> : null}
    <ModalDialog isOpen={endConfirm} title="시간제 제어 종료" onClose={() => setEndConfirm(false)} actions={<>
      <Button type="button" variant="secondary" onClick={() => setEndConfirm(false)}>계속 유지</Button>
      <Button type="button" variant="primary" disabled={!writesAllowed} onClick={() => { setEndConfirm(false); void controller.end({ clientRequestId: crypto.randomUUID() }); }}>종료 확인</Button>
    </>}><Text>최신 자동 운전으로 복귀를 요청합니다. 실제 복귀 결과는 조명 보고 후 확인합니다.</Text></ModalDialog>
  </section>;
}
