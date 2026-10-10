import { useEffect, useRef, useState } from "react";
import { Button, NumberField, Slider, Text } from "../../components/ui";

export interface ManualExecutionPanelProps {
  brightness: number;
  controlsLocked: boolean;
  canSubmit: boolean;
  applyLabel: string;
  onBrightnessChange: (value: number) => void;
  onSubmit: () => void;
}

/** Draft presentation only: the parent retains command ownership and eligibility. */
export function ManualExecutionPanel({ brightness, controlsLocked, canSubmit, applyLabel, onBrightnessChange, onSubmit }: ManualExecutionPanelProps) {
  const [invalidDraft, setInvalidDraft] = useState(false);
  const [restored, setRestored] = useState("");
  const [inputRevision, setInputRevision] = useState(0);
  const rawValid = useRef(true);
  const restoring = useRef(false);
  const invalidApplyAttempt = useRef(false);
  const applyRef = useRef<HTMLButtonElement>(null);
  const lastBrightness = useRef(brightness);
  useEffect(() => {
    if (lastBrightness.current === brightness) return;
    lastBrightness.current = brightness;
    rawValid.current = true; setInvalidDraft(false); setRestored("");
  }, [brightness]);

  function captureDraft(event: React.FormEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLInputElement) || event.target.type === "range") return;
    const draft = event.target.value.trim();
    const value = Number(draft);
    const valid = /^\d+$/.test(draft) && Number.isInteger(value) && value >= 0 && value <= 100;
    rawValid.current = valid; setInvalidDraft(!valid); setRestored("");
    if (valid) onBrightnessChange(value);
  }

  function restoreDraft() {
    if (rawValid.current) return;
    // React Aria normalizes during blur. Block that callback from replacing the
    // last valid number with a rounded/clamped invalid draft.
    restoring.current = true; rawValid.current = true;
    setInvalidDraft(false); setInputRevision(value => value + 1);
    setRestored(`마지막 정상 밝기 ${brightness}%로 복귀했습니다. 별도로 적용해 주세요.`);
    queueMicrotask(() => { restoring.current = false; });
  }

  function changeDraft(value: number) {
    rawValid.current = true; setInvalidDraft(false); setRestored("");
    setInputRevision(revision => revision + 1); onBrightnessChange(value);
  }

  // Execution reserves intrinsic height; only the independent safety region
  // consumes residual desktop space, so Apply never shares a fractional pane.
  return <div className="grid min-h-0 flex-none content-start gap-3 overflow-y-auto overscroll-contain" data-control-panel-body=""
    onPointerDownCapture={event => {
      if (event.target instanceof Element && event.target.closest("[data-control-submit]")) invalidApplyAttempt.current = !rawValid.current || restoring.current;
    }}>
    <div className="grid gap-2 border-t border-border-default pt-3" data-control-brightness-card="">
      <div className="flex items-baseline justify-between gap-3" onInputCapture={captureDraft} onChangeCapture={captureDraft}
        onBlurCapture={event => {
          if (event.target instanceof HTMLInputElement) {
            if (!rawValid.current && event.relatedTarget === applyRef.current) invalidApplyAttempt.current = true;
            restoreDraft();
          }
        }}
        onKeyDownCapture={event => {
          if (event.target instanceof HTMLInputElement && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); restoreDraft(); }
        }}>
        <Text as="span" variant="label">밝기 <Text as="span" variant="caption" tone="secondary">초안</Text></Text>
        <div className="flex min-w-0 items-baseline gap-1">
          <NumberField key={inputRevision} aria-label="밝기 수치" variant="ghost" size="lg"
            className="w-20" inputClassName="px-1 text-body text-right"
            minValue={0} maxValue={100} step={1} value={brightness} isDisabled={controlsLocked} isInvalid={invalidDraft}
            onChange={value => { if (rawValid.current && !restoring.current && value !== null && Number.isInteger(value) && value >= 0 && value <= 100) onBrightnessChange(value); }} />
          <Text as="span" variant="body" aria-hidden="true">%</Text>
        </div>
      </div>
      {invalidDraft ? <Text role="alert" tone="danger">0~100 사이 정수를 입력해 주세요.</Text> : null}
      {restored ? <Text role="status" variant="caption">{restored}</Text> : null}
      <Slider aria-label="밝기" presentation="bare" minValue={0} maxValue={100} step={1} value={brightness} isDisabled={controlsLocked} onChange={changeDraft} />
      <div role="group" aria-label="빠른 밝기 값" className="grid grid-cols-4 gap-1">
        {[0, 30, 70, 100].map(value => <Button key={value} type="button" variant="ghost" className="whitespace-nowrap px-2" aria-pressed={brightness === value && !invalidDraft}
          disabled={controlsLocked} onClick={() => changeDraft(value)}>{value}%</Button>)}
      </div>
    </div>
    <Button ref={applyRef} variant="primary" type="button" className="max-compact:scroll-mb-shell-navigation-safe" onClick={() => {
      if (invalidApplyAttempt.current) { invalidApplyAttempt.current = false; return; }
      if (!rawValid.current || restoring.current || !canSubmit) return;
      onSubmit();
    }} disabled={!canSubmit || invalidDraft} data-control-submit="">
      {applyLabel}
    </Button>
  </div>;
}
