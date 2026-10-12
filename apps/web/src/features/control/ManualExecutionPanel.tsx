import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ManualAuxiliaryContent, manualCompactButtonHitClassName, useManualAuxiliary } from "./manual-workspace/ManualAuxiliaryPanel";
import { Button, NumberField, Slider, Text } from "../../components/ui";

export interface ManualExecutionPanelProps {
  brightness: number;
  controlsLocked: boolean;
  canSubmit: boolean;
  applyLabel: string;
  onBrightnessChange: (value: number) => void;
  onSubmit: () => void;
  /** Manual mobile presentation only; desktop/default consumers keep all controls expanded. */
  compact?: boolean;
  moreContent?: ReactNode;
  importantStatus?: ReactNode;
}

/** Draft presentation only: the parent retains command ownership and eligibility. */
export function ManualExecutionPanel({ brightness, controlsLocked, canSubmit, applyLabel, onBrightnessChange, onSubmit, compact = false, moreContent, importantStatus }: ManualExecutionPanelProps) {
  const [inlineMoreOpen, setMoreOpen] = useState(false);
  const auxiliary = useManualAuxiliary();
  const moreOpen = compact && auxiliary ? auxiliary.active === "more" : inlineMoreOpen;
  const moreId = useId();
  const moreRef = useRef<HTMLButtonElement>(null);
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

  // One editable input stays mounted while auxiliary content is disclosed.
  // Blur/Enter and the first invalid Apply guard remain owned by this draft.
  const apply = <Button ref={applyRef} variant="primary" type="button" className={compact ? `${manualCompactButtonHitClassName} px-2 text-caption` : "max-compact:scroll-mb-shell-navigation-safe"}
    aria-label={applyLabel} onClick={() => {
      if (invalidApplyAttempt.current) { invalidApplyAttempt.current = false; return; }
      if (!rawValid.current || restoring.current || !canSubmit) return;
      onSubmit();
    }} disabled={!canSubmit || invalidDraft} data-control-submit="">{compact ? "적용" : applyLabel}</Button>;
  const moreBody = <>
      <div role="group" aria-label="빠른 밝기 값" className="grid grid-cols-4 gap-1">
        {[0, 30, 70, 100].map(value => <Button key={value} type="button" variant="ghost" className={compact ? `${manualCompactButtonHitClassName} whitespace-nowrap px-2` : "whitespace-nowrap px-2"} aria-pressed={brightness === value && !invalidDraft}
          disabled={controlsLocked} onClick={() => changeDraft(value)}>{value}%</Button>)}
      </div>
      {moreContent}
    </>;
  return <div className={`grid min-h-0 min-w-0 flex-none content-start ${compact ? "gap-1" : "gap-3"}`} data-control-panel-body=""
    onPointerDownCapture={event => {
      if (event.target instanceof Element && event.target.closest("[data-control-submit]")) invalidApplyAttempt.current = !rawValid.current || restoring.current;
    }}>
    <div className={`grid min-w-0 ${compact ? "grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1" : "gap-2 border-t border-border-default pt-3"}`} data-control-execution-row="">
      <div className={`flex min-w-0 ${compact ? "items-center" : "items-baseline justify-between gap-3"}`} onInputCapture={captureDraft} onChangeCapture={captureDraft}
        onBlurCapture={event => {
          if (event.target instanceof HTMLInputElement) {
            if (!rawValid.current && event.relatedTarget === applyRef.current) invalidApplyAttempt.current = true;
            restoreDraft();
          }
        }}
        onKeyDownCapture={event => {
          if (event.target instanceof HTMLInputElement && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); restoreDraft(); }
        }}>
        <Text as="span" variant="label" className={compact ? "sr-only" : undefined}>밝기</Text>
        <div className="flex min-w-0 items-baseline gap-1">
          <NumberField key={inputRevision} aria-label="밝기 수치" variant="ghost" size={compact ? "sm" : "lg"}
            className={compact ? "w-12" : "w-20"} inputClassName={`px-1 text-body text-right${compact ? " rounded-none!" : ""}`}
            minValue={0} maxValue={100} step={1} value={brightness} isDisabled={controlsLocked} isInvalid={invalidDraft}
            onChange={value => { if (rawValid.current && !restoring.current && value !== null && Number.isInteger(value) && value >= 0 && value <= 100) onBrightnessChange(value); }} />
          <Text as="span" variant="caption" aria-hidden="true">%</Text>
        </div>
      </div>
      {/* The shared 52px thumb extends 26px past either track endpoint.
          Compact-only 28px gutters keep its hit area inside its own column;
          the numeric input's square corners preserve the full 44px hit height. */}
      <Slider aria-label="밝기" presentation="bare" className={compact ? "min-w-0 px-7" : "min-w-0"} minValue={0} maxValue={100} step={1} value={brightness} isDisabled={controlsLocked} onChange={changeDraft} />
      {apply}
      <Button ref={moreRef} hidden={!compact} type="button" variant="secondary" className={compact ? `${manualCompactButtonHitClassName} px-2 text-caption` : "hidden"}
        aria-expanded={moreOpen} aria-controls={auxiliary?.panelId ?? moreId} onClick={event => auxiliary ? auxiliary.toggle("more", event.currentTarget) : setMoreOpen(value => !value)}>더보기</Button>
    </div>
    {invalidDraft ? <Text role="alert" tone="danger">0~100 사이 정수를 입력해 주세요.</Text> : null}
    {restored ? <Text role="status" variant="caption">{restored}</Text> : null}
    {/* Essential warnings stay readable/live even when lengthy recovery UI is closed. */}
    {compact ? <div hidden={!auxiliary && moreOpen}>{importantStatus}</div> : null}
    {/* Explicit display also honors hidden in the real CSS cascade: a grid
        utility must not override the browser hidden-attribute default. */}
    <div id={moreId} hidden={Boolean(auxiliary?.enabled) || (compact && !moreOpen)}
      className={auxiliary?.enabled || (compact && !moreOpen) ? "hidden" : compact ? "grid max-h-[25dvh] min-h-0 min-w-0 gap-2 overflow-y-auto overscroll-contain" : "grid min-h-0 gap-3"}
      data-control-more-content="" onKeyDown={event => {
        if (compact && !auxiliary && event.key === "Escape") { event.stopPropagation(); setMoreOpen(false); moreRef.current?.focus({ preventScroll: true }); }
      }}>{auxiliary ? <ManualAuxiliaryContent kind="more">{moreBody}</ManualAuxiliaryContent> : moreBody}</div>
  </div>;
}
