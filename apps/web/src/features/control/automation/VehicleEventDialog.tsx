import type { AutomationRuleStatus } from "@led-control/shared";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CreateVehicleEventRuleInput, VehicleEventRuleResponse } from "../../../api/automation";
import type { Dashboard, DashboardFixture } from "../../../api/queries";
import { useDialogFocus } from "../../../components/ConfirmDialog";
import { ControlTargetPicker } from "../ControlTargetPicker";
import {
  createEmptyVehicleEventForm,
  validateVehicleEventForm,
  vehicleEventFormToInput,
  vehicleEventRuleToFormValues,
  type VehicleEventFormErrors,
  type VehicleEventFormValues
} from "./vehicle-event-form";

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
  const nameInputRef = useRef<HTMLInputElement>(null);
  const brightnessInputRef = useRef<HTMLInputElement>(null);
  const holdSecondsInputRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<VehicleEventFormValues>(createEmptyVehicleEventForm);
  const [errors, setErrors] = useState<VehicleEventFormErrors>({});
  const title = rule ? "이벤트 수정" : "이벤트 추가";
  const titleId = "vehicle-event-dialog-title";

  useEffect(() => {
    if (!open) return;
    setValues(rule ? vehicleEventRuleToFormValues(rule) : createEmptyVehicleEventForm());
    setErrors({});
  }, [open, rule]);

  useDialogFocus({ open, dialogRef, returnFocusElement, onClose });

  if (!open) return null;

  function change(patch: Partial<VehicleEventFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors = validateVehicleEventForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstInvalidControl(nextErrors);
      return;
    }
    const status: AutomationRuleStatus = rule?.status ?? "enabled";
    onSubmit(vehicleEventFormToInput(values, status));
  }

  return (
    <div className="schedule-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !isPending) onClose();
    }}>
      <section ref={dialogRef} className="schedule-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="schedule-dialog-header">
          <div>
            <span className="eyebrow">Gateway 차량 감지</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={`${title} 닫기`} onClick={onClose} disabled={isPending}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <form className="schedule-form" onSubmit={submit} noValidate>
          <fieldset ref={sourceFieldRef} className="schedule-form-section" disabled={isPending} tabIndex={-1} {...errorAttributes(errors.sourceFixtureIds, vehicleEventErrorIds.source)}>
            <legend>감지 센서</legend>
            <p className="schedule-field-help">Gateway에 등록되고 차량 감지 capability가 확인된 fixture만 선택할 수 있습니다.</p>
            <ControlTargetPicker
              dashboard={dashboard}
              selection={{ mode: "fixtures", fixtureIds: values.sourceFixtureIds }}
              allowedModes={["fixtures"]}
              fixtureFilter={isVehicleEventSource}
              disabled={isPending}
              onChange={(selection) => {
                if (selection.mode === "fixtures") change({ sourceFixtureIds: selection.fixtureIds });
              }}
            />
            <FieldError id={vehicleEventErrorIds.source} message={errors.sourceFixtureIds} />
          </fieldset>

          <fieldset ref={targetFieldRef} className="schedule-form-section schedule-target-section" disabled={isPending} tabIndex={-1} {...errorAttributes(errors.targetFixtureIds, vehicleEventErrorIds.target)}>
            <legend>제어 조명</legend>
            <ControlTargetPicker
              dashboard={dashboard}
              selection={{ mode: "fixtures", fixtureIds: values.targetFixtureIds }}
              allowedModes={["fixtures"]}
              disabled={isPending}
              onChange={(selection) => {
                if (selection.mode === "fixtures") change({ targetFixtureIds: selection.fixtureIds });
              }}
            />
            <FieldError id={vehicleEventErrorIds.target} message={errors.targetFixtureIds} />
          </fieldset>

          <fieldset className="schedule-form-section" disabled={isPending}>
            <legend>행동</legend>
            <label className="form-field schedule-name-field">
              <span>규칙 이름</span>
              <input ref={nameInputRef} aria-label="규칙 이름" {...errorAttributes(errors.name, vehicleEventErrorIds.name)} value={values.name} onChange={(event) => change({ name: event.target.value })} />
              <FieldError id={vehicleEventErrorIds.name} message={errors.name} />
            </label>
            <label className="schedule-dimming-toggle">
              <input type="checkbox" aria-label="디밍 사용" checked={values.dimmingEnabled} onChange={(event) => change({ dimmingEnabled: event.target.checked })} />
              <span>디밍 {values.dimmingEnabled ? "ON" : "OFF"}</span>
            </label>
            {values.dimmingEnabled ? (
              <label className="form-field schedule-compact-number">
                <span>밝기</span>
                <input ref={brightnessInputRef} type="number" min="0" max="100" aria-label="밝기" {...errorAttributes(errors.brightnessPercent, vehicleEventErrorIds.brightness)} value={values.brightnessPercent} onChange={(event) => change({ brightnessPercent: event.target.value })} />
                <FieldError id={vehicleEventErrorIds.brightness} message={errors.brightnessPercent} />
              </label>
            ) : <p className="schedule-field-help">디밍 OFF는 100% 밝기로 실행합니다.</p>}
            <label className="form-field schedule-compact-number">
              <span>유지 시간(초)</span>
              <input ref={holdSecondsInputRef} type="number" min="5" max="1800" aria-label="유지 시간" {...errorAttributes(errors.holdSeconds, vehicleEventErrorIds.holdSeconds)} value={values.holdSeconds} onChange={(event) => change({ holdSeconds: event.target.value })} />
              <FieldError id={vehicleEventErrorIds.holdSeconds} message={errors.holdSeconds} />
            </label>
          </fieldset>

          {serverError ? <p className="danger-text schedule-form-server-error" role="alert">{serverError}</p> : null}
          <footer className="schedule-dialog-actions">
            <button type="button" onClick={onClose} disabled={isPending}>취소</button>
            <button className="primary-button" type="submit" disabled={isPending}>{isPending ? "저장 중" : "저장"}</button>
          </footer>
        </form>
      </section>
    </div>
  );

  function focusFirstInvalidControl(nextErrors: VehicleEventFormErrors) {
    if (nextErrors.sourceFixtureIds) return sourceFieldRef.current?.focus();
    if (nextErrors.targetFixtureIds) return targetFieldRef.current?.focus();
    if (nextErrors.name) return nameInputRef.current?.focus();
    if (nextErrors.brightnessPercent) return brightnessInputRef.current?.focus();
    if (nextErrors.holdSeconds) holdSecondsInputRef.current?.focus();
  }
}

function isVehicleEventSource(fixture: DashboardFixture) {
  const verifiedAt = fixture.vehicleSensorCapabilityVerifiedAt;
  return fixture.gateway !== null
    && fixture.vehicleSensorCapabilityStatus === "supported"
    && typeof verifiedAt === "string"
    && isCanonicalIsoTimestamp(verifiedAt);
}

function isCanonicalIsoTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
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
  } : {};
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <span id={id} className="field-error" role="alert">{message}</span> : null;
}
