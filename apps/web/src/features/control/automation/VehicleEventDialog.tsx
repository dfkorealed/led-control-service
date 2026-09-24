import type { AutomationRuleStatus } from "@led-control/shared";
import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { CreateVehicleEventRuleInput, VehicleEventRuleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { Button, Checkbox, Heading, ModalDialog, Slider, Text, TextField } from "../../../components/ui";
import { resolveControlSelection, type ControlSelection } from "../control-selection";
import { SpatialTargetSelector, spatialTargetDialogClassName } from "../target-selection/SpatialTargetSelector";
import {
  fixtureIdsAvailability,
  fixtureIdsSummary,
  isVehicleEventSource,
  vehicleEventTargetSnapshotSummary,
  vehicleEventTargetStorageCopy,
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
  returnFocusRef,
  onClose,
  onSubmit
}: {
  open: boolean;
  rule: VehicleEventRuleResponse | null;
  dashboard: Dashboard;
  isPending: boolean;
  serverError: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (input: CreateVehicleEventRuleInput) => void;
}) {
  const sourceFieldRef = useRef<HTMLFieldSetElement>(null);
  const targetFieldRef = useRef<HTMLFieldSetElement>(null);
  const sourceCardRef = useRef<HTMLDivElement>(null);
  const sourceTriggerRef = useRef<HTMLButtonElement>(null);
  const targetTriggerRef = useRef<HTMLButtonElement>(null);
  const targetCardRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const brightnessInputRef = useRef<HTMLInputElement>(null);
  const holdSecondsInputRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<VehicleEventFormValues>(createEmptyVehicleEventForm);
  const [sourceSelection, setSourceSelection] = useState<ControlSelection>(() => ({ mode: "fixtures", fixtureIds: [] }));
  const [targetSelection, setTargetSelection] = useState<ControlSelection>(() => ({ mode: "fixtures", fixtureIds: [] }));
  const [errors, setErrors] = useState<VehicleEventFormErrors>({});
  const [view, setView] = useState<EventDialogView>("main");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customHoldOpen, setCustomHoldOpen] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<keyof VehicleEventFormErrors | null>(null);
  const title = rule ? "이벤트 수정" : "이벤트 추가";

  useEffect(() => {
    if (!open) return;
    const nextValues = rule ? vehicleEventRuleToFormValues(rule) : createEmptyVehicleEventForm();
    setValues(nextValues);
    // Event APIs persist IDs only, so reopening always starts with direct snapshot selections.
    setSourceSelection({ mode: "fixtures", fixtureIds: nextValues.sourceFixtureIds });
    setTargetSelection({ mode: "fixtures", fixtureIds: nextValues.targetFixtureIds });
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

  const sourceResolution = resolveControlSelection(dashboard, sourceSelection);
  const sourceGatewayId = sourceResolution.gatewayIds.length === 1 ? sourceResolution.gatewayIds[0] : null;
  const sourceAvailability = fixtureIdsAvailability(values.sourceFixtureIds, dashboard, isVehicleEventSource);
  const sourceReadyForTarget = sourceAvailability.resolvedCount > 0
    && sourceAvailability.invalidFixtureIds.length === 0
    && sourceResolution.available
    && sourceGatewayId !== null;
  const targetResolution = resolveControlSelection(dashboard, { mode: "fixtures", fixtureIds: values.targetFixtureIds });
  const targetSourceResolution = resolveControlSelection(dashboard, targetSelection);
  const sourceSummary = fixtureIdsSummary(values.sourceFixtureIds, dashboard, isVehicleEventSource);
  const targetSummary = vehicleEventTargetSnapshotSummary(targetSelection, values.targetFixtureIds, dashboard);
  const selectedHoldPreset = customHoldOpen ? "custom" : values.holdSeconds;

  function change(patch: Partial<VehicleEventFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function changeSource(source: ControlSelection) {
    const resolved = resolveControlSelection(dashboard, source);
    const requiredGatewayId = resolved.gatewayIds.length === 1 ? resolved.gatewayIds[0] : null;
    const currentTarget = resolveControlSelection(dashboard, { mode: "fixtures", fixtureIds: values.targetFixtureIds });
    const targetMatchesSource = requiredGatewayId !== null
      && currentTarget.available
      && currentTarget.gatewayIds[0] === requiredGatewayId;
    setSourceSelection(source);
    if (values.targetFixtureIds.length > 0 && requiredGatewayId !== null && !targetMatchesSource) {
      // A new source gateway cannot reuse targets from the prior gateway.
      setTargetSelection({ mode: "fixtures", fixtureIds: [] });
      change({ sourceFixtureIds: resolved.fixtureIds, targetFixtureIds: [] });
      return;
    }
    change({ sourceFixtureIds: resolved.fixtureIds });
  }

  function changeTarget(source: ControlSelection) {
    const resolved = resolveControlSelection(dashboard, source);
    // Groups and floors are authoring shortcuts; their IDs are resolved immediately into a durable fixture snapshot.
    setTargetSelection(source);
    change({ targetFixtureIds: resolved.fixtureIds });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors = validateVehicleEventForm(values);
    if (sourceAvailability.invalidFixtureIds.length > 0) {
      nextErrors.sourceFixtureIds = "현재 현장에서 확인되지 않거나 차량 감지 기능이 해제된 센서가 포함되어 있습니다. 다시 선택해 주세요.";
    }
    const targetAvailability = fixtureIdsAvailability(values.targetFixtureIds, dashboard);
    if (targetAvailability.invalidFixtureIds.length > 0) {
      nextErrors.targetFixtureIds = "현재 현장에서 확인되지 않는 제어 조명이 포함되어 있습니다. 다시 선택해 주세요.";
    }
    if (values.sourceFixtureIds.length > 0 && !sourceResolution.available) {
      nextErrors.sourceFixtureIds = sourceResolution.unavailableReason ?? "현재 사용할 수 없는 감지 센서입니다.";
    }
    if (values.targetFixtureIds.length > 0 && targetSelection.mode !== "fixtures" && !targetSourceResolution.available) {
      nextErrors.targetFixtureIds = targetSourceResolution.unavailableReason ?? "현재 제어할 수 없는 대상입니다.";
    }
    if (targetAvailability.invalidFixtureIds.length === 0 && values.targetFixtureIds.length > 0 && (!targetResolution.available || !sourceGatewayId || targetResolution.gatewayIds[0] !== sourceGatewayId)) {
      nextErrors.targetFixtureIds = "감지 센서와 같은 게이트웨이에 연결된 조명을 선택해 주세요.";
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
      doneLabel={view === "source"
        ? (sourceResolution.fixtureIds.length > 0 ? `${sourceResolution.fixtureIds.length}개 조명 선택 완료` : "선택 완료")
        : (targetResolution.fixtureIds.length > 0 ? `${targetResolution.fixtureIds.length}개 조명 선택 완료` : "선택 완료")}
      doneDisabled={view === "source" ? !sourceResolution.available : !targetResolution.available || !sourceGatewayId || targetResolution.gatewayIds[0] !== sourceGatewayId || (targetSelection.mode !== "fixtures" && !targetSourceResolution.available)}
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4"
      onDone={() => {
        const completedView = view;
        setView("main");
        setPendingFocus(null);
        queueMicrotask(() => (completedView === "source" ? sourceTriggerRef.current : targetTriggerRef.current)?.focus());
      }}
    >
      <fieldset
        ref={view === "source" ? sourceFieldRef : targetFieldRef}
        className="m-0 flex min-h-0 flex-col gap-3 overflow-hidden border-0 p-0 disabled:opacity-60"
        disabled={isPending}
        tabIndex={-1}
        data-automation-picker-fieldset=""
        {...errorAttributes(
          view === "source" ? errors.sourceFixtureIds : errors.targetFixtureIds,
          view === "source" ? vehicleEventErrorIds.source : vehicleEventErrorIds.target
        )}
      >
        <legend className="sr-only">{view === "source" ? "감지 센서 선택" : "실행할 조명 선택"}</legend>
        {view === "target" ? <Text variant="caption" tone="secondary">{vehicleEventTargetStorageCopy(targetSelection, values.targetFixtureIds)}</Text> : null}
        <SpatialTargetSelector
          siteId={dashboard.site.id}
          dashboard={dashboard}
          selection={view === "source" ? sourceSelection : targetSelection}
          displaySelection={view === "target" ? { mode: "fixtures", fixtureIds: values.targetFixtureIds } : undefined}
          allowedModes={view === "source" ? ["fixtures"] : undefined}
          fixtureFilter={view === "source" ? isVehicleEventSource : undefined}
          fixtureFilterReason="차량 감지 기능이 확인된 센서만 선택할 수 있습니다."
          requiredGatewayId={view === "target" ? sourceGatewayId : null}
          disabled={isPending}
          modeLabels={{ fixtures: "직접 선택" }}
          modeSelectionSemantics="pressed"
          onChange={view === "source" ? changeSource : changeTarget}
        />
        <FieldError
          id={view === "source" ? vehicleEventErrorIds.source : vehicleEventErrorIds.target}
          message={view === "source" ? errors.sourceFixtureIds : errors.targetFixtureIds}
        />
      </fieldset>
    </AutomationTargetPickerView>
  ) : null;

  return (
    <ModalDialog isOpen={open} title={title} description="빠른 설정 · Gateway 차량 감지" closeLabel={`${title} 닫기`} isPending={isPending} returnFocusRef={returnFocusRef} onClose={onClose}
      className={pickerView ? spatialTargetDialogClassName : "max-w-4xl"}
      bodyClassName={pickerView ? "grid min-h-0 overflow-hidden" : undefined}
    >

        {pickerView ?? (
          <form className="grid gap-4" onSubmit={submit} noValidate>
            <section className="grid gap-3 rounded-panel border border-border-default p-4" aria-labelledby="event-flow-heading">
              <Text id="event-flow-heading" tone="secondary">센서가 차량을 감지하면 선택한 조명에 동작을 적용합니다.</Text>
              <Heading as="h3" variant="card-title">01 감지 센서</Heading>
              <AutomationSelectionCard
                fieldRef={sourceCardRef}
                triggerRef={sourceTriggerRef}
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
              <ArrowDown className="justify-self-center text-content-secondary" size={20} aria-hidden="true" />
              <Heading as="h3" variant="card-title">02 실행 조명</Heading>
              <AutomationSelectionCard
                fieldRef={targetCardRef}
                triggerRef={targetTriggerRef}
                label="실행할 조명"
                title={targetSummary.count > 0 ? targetSummary.title : "실행할 조명을 선택해 주세요."}
                description={sourceReadyForTarget
                  ? (targetSummary.count > 0 ? targetSummary.description : "감지 시 함께 제어할 조명을 선택하세요.")
                  : "감지 센서를 먼저 선택하면 같은 게이트웨이의 실행 조명을 고를 수 있습니다."}
                empty={targetSummary.count === 0}
                disabled={isPending || !sourceReadyForTarget}
                error={errors.targetFixtureIds}
                errorId={vehicleEventErrorIds.target}
                onOpen={() => setView("target")}
              />
            </section>

            <ArrowDown className="justify-self-center text-content-secondary" size={20} aria-hidden="true" />
            <section className="grid gap-3 rounded-panel border border-border-default p-4" aria-labelledby="event-action-heading">
              <Heading as="h3" id="event-action-heading" variant="card-title">03 동작 설정</Heading>
              <Text tone="secondary">차량 감지 시 실행 조명에 적용할 밝기와 유지 시간을 정하세요.</Text>
              <fieldset className="m-0 grid gap-3 border-0 p-0" disabled={isPending}>
                <legend>밝기</legend>
                <AutomationPresetGroup
                  label="밝기 프리셋"
                  value={values.brightnessPercent}
                  options={brightnessPresets.map((value) => ({ value, label: `${value}%` }))}
                  disabled={isPending || !values.dimmingEnabled}
                  onChange={(brightnessPercent) => change({ brightnessPercent })}
                />
                <div className="grid grid-cols-[minmax(0,1fr)_8rem] items-end gap-3 max-compact:grid-cols-1">
                  <Slider label="밝기 조절" minValue={0} maxValue={100} value={Number(values.dimmingEnabled ? values.brightnessPercent : "100") || 0} isDisabled={!values.dimmingEnabled} onChange={(value) => change({ brightnessPercent: String(value) })} />
                  <TextField ref={brightnessInputRef} label="밝기" inputMode="numeric" isDisabled={!values.dimmingEnabled} isInvalid={Boolean(errors.brightnessPercent)} errorMessage={errors.brightnessPercent} value={values.dimmingEnabled ? values.brightnessPercent : "100"} onChange={(value) => change({ brightnessPercent: value })} />
                </div>
              </fieldset>

              <fieldset className="m-0 grid gap-3 border-0 p-0" disabled={isPending}>
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
                  <TextField ref={holdSecondsInputRef} label="유지 시간" description="초 단위로 입력하세요." inputMode="numeric" isInvalid={Boolean(errors.holdSeconds)} errorMessage={errors.holdSeconds} value={values.holdSeconds} onChange={(value) => change({ holdSeconds: value })} />
                ) : null}
              </fieldset>
            </section>

            <AutomationAdvancedSection label="고급 설정" open={advancedOpen} disabled={isPending} onOpenChange={setAdvancedOpen}>
              <TextField ref={nameInputRef} label="규칙 이름" isInvalid={Boolean(errors.name)} errorMessage={errors.name} value={values.name} onChange={(value) => change({ name: value })} />
              <Checkbox label={`밝기 직접 지정 ${values.dimmingEnabled ? "ON" : "OFF"}`} aria-label="디밍 사용" isSelected={values.dimmingEnabled} onChange={(selected) => change({ dimmingEnabled: selected })} />
            </AutomationAdvancedSection>

            <div className="grid gap-2">
              <Text as="strong" weight="semibold">실행 요약</Text>
              <AutomationSummaryBar>{vehicleEventSummary(values, dashboard)}</AutomationSummaryBar>
            </div>
            {serverError ? <Text tone="danger" role="alert">{serverError}</Text> : null}
            <footer className="flex justify-end gap-2">
              <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>취소</Button>
              <Button variant="primary" type="submit" isLoading={isPending} loadingLabel="저장 중">저장</Button>
            </footer>
          </form>
        )}
    </ModalDialog>
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
