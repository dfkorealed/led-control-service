import type { AutomationRuleStatus } from "@led-control/shared";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CreateScheduleInput, ScheduleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { useDialogFocus } from "../../../components/ConfirmDialog";
import { ControlTargetPicker } from "../ControlTargetPicker";
import {
  createEmptyScheduleForm,
  scheduleFormToInput,
  scheduleToFormValues,
  validateScheduleForm,
  type ScheduleFormErrors,
  type ScheduleFormValues
} from "./schedule-form";

const weekdays = [
  [1, "월"],
  [2, "화"],
  [3, "수"],
  [4, "목"],
  [5, "금"],
  [6, "토"],
  [7, "일"]
] as const;

export function ScheduleDialog({
  open,
  schedule,
  dashboard,
  isPending,
  serverError,
  returnFocusElement,
  onClose,
  onSubmit
}: {
  open: boolean;
  schedule: ScheduleResponse | null;
  dashboard: Dashboard;
  isPending: boolean;
  serverError: string;
  returnFocusElement?: HTMLElement | null;
  onClose: () => void;
  onSubmit: (input: CreateScheduleInput) => void;
}) {
  const timeZone = dashboard.site.timeZone;
  const dialogRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const targetSectionRef = useRef<HTMLFieldSetElement>(null);
  const [values, setValues] = useState<ScheduleFormValues>(() => createEmptyScheduleForm(timeZone));
  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const title = schedule ? "스케줄 수정" : "스케줄 추가";
  const titleId = "schedule-dialog-title";

  useEffect(() => {
    if (!open) return;
    setValues(schedule
      ? scheduleToFormValues(schedule, timeZone)
      : createEmptyScheduleForm(timeZone));
    setErrors({});
  }, [open, schedule, timeZone]);

  useDialogFocus({
    open,
    dialogRef,
    returnFocusElement,
    onClose,
    initialFocusRef: nameInputRef
  });

  if (!open) return null;

  function change(patch: Partial<ScheduleFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors = validateScheduleForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstInvalidControl(nextErrors);
      return;
    }
    const status: AutomationRuleStatus = schedule?.status ?? "enabled";
    onSubmit(scheduleFormToInput(values, timeZone, status));
  }

  return (
    <div className="schedule-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !isPending) onClose();
    }}>
      <section
        ref={dialogRef}
        className="schedule-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="schedule-dialog-header">
          <div>
            <span className="eyebrow">현장 시간대 · {timeZone}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={`${title} 닫기`} onClick={onClose} disabled={isPending}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <form className="schedule-form" onSubmit={submit} noValidate>
          <label className="form-field schedule-name-field">
            <span>스케줄 이름</span>
            <input
              ref={nameInputRef}
              aria-label="스케줄 이름"
              aria-invalid={Boolean(errors.name)}
              value={values.name}
              disabled={isPending}
              onChange={(event) => change({ name: event.target.value })}
            />
            <FieldError message={errors.name} />
          </label>

          <fieldset className="schedule-form-section" disabled={isPending}>
            <legend>운영 기간과 시간</legend>
            <p className="schedule-field-help">날짜와 시각은 브라우저가 아닌 {timeZone} 현장 기준입니다.</p>
            <div className="schedule-form-grid two-columns">
              <label className="form-field">
                <span>적용 시작일</span>
                <input
                  type="date"
                  aria-label="적용 시작일"
                  aria-invalid={Boolean(errors.activeFromDate)}
                  value={values.activeFromDate}
                  onChange={(event) => change({ activeFromDate: event.target.value })}
                />
                <FieldError message={errors.activeFromDate} />
              </label>
              <label className="form-field">
                <span>적용 종료일</span>
                <input
                  type="date"
                  aria-label="적용 종료일"
                  aria-invalid={Boolean(errors.activeUntilDate)}
                  value={values.activeUntilDate}
                  onChange={(event) => change({ activeUntilDate: event.target.value })}
                />
                <FieldError message={errors.activeUntilDate} />
              </label>
              <label className="form-field">
                <span>시작 시각</span>
                <input
                  type="time"
                  aria-label="시작 시각"
                  aria-invalid={Boolean(errors.localStartTime)}
                  value={values.localStartTime}
                  onChange={(event) => change({ localStartTime: event.target.value })}
                />
                <FieldError message={errors.localStartTime} />
              </label>
              <label className="form-field">
                <span>종료 시각</span>
                <input
                  type="time"
                  aria-label="종료 시각"
                  aria-invalid={Boolean(errors.localEndTime)}
                  value={values.localEndTime}
                  onChange={(event) => change({ localEndTime: event.target.value })}
                />
                <FieldError message={errors.localEndTime} />
              </label>
            </div>
            <p className="schedule-field-help">종료 시각이 시작 시각보다 빠르면 다음 날 종료로 실행합니다.</p>
          </fieldset>

          <fieldset className="schedule-form-section" disabled={isPending}>
            <legend>반복</legend>
            <label className="form-field">
              <span>반복</span>
              <select
                aria-label="반복"
                value={values.recurrenceKind}
                onChange={(event) => change({
                  recurrenceKind: event.target.value as ScheduleFormValues["recurrenceKind"]
                })}
              >
                <option value="once">1회</option>
                <option value="daily">매일</option>
                <option value="weekly">매주</option>
                <option value="monthly">매월</option>
                <option value="yearly">매년</option>
              </select>
            </label>

            {values.recurrenceKind === "weekly" ? (
              <div className="schedule-weekdays" role="group" aria-label="반복 요일">
                {weekdays.map(([day, label]) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={values.weeklyDays.includes(day)}
                      onChange={() => change({
                        weeklyDays: values.weeklyDays.includes(day)
                          ? values.weeklyDays.filter((value) => value !== day)
                          : [...values.weeklyDays, day]
                      })}
                    />
                    {label}
                  </label>
                ))}
                <FieldError message={errors.weeklyDays} />
              </div>
            ) : null}

            {values.recurrenceKind === "monthly" ? (
              <label className="form-field schedule-compact-number">
                <span>매월 날짜</span>
                <input
                  type="number"
                  min="1"
                  max="31"
                  aria-label="매월 날짜"
                  aria-invalid={Boolean(errors.monthlyDay)}
                  value={values.monthlyDay}
                  onChange={(event) => change({ monthlyDay: event.target.value })}
                />
                <FieldError message={errors.monthlyDay} />
                <small>29~31일이 없는 달에는 해당 실행을 건너뜁니다.</small>
              </label>
            ) : null}

            {values.recurrenceKind === "yearly" ? (
              <div className="schedule-yearly-fields">
                <label className="form-field">
                  <span>월</span>
                  <input
                    type="number"
                    min="1"
                    max="12"
                    aria-label="매년 월"
                    aria-invalid={Boolean(errors.yearlyMonth)}
                    value={values.yearlyMonth}
                    onChange={(event) => change({ yearlyMonth: event.target.value })}
                  />
                  <FieldError message={errors.yearlyMonth} />
                </label>
                <label className="form-field">
                  <span>일</span>
                  <input
                    type="number"
                    min="1"
                    max="31"
                    aria-label="매년 날짜"
                    aria-invalid={Boolean(errors.yearlyDay)}
                    value={values.yearlyDay}
                    onChange={(event) => change({ yearlyDay: event.target.value })}
                  />
                  <FieldError message={errors.yearlyDay} />
                </label>
                <small>2월 29일은 윤년에만 실행하며, 날짜가 없는 해에는 건너뜁니다.</small>
              </div>
            ) : null}
          </fieldset>

          <fieldset className="schedule-form-section" disabled={isPending}>
            <legend>밝기</legend>
            <label className="schedule-dimming-toggle">
              <input
                type="checkbox"
                aria-label="디밍 사용"
                checked={values.dimmingEnabled}
                onChange={(event) => change({ dimmingEnabled: event.target.checked })}
              />
              <span>디밍 {values.dimmingEnabled ? "ON" : "OFF"}</span>
            </label>
            {values.dimmingEnabled ? (
              <div className="schedule-brightness-control">
                <input
                  type="range"
                  min="0"
                  max="100"
                  aria-label="밝기 조절"
                  value={values.brightnessPercent}
                  onChange={(event) => change({ brightnessPercent: event.target.value })}
                />
                <label className="form-field">
                  <span>밝기</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    aria-label="밝기"
                    aria-invalid={Boolean(errors.brightnessPercent)}
                    value={values.brightnessPercent}
                    onChange={(event) => change({ brightnessPercent: event.target.value })}
                  />
                </label>
                <span>%</span>
              </div>
            ) : (
              <p className="schedule-field-help">디밍 OFF는 100% 밝기로 실행합니다.</p>
            )}
            <FieldError message={errors.brightnessPercent} />
          </fieldset>

          <fieldset ref={targetSectionRef} className="schedule-form-section schedule-target-section" disabled={isPending} tabIndex={-1}>
            <legend>제어 대상</legend>
            <ControlTargetPicker
              dashboard={dashboard}
              selection={values.target}
              disabled={isPending}
              onChange={(target) => change({ target })}
            />
            <FieldError message={errors.target} />
          </fieldset>

          {serverError ? <p className="danger-text schedule-form-server-error" role="alert">{serverError}</p> : null}
          <footer className="schedule-dialog-actions">
            <button type="button" onClick={onClose} disabled={isPending}>취소</button>
            <button className="primary-button" type="submit" disabled={isPending}>
              {isPending ? "저장 중" : schedule ? "변경 저장" : "스케줄 만들기"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );

  function focusFirstInvalidControl(nextErrors: ScheduleFormErrors) {
    if (nextErrors.name) return nameInputRef.current?.focus();
    if (nextErrors.target) targetSectionRef.current?.focus();
  }
}

function FieldError({ message }: { message?: string }) {
  return message ? <span className="field-error">{message}</span> : null;
}
