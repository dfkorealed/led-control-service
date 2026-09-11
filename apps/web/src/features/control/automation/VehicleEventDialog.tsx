import type { AutomationRuleStatus } from "@led-control/shared";
import { ArrowDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CreateVehicleEventRuleInput, VehicleEventRuleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { useDialogFocus } from "../../../components/ConfirmDialog";
import { Button } from "../../../components/ui";
import { ControlTargetPicker } from "../ControlTargetPicker";
import {
  fixtureIdsAvailability,
  fixtureIdsSummary,
  isVehicleEventSource,
  vehicleEventSummary
} from "./automation-presenters";
import {
  AutomationAdvancedSection,
  AutomationPresetGroup,
  AutomationSelectionCard,
  AutomationSummaryBar,
  AutomationTargetPickerView
} from "./components/AutomationQuickFields";
import {
  createEmptyVehicleEventForm,
  validateVehicleEventForm,
  vehicleEventFormToInput,
  vehicleEventRuleToFormValues,
  type VehicleEventFormErrors,
  type VehicleEventFormValues
} from "./vehicle-event-form";

const brightnessPresets = ["50", "70", "80", "100"] as const;
const holdPresets = [
  { value: "30", label: "30초" },
  { value: "60", label: "1분" },
  { value: "300", label: "5분" },
  { value: "custom", label: "직접 입력" }
] as const;

type EventDialogView = "main" | "source" | "target";

export function VehicleEventDialog({
  open,
  rule,
  dashboard,
  isPending,
  serverError,
  returnFocusElement,
  onClose,
  onSubmit
}: {
  open: boolean;
  rule: VehicleEventRuleResponse | null;
  dashboard: Dashboard;
  isPending: boolean;
  serverError: string;
  returnFocusElement?: HTMLElement | null;
  onClose: () => void;
  onSubmit: (input: CreateVehicleEventRuleInput) => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const sourceFieldRef = useRef<HTMLFieldSetElement>(null);
  const targetFieldRef = useRef<HTMLFieldSetElement>(null);
  const sourceCardRef = useRef<HTMLDivElement>(null);
  const targetCardRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const brightnessInputRef = useRef<HTMLInputElement>(null);
  const holdSecondsInputRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<VehicleEventFormValues>(createEmptyVehicleEventForm);
  const [errors, setErrors] = useState<VehicleEventFormErrors>({});
  const [view, setView] = useState<EventDialogView>("main");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customHoldOpen, setCustomHoldOpen] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<keyof VehicleEventFormErrors | null>(null);
  const title = rule ? "이벤트 수정" : "이벤트 추가";
  const titleId = "vehicle-event-dialog-title";

  useEffect(() => {
    if (!open) return;
    const nextValues = rule ? vehicleEventRuleToFormValues(rule) : createEmptyVehicleEventForm();
    setValues(nextValues);
    setErrors({});
    setView("main");
    setAdvancedOpen(false);
    setCustomHoldOpen(!holdPresets.some((preset) => preset.value === nextValues.holdSeconds));
    setPendingFocus(null);
  }, [open, rule]);

  useEffect(() => {
    if (!pendingFocus) return;
    const target = focusTarget(pendingFocus);
    if (!target) return;
    target.focus();
    setPendingFocus(null);
  }, [advancedOpen, customHoldOpen, pendingFocus, view]);

  useDialogFocus({ open, dialogRef, returnFocusElement, onClose });

  if (!open) return null;

  const sourceSummary = fixtureIdsSummary(values.sourceFixtureIds, dashboard, isVehicleEventSource);
  const targetSummary = fixtureIdsSummary(values.targetFixtureIds, dashboard);
  const selectedHoldPreset = customHoldOpen ? "custom" : values.holdSeconds;

  function change(patch: Partial<VehicleEventFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors = validateVehicleEventForm(values);
    if (fixtureIdsAvailability(values.sourceFixtureIds, dashboard, isVehicleEventSource).invalidFixtureIds.length > 0) {
      nextErrors.sourceFixtureIds = "현재 현장에서 확인되지 않거나 차량 감지 기능이 해제된 센서가 포함되어 있습니다. 다시 선택해 주세요.";
    }
    if (fixtureIdsAvailability(values.targetFixtureIds, dashboard).invalidFixtureIds.length > 0) {
      nextErrors.targetFixtureIds = "현재 현장에서 확인되지 않는 제어 조명이 포함되어 있습니다. 다시 선택해 주세요.";
    }
    setErrors(nextErrors);
    const firstError = firstVehicleEventError(nextErrors);
    if (firstError) {
      if (firstError === "sourceFixtureIds") setView("source");
      if (firstError === "targetFixtureIds") setView("target");
      if (firstError === "name") setAdvancedOpen(true);
      if (firstError === "holdSeconds" && !holdPresets.some((preset) => preset.value === values.holdSeconds)) {
        setCustomHoldOpen(true);
      }
      setPendingFocus(firstError);
      return;
    }
    const status: AutomationRuleStatus = rule?.status ?? "enabled";
    onSubmit(vehicleEventFormToInput(values, status));
  }

  const pickerView = view === "source" || view === "target" ? (
    <AutomationTargetPickerView
      title={view === "source" ? "감지 센서 선택" : "실행할 조명 선택"}
      description={view === "source"
        ? "차량 감지 기능이 확인된 센서만 표시됩니다."
        : "차량 감지 시 함께 제어할 조명을 선택하세요."}
      disabled={isPending}
      onDone={() => {
        const completedView = view;
        setView("main");
        setPendingFocus(null);
        queueMicrotask(() => (completedView === "source" ? sourceCardRef.current : targetCardRef.current)?.focus());
      }}
    >
      <fieldset
        ref={view === "source" ? sourceFieldRef : targetFieldRef}
        className="automation-picker-fieldset"
        disabled={isPending}
        tabIndex={-1}
        {...errorAttributes(
          view === "source" ? errors.sourceFixtureIds : errors.targetFixtureIds,
          view === "source" ? vehicleEventErrorIds.source : vehicleEventErrorIds.target
        )}
      >
        <legend className="sr-only">{view === "source" ? "감지 센서 선택" : "실행할 조명 선택"}</legend>
        <ControlTargetPicker
          dashboard={dashboard}
          selection={{
            mode: "fixtures",
            fixtureIds: view === "source" ? values.sourceFixtureIds : values.targetFixtureIds
          }}
          allowedModes={["fixtures"]}
          fixtureFilter={view === "source" ? isVehicleEventSource : undefined}
          disabled={isPending}
          onChange={(selection) => {
            if (selection.mode !== "fixtures") return;
            change(view === "source"
              ? { sourceFixtureIds: selection.fixtureIds }
              : { targetFixtureIds: selection.fixtureIds });
          }}
        />
        <FieldError
          id={view === "source" ? vehicleEventErrorIds.source : vehicleEventErrorIds.target}
          message={view === "source" ? errors.sourceFixtureIds : errors.targetFixtureIds}
        />
      </fieldset>
    </AutomationTargetPickerView>
  ) : null;

  return (
    <div className="schedule-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !isPending) onClose();
    }}>
      <section ref={dialogRef} className="schedule-dialog automation-quick-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="schedule-dialog-header">
          <div>
            <span className="eyebrow">Gateway 차량 감지</span>
            <div className="automation-dialog-title-row">
              <h2 id={titleId}>{title}</h2>
              <span className="automation-quick-badge">빠른 설정</span>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label={`${title} 닫기`} onClick={onClose} disabled={isPending}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {pickerView ?? (
          <form className="schedule-form automation-quick-form" onSubmit={submit} noValidate>
            <section className="automation-quick-section automation-event-flow" aria-labelledby="event-flow-heading">
              <h3 id="event-flow-heading">무엇을 감지해서 실행할까요?</h3>
              <AutomationSelectionCard
                fieldRef={sourceCardRef}
                label="감지 센서"
                title={sourceSummary.count > 0 ? sourceSummary.title : "감지 센서를 선택해 주세요."}
                description={sourceSummary.count > 0 ? sourceSummary.description : "차량 감지 기능이 확인된 센서만 표시됩니다."}
                empty={sourceSummary.count === 0}
                disabled={isPending}
                error={errors.sourceFixtureIds}
                errorId={vehicleEventErrorIds.source}
                kind="sensor"
                onOpen={() => setView("source")}
              />
              <ArrowDown className="automation-flow-arrow" size={20} aria-hidden="true" />
              <AutomationSelectionCard
                fieldRef={targetCardRef}
                label="실행할 조명"
                title={targetSummary.count > 0 ? targetSummary.title : "실행할 조명을 선택해 주세요."}
                description={targetSummary.count > 0 ? targetSummary.description : "감지 시 함께 제어할 조명을 선택하세요."}
                empty={targetSummary.count === 0}
                disabled={isPending}
                error={errors.targetFixtureIds}
                errorId={vehicleEventErrorIds.target}
                onOpen={() => setView("target")}
              />
            </section>

            <fieldset className="automation-quick-section" disabled={isPending}>
              <legend>밝기</legend>
              <AutomationPresetGroup
                label="밝기 프리셋"
                value={values.brightnessPercent}
                options={brightnessPresets.map((value) => ({ value, label: `${value}%` }))}
                disabled={isPending || !values.dimmingEnabled}
                onChange={(brightnessPercent) => change({ brightnessPercent })}
              />
              <div className="automation-brightness-row">
                <input type="range" min="0" max="100" aria-label="밝기 조절" disabled={!values.dimmingEnabled} value={values.dimmingEnabled ? values.brightnessPercent : "100"} onChange={(event) => change({ brightnessPercent: event.target.value })} />
                <label className="form-field automation-brightness-number">
                  <span>밝기</span>
                  <input ref={brightnessInputRef} type="number" min="0" max="100" aria-label="밝기" disabled={!values.dimmingEnabled} {...errorAttributes(errors.brightnessPercent, vehicleEventErrorIds.brightness)} value={values.dimmingEnabled ? values.brightnessPercent : "100"} onChange={(event) => change({ brightnessPercent: event.target.value })} />
                </label>
                <span>%</span>
              </div>
              <FieldError id={vehicleEventErrorIds.brightness} message={errors.brightnessPercent} />
            </fieldset>

            <fieldset className="automation-quick-section" disabled={isPending}>
              <legend>유지 시간</legend>
              <AutomationPresetGroup
                label="유지 시간 프리셋"
                value={selectedHoldPreset}
                options={holdPresets}
                disabled={isPending}
                onChange={(preset) => {
                  if (preset === "custom") {
                    setCustomHoldOpen(true);
                    return;
                  }
                  setCustomHoldOpen(false);
                  change({ holdSeconds: preset });
                }}
              />
              {customHoldOpen ? (
                <label className="form-field schedule-compact-number automation-custom-hold">
                  <span>유지 시간(초)</span>
                  <input ref={holdSecondsInputRef} type="number" min="5" max="1800" aria-label="유지 시간" {...errorAttributes(errors.holdSeconds, vehicleEventErrorIds.holdSeconds)} value={values.holdSeconds} onChange={(event) => change({ holdSeconds: event.target.value })} />
                  <FieldError id={vehicleEventErrorIds.holdSeconds} message={errors.holdSeconds} />
                </label>
              ) : null}
            </fieldset>

            <AutomationAdvancedSection label="고급 설정" open={advancedOpen} disabled={isPending} onOpenChange={setAdvancedOpen}>
              <label className="form-field schedule-name-field">
                <span>규칙 이름</span>
                <input ref={nameInputRef} aria-label="규칙 이름" {...errorAttributes(errors.name, vehicleEventErrorIds.name)} value={values.name} onChange={(event) => change({ name: event.target.value })} />
                <FieldError id={vehicleEventErrorIds.name} message={errors.name} />
              </label>
              <label className="schedule-dimming-toggle">
                <input type="checkbox" aria-label="디밍 사용" checked={values.dimmingEnabled} onChange={(event) => change({ dimmingEnabled: event.target.checked })} />
                <span>밝기 직접 지정 {values.dimmingEnabled ? "ON" : "OFF"}</span>
              </label>
            </AutomationAdvancedSection>

            <AutomationSummaryBar>{vehicleEventSummary(values, dashboard)}</AutomationSummaryBar>
            {serverError ? <p className="danger-text schedule-form-server-error" role="alert">{serverError}</p> : null}
            <footer className="schedule-dialog-actions">
              <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>취소</Button>
              <Button className="primary-button" variant="primary" type="submit" isLoading={isPending} loadingLabel="저장 중">저장</Button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );

  function focusTarget(key: keyof VehicleEventFormErrors) {
    if (key === "sourceFixtureIds") return sourceFieldRef.current;
    if (key === "targetFixtureIds") return targetFieldRef.current;
    if (key === "name") return nameInputRef.current;
    if (key === "brightnessPercent") return brightnessInputRef.current;
    return holdSecondsInputRef.current;
  }
}

function firstVehicleEventError(errors: VehicleEventFormErrors): keyof VehicleEventFormErrors | null {
  const order: readonly (keyof VehicleEventFormErrors)[] = [
    "sourceFixtureIds",
    "targetFixtureIds",
    "name",
    "brightnessPercent",
    "holdSeconds"
  ];
  return order.find((key) => Boolean(errors[key])) ?? null;
}

const vehicleEventErrorIds = {
  source: "vehicle-event-source-error",
  target: "vehicle-event-target-error",
  name: "vehicle-event-name-error",
  brightness: "vehicle-event-brightness-error",
  holdSeconds: "vehicle-event-hold-seconds-error"
} as const;

function errorAttributes(message: string | undefined, id: string) {
  return message ? {
    "aria-invalid": true,
    "aria-describedby": id,
    "aria-errormessage": id
  } : { "aria-invalid": false };
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <span id={id} className="field-error" role="alert">{message}</span> : null;
}
