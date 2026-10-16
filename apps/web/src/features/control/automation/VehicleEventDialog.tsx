import type { AutomationRuleStatus } from "@led-control/shared";
import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { CreateVehicleEventRuleInput, VehicleEventRuleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { LinkButton } from "../../../components/ui/LinkButton";
import { bioSensorBlockSummary } from "./BioSensorPreparationPanel";
import { isSelectableVehicleEventSource } from "./bio-event-setup";
import { Button, Checkbox, Heading, ModalDialog, Slider, Text, TextField, panelPaddingClass } from "../../../components/ui";
import { resolveControlSelection, type ControlSelection } from "../control-selection";
import { SpatialTargetSelector, spatialTargetDialogClassName } from "../target-selection/SpatialTargetSelector";
import {
  fixtureIdsAvailability,
  fixtureIdsSummary,
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
  onRefreshSource?: () => Promise<unknown>;
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
  const selectedSources = sourceResolution.fixtures;
  // The selected server capability takes precedence after a source replacement.
  // Retain the saved protocol only when its source is missing or not selected yet.
  const isBio = selectedSources.length > 0
    ? selectedSources.some(fixture => fixture.vehicleEventSource?.sensorProtocol === "bio-usb-pulse")
    : rule?.sensorProtocol === "bio-usb-pulse";
  const sourceProtocol = isBio ? "bio-usb-pulse" : "bluez-stateful";
  const selfControlEnabled = isBio && values.selfControlEnabled === true;
  const bioSourceBlocked = isBio && (selectedSources.length !== 1 || !selectedSources.every(isSelectableVehicleEventSource));
  const targetEligible = (fixture: Dashboard["floors"][number]["fixtures"][number]) => fixture.vehicleEventSource?.targetEligible !== false
    && !(isBio && values.sourceFixtureIds.includes(fixture.id));
  const sourceGatewayId = sourceResolution.gatewayIds.length === 1 ? sourceResolution.gatewayIds[0] : null;
  const sourceAvailability = fixtureIdsAvailability(values.sourceFixtureIds, dashboard, isSelectableVehicleEventSource);
  const sourceReadyForTarget = sourceAvailability.resolvedCount > 0
    && sourceAvailability.invalidFixtureIds.length === 0
    && sourceResolution.available
    && sourceGatewayId !== null;
  const targetResolution = resolveControlSelection(dashboard, { mode: "fixtures", fixtureIds: values.targetFixtureIds });
  const targetSourceResolution = resolveControlSelection(dashboard, targetSelection);
  const sourceSummary = fixtureIdsSummary(values.sourceFixtureIds, dashboard, isSelectableVehicleEventSource);
  const targetSummary = vehicleEventTargetSnapshotSummary(targetSelection, values.targetFixtureIds, dashboard);
  const registrationBlocked = dashboard.floors.some(floor => floor.fixtures.some(fixture =>
    !isSelectableVehicleEventSource(fixture) && fixture.bioSensorPreparation?.blockedReasons.includes("binding_changed")));
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
    const nextErrors = validateVehicleEventForm(values, sourceProtocol);
    if (sourceAvailability.invalidFixtureIds.length > 0) {
      nextErrors.sourceFixtureIds = "현재 현장에서 확인되지 않거나 차량 감지 기능이 해제된 센서가 포함되어 있습니다. 다시 선택해 주세요.";
    }
    if (bioSourceBlocked) nextErrors.sourceFixtureIds = "감지 조명을 한 개 선택해 주세요.";
    const targetAvailability = fixtureIdsAvailability(values.targetFixtureIds, dashboard);
    if (targetAvailability.invalidFixtureIds.length > 0) {
      nextErrors.targetFixtureIds = "현재 현장에서 확인되지 않는 제어 조명이 포함되어 있습니다. 다시 선택해 주세요.";
    }
    if (targetResolution.fixtures.some(fixture => !targetEligible(fixture))) nextErrors.targetFixtureIds = "감지 센서는 실행 조명으로 선택할 수 없습니다. 다른 실행 조명을 선택하세요.";
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
    // Only new BIO rules start disabled. Editing the hold of an active rule
    // must not silently turn it off; the server still rechecks admission.
    const status: AutomationRuleStatus = rule?.status ?? (isBio ? "disabled" : "enabled");
    onSubmit(vehicleEventFormToInput(values, status, sourceProtocol));
  }

  const pickerView = view === "source" || view === "target" ? (
    <AutomationTargetPickerView
      title={view === "source" ? "감지 센서 선택" : "실행할 조명 선택"}
      description={view === "source"
        ? "움직임을 감지할 조명을 선택하세요. 필요한 설정은 저장할 때 자동으로 처리합니다."
        : "차량 감지 시 함께 제어할 조명을 선택하세요."}
      disabled={isPending}
      doneLabel={view === "source"
        ? (sourceResolution.fixtureIds.length > 0 ? `${sourceResolution.fixtureIds.length}개 조명 선택 완료` : "선택 완료")
        : (targetResolution.fixtureIds.length > 0 ? `${targetResolution.fixtureIds.length}개 조명 선택 완료` : "선택 완료")}
      doneDisabled={view === "source" ? !sourceResolution.available || bioSourceBlocked : !targetResolution.available || targetResolution.fixtures.some(fixture => !targetEligible(fixture)) || !sourceGatewayId || targetResolution.gatewayIds[0] !== sourceGatewayId || (targetSelection.mode !== "fixtures" && !targetSourceResolution.available)}
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
        {view === "source" && registrationBlocked ? <div className="grid gap-2">
          <Text variant="caption">등록 연결 재확인이 필요한 조명이 있습니다. 설정의 현장 관리에서 해당 조명을 선택해 등록 연결 확인과 센서 준비를 진행해 주세요.</Text>
          <LinkButton variant="secondary" href={`/settings/site?${new URLSearchParams({ siteId: dashboard.site.id })}#bio-sensor-preparation`}>등록 연결 확인하러 가기</LinkButton>
        </div> : null}
        {view === "target" ? <Text variant="caption" tone="secondary">{vehicleEventTargetStorageCopy(targetSelection, values.targetFixtureIds)}</Text> : null}
        <SpatialTargetSelector
          siteId={dashboard.site.id}
          dashboard={dashboard}
          selection={view === "source" ? sourceSelection : targetSelection}
          displaySelection={view === "target" ? { mode: "fixtures", fixtureIds: values.targetFixtureIds } : undefined}
          allowedModes={view === "source" ? ["fixtures"] : undefined}
          fixtureFilter={view === "source" ? isSelectableVehicleEventSource : targetEligible}
          fixtureBlockedReason={view === "source" ? bioSensorBlockSummary : undefined}
          fixtureFilterReason={view === "source" ? "현재 현장에 연결된 센서 조명을 선택해 주세요." : "감지 센서는 실행 대상에서 제외됩니다. 다른 실행 조명을 선택하세요."}
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
          <form className="grid gap-5" onSubmit={submit} noValidate>
            <section className={`grid gap-3 rounded-panel border border-border-default ${panelPaddingClass("regular")}`} aria-labelledby="event-flow-heading">
              <Text id="event-flow-heading" tone="secondary">센서가 차량을 감지하면 선택한 조명에 동작을 적용합니다.</Text>
              <Heading as="h3" variant="customer-card-title">01 감지 센서</Heading>
              <AutomationSelectionCard
                fieldRef={sourceCardRef}
                triggerRef={sourceTriggerRef}
                label="감지 센서"
                title={sourceSummary.count > 0 ? sourceSummary.title : "감지 센서를 선택해 주세요."}
                description={sourceSummary.count > 0 ? sourceSummary.description : "움직임을 감지할 조명을 선택하세요."}
                empty={sourceSummary.count === 0}
                disabled={isPending}
                error={errors.sourceFixtureIds}
                errorId={vehicleEventErrorIds.source}
                kind="sensor"
                onOpen={() => setView("source")}
              />
              {isBio ? <div className="grid gap-2">
                <Checkbox label="감지한 조명도 제어" isSelected={selfControlEnabled} isDisabled={isPending}
                  onChange={selected => change({ selfControlEnabled: selected })} />
                <Text variant="caption" tone="secondary">감지한 조명 자신의 밝기와 유지시간을 설정합니다. 무감지 밝기는 조명에 저장된 값을 유지합니다.</Text>
              </div> : null}
              <ArrowDown className="justify-self-center text-content-secondary" size={20} aria-hidden="true" />
              <Heading as="h3" variant="customer-card-title">02 실행 조명</Heading>
              <AutomationSelectionCard
                fieldRef={targetCardRef}
                triggerRef={targetTriggerRef}
                label="실행할 조명"
                title={targetSummary.count > 0 ? targetSummary.title : selfControlEnabled ? "자기 조명만 제어합니다." : "실행할 조명을 선택해 주세요."}
                description={sourceReadyForTarget
                  ? (targetSummary.count > 0 ? targetSummary.description : selfControlEnabled ? "다른 조명도 함께 제어하려면 추가로 선택하세요. 선택하지 않아도 저장할 수 있습니다." : "감지 시 함께 제어할 조명을 선택하세요.")
                  : "감지 센서를 먼저 선택하면 같은 게이트웨이의 실행 조명을 고를 수 있습니다."}
                empty={targetSummary.count === 0}
                disabled={isPending || !sourceReadyForTarget}
                error={errors.targetFixtureIds}
                errorId={vehicleEventErrorIds.target}
                onOpen={() => setView("target")}
              />
            </section>

            <ArrowDown className="justify-self-center text-content-secondary" size={20} aria-hidden="true" />
            <section className={`grid gap-3 rounded-panel border border-border-default ${panelPaddingClass("regular")}`} aria-labelledby="event-action-heading">
              <Heading as="h3" id="event-action-heading" variant="customer-card-title">03 동작 설정</Heading>
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
                  <Slider label="밝기 조절" minValue={selfControlEnabled ? 1 : 0} maxValue={100} value={Number(values.dimmingEnabled ? values.brightnessPercent : "100") || 0} isDisabled={!values.dimmingEnabled} onChange={(value) => change({ brightnessPercent: String(value) })} />
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
                  <TextField ref={holdSecondsInputRef} label="유지 시간" description={selfControlEnabled ? "1~127초, 그 이상은 60초 단위(최대 1,800초). 기본 60초." : `${isBio ? "1" : "5"}~1,800초, 기본 60초. 초 단위로 입력하세요.`} inputMode="numeric" isInvalid={Boolean(errors.holdSeconds)} errorMessage={errors.holdSeconds} value={values.holdSeconds} onChange={(value) => change({ holdSeconds: value })} />
                ) : null}
                {isBio ? <Text tone="secondary">센서 설정은 자동으로 처리합니다. {rule ? "저장 시 현재 활성 상태를 유지합니다." : "저장 후 목록의 전원 버튼으로 활성화하세요."}</Text> : null}
                {isBio && (!selfControlEnabled || values.targetFixtureIds.length > 0) && Number(values.holdSeconds) >= 1 && Number(values.holdSeconds) <= 10 ? <Text role="note" tone="warning">다른 조명 연동의 짧은 유지시간에서는 움직임이 이어져도 감지 신호 간격이 길면 조명이 꺼졌다 다시 켜질 수 있습니다.</Text> : null}
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
              <Button variant="primary" type="submit" disabled={bioSourceBlocked} isLoading={isPending} loadingLabel="설정 중">저장</Button>
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
