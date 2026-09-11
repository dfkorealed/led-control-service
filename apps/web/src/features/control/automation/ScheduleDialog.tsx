import type { AutomationRuleStatus } from "@led-control/shared";
import { ArrowRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CreateScheduleInput, ScheduleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { useDialogFocus } from "../../../components/ConfirmDialog";
import { Button } from "../../../components/ui";
import { ControlTargetPicker } from "../ControlTargetPicker";
import {
  applySchedulePreset,
  controlSelectionSummary,
  fixtureIdsAvailability,
  schedulePreset,
  scheduleSummary,
  type SchedulePreset
} from "./automation-presenters";
import {
  AutomationAdvancedSection,
  AutomationPresetGroup,
  AutomationSelectionCard,
  AutomationSummaryBar,
  AutomationTargetPickerView
} from "./components/AutomationQuickFields";
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

const schedulePresets: readonly { value: SchedulePreset; label: string }[] = [
  { value: "daily", label: "매일" },
  { value: "weekday", label: "평일" },
  { value: "weekend", label: "주말" },
  { value: "once", label: "한 번" }
];

const brightnessPresets = ["30", "50", "70", "100"] as const;

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
  const activeFromDateInputRef = useRef<HTMLInputElement>(null);
  const activeUntilDateInputRef = useRef<HTMLInputElement>(null);
  const localStartTimeInputRef = useRef<HTMLInputElement>(null);
  const localEndTimeInputRef = useRef<HTMLInputElement>(null);
  const weeklyDaysInputRef = useRef<HTMLInputElement>(null);
  const monthlyDayInputRef = useRef<HTMLInputElement>(null);
  const yearlyMonthInputRef = useRef<HTMLInputElement>(null);
  const yearlyDayInputRef = useRef<HTMLInputElement>(null);
  const dimmingToggleRef = useRef<HTMLInputElement>(null);
  const brightnessInputRef = useRef<HTMLInputElement>(null);
  const targetCardRef = useRef<HTMLDivElement>(null);
  const targetSectionRef = useRef<HTMLFieldSetElement>(null);
  const [values, setValues] = useState<ScheduleFormValues>(() => createEmptyScheduleForm(timeZone));
  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const [view, setView] = useState<"main" | "target">("main");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<keyof ScheduleFormErrors | null>(null);
  const title = schedule ? "스케줄 수정" : "스케줄 추가";
  const titleId = "schedule-dialog-title";

  useEffect(() => {
    if (!open) return;
    const nextValues = schedule
      ? scheduleToFormValues(schedule, timeZone)
      : createEmptyScheduleForm(timeZone);
    setValues(nextValues);
    setErrors({});
    setView("main");
    setAdvancedOpen(Boolean(schedule && schedulePreset(nextValues) === "custom"));
    setPendingFocus(null);
  }, [open, schedule, timeZone]);

  useEffect(() => {
    if (!pendingFocus) return;
    const target = focusTarget(pendingFocus);
    if (!target) return;
    target.focus();
    setPendingFocus(null);
  }, [advancedOpen, pendingFocus, view]);

  useDialogFocus({
    open,
    dialogRef,
    returnFocusElement,
    onClose,
    initialFocusRef: localStartTimeInputRef
  });

  if (!open) return null;

  const targetSummary = controlSelectionSummary(values.target, dashboard);
  const selectedPreset = schedulePreset(values);

  function change(patch: Partial<ScheduleFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors = validateScheduleForm(values);
    if (
      values.target.mode === "fixtures"
      && fixtureIdsAvailability(values.target.fixtureIds, dashboard).invalidFixtureIds.length > 0
    ) {
      nextErrors.target = "현재 현장에서 확인되지 않는 조명이 포함되어 있습니다. 대상을 다시 선택해 주세요.";
    }
    setErrors(nextErrors);
    const firstError = firstScheduleError(nextErrors);
    if (firstError) {
      if (advancedErrorKeys.includes(firstError)) setAdvancedOpen(true);
      if (firstError === "target") setView("target");
      setPendingFocus(firstError);
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
        className="schedule-dialog automation-quick-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="schedule-dialog-header">
          <div>
            <span className="eyebrow">현장 시간대 · {timeZone}</span>
            <div className="automation-dialog-title-row">
              <h2 id={titleId}>{title}</h2>
              <span className="automation-quick-badge">빠른 설정</span>
            </div>
          </div>
          <button className="icon-button" type="button" aria-label={`${title} 닫기`} onClick={onClose} disabled={isPending}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {view === "target" ? (
          <AutomationTargetPickerView
            title="제어 대상 선택"
            description="개별 조명, 층 전체 또는 저장된 구역을 선택하세요."
            disabled={isPending}
            onDone={() => {
              setView("main");
              setPendingFocus(null);
              queueMicrotask(() => targetCardRef.current?.focus());
            }}
          >
            <fieldset
              ref={targetSectionRef}
              className="automation-picker-fieldset"
              disabled={isPending}
              tabIndex={-1}
              {...errorAttributes(errors.target, scheduleErrorIds.target)}
            >
              <legend className="sr-only">제어 대상 선택</legend>
              <ControlTargetPicker
                dashboard={dashboard}
                selection={values.target}
                disabled={isPending}
                onChange={(target) => change({ target })}
              />
              <FieldError id={scheduleErrorIds.target} message={errors.target} />
            </fieldset>
          </AutomationTargetPickerView>
        ) : (
          <form className="schedule-form automation-quick-form" onSubmit={submit} noValidate>
            <fieldset className="automation-quick-section" disabled={isPending}>
              <legend>언제 켤까요?</legend>
              <AutomationPresetGroup
                label="반복 프리셋"
                value={selectedPreset}
                options={schedulePresets}
                disabled={isPending}
                onChange={(preset) => {
                  if (preset !== "custom") change(applySchedulePreset(values, preset));
                }}
              />
              {selectedPreset === "custom" ? <p className="automation-inline-note">고급 설정에서 사용자 지정 반복을 사용 중입니다.</p> : null}
              <div className="automation-time-row">
                <label className="form-field">
                  <span>시작 시각</span>
                  <input
                    ref={localStartTimeInputRef}
                    type="time"
                    aria-label="시작 시각"
                    {...errorAttributes(errors.localStartTime, scheduleErrorIds.localStartTime)}
                    value={values.localStartTime}
                    onChange={(event) => change({ localStartTime: event.target.value })}
                  />
                  <FieldError id={scheduleErrorIds.localStartTime} message={errors.localStartTime} />
                </label>
                <ArrowRight size={20} aria-hidden="true" />
                <label className="form-field">
                  <span>종료 시각</span>
                  <input
                    ref={localEndTimeInputRef}
                    type="time"
                    aria-label="종료 시각"
                    {...errorAttributes(errors.localEndTime, scheduleErrorIds.localEndTime)}
                    value={values.localEndTime}
                    onChange={(event) => change({ localEndTime: event.target.value })}
                  />
                  <FieldError id={scheduleErrorIds.localEndTime} message={errors.localEndTime} />
                </label>
              </div>
              <p className="schedule-field-help">종료 시각이 더 빠르면 다음 날 종료로 실행합니다.</p>
            </fieldset>

            <section className="automation-quick-section" aria-labelledby="schedule-target-heading">
              <h3 id="schedule-target-heading">어느 조명을 켤까요?</h3>
              <AutomationSelectionCard
                fieldRef={targetCardRef}
                label="제어 대상"
                title={targetSummary.title}
                description={targetSummary.description}
                empty={targetSummary.count === 0}
                disabled={isPending}
                error={errors.target}
                errorId={scheduleErrorIds.target}
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
                <input
                  type="range"
                  min="0"
                  max="100"
                  aria-label="밝기 조절"
                  disabled={!values.dimmingEnabled}
                  value={values.dimmingEnabled ? values.brightnessPercent : "100"}
                  onChange={(event) => change({ brightnessPercent: event.target.value })}
                />
                <label className="form-field automation-brightness-number">
                  <span>밝기</span>
                  <input
                    ref={brightnessInputRef}
                    type="number"
                    min="0"
                    max="100"
                    aria-label="밝기"
                    disabled={!values.dimmingEnabled}
                    {...(values.dimmingEnabled ? errorAttributes(errors.brightnessPercent, scheduleErrorIds.brightnessPercent) : { "aria-invalid": false })}
                    value={values.dimmingEnabled ? values.brightnessPercent : "100"}
                    onChange={(event) => change({ brightnessPercent: event.target.value })}
                  />
                </label>
                <span>%</span>
              </div>
              <FieldError id={scheduleErrorIds.brightnessPercent} message={errors.brightnessPercent} />
            </fieldset>

            <AutomationAdvancedSection label="세부 일정 설정" open={advancedOpen} disabled={isPending} onOpenChange={setAdvancedOpen}>
              <label className="form-field schedule-name-field">
                <span>스케줄 이름</span>
                <input ref={nameInputRef} aria-label="스케줄 이름" {...errorAttributes(errors.name, scheduleErrorIds.name)} value={values.name} disabled={isPending} onChange={(event) => change({ name: event.target.value })} />
                <FieldError id={scheduleErrorIds.name} message={errors.name} />
              </label>
              <div className="schedule-form-grid two-columns">
                <label className="form-field">
                  <span>적용 시작일</span>
                  <input ref={activeFromDateInputRef} type="date" aria-label="적용 시작일" {...errorAttributes(errors.activeFromDate, scheduleErrorIds.activeFromDate)} value={values.activeFromDate} onChange={(event) => change({ activeFromDate: event.target.value })} />
                  <FieldError id={scheduleErrorIds.activeFromDate} message={errors.activeFromDate} />
                </label>
                <label className="form-field">
                  <span>적용 종료일</span>
                  <input ref={activeUntilDateInputRef} type="date" aria-label="적용 종료일" {...errorAttributes(errors.activeUntilDate, scheduleErrorIds.activeUntilDate)} value={values.activeUntilDate} onChange={(event) => change({ activeUntilDate: event.target.value })} />
                  <FieldError id={scheduleErrorIds.activeUntilDate} message={errors.activeUntilDate} />
                </label>
              </div>
              <p className="schedule-field-help">날짜는 {timeZone} 현장 기준입니다.</p>
              <label className="form-field">
                <span>반복 상세</span>
                <select aria-label="반복" value={values.recurrenceKind} onChange={(event) => change({ recurrenceKind: event.target.value as ScheduleFormValues["recurrenceKind"] })}>
                  <option value="once">1회</option>
                  <option value="daily">매일</option>
                  <option value="weekly">매주</option>
                  <option value="monthly">매월</option>
                  <option value="yearly">매년</option>
                </select>
              </label>
              {values.recurrenceKind === "weekly" ? (
                <div className="schedule-weekdays" role="group" aria-label="반복 요일" {...errorAttributes(errors.weeklyDays, scheduleErrorIds.weeklyDays)}>
                  {weekdays.map(([day, label]) => (
                    <label key={day}>
                      <input
                        ref={day === weekdays[0][0] ? weeklyDaysInputRef : undefined}
                        type="checkbox"
                        {...errorAttributes(errors.weeklyDays, scheduleErrorIds.weeklyDays)}
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
                  <FieldError id={scheduleErrorIds.weeklyDays} message={errors.weeklyDays} />
                </div>
              ) : null}
              {values.recurrenceKind === "monthly" ? (
                <label className="form-field schedule-compact-number">
                  <span>매월 날짜</span>
                  <input ref={monthlyDayInputRef} type="number" min="1" max="31" aria-label="매월 날짜" {...errorAttributes(errors.monthlyDay, scheduleErrorIds.monthlyDay)} value={values.monthlyDay} onChange={(event) => change({ monthlyDay: event.target.value })} />
                  <FieldError id={scheduleErrorIds.monthlyDay} message={errors.monthlyDay} />
                  <small>29~31일이 없는 달에는 해당 실행을 건너뜁니다.</small>
                </label>
              ) : null}
              {values.recurrenceKind === "yearly" ? (
                <div className="schedule-yearly-fields">
                  <label className="form-field">
                    <span>월</span>
                    <input ref={yearlyMonthInputRef} type="number" min="1" max="12" aria-label="매년 월" {...errorAttributes(errors.yearlyMonth, scheduleErrorIds.yearlyMonth)} value={values.yearlyMonth} onChange={(event) => change({ yearlyMonth: event.target.value })} />
                    <FieldError id={scheduleErrorIds.yearlyMonth} message={errors.yearlyMonth} />
                  </label>
                  <label className="form-field">
                    <span>일</span>
                    <input ref={yearlyDayInputRef} type="number" min="1" max="31" aria-label="매년 날짜" {...errorAttributes(errors.yearlyDay, scheduleErrorIds.yearlyDay)} value={values.yearlyDay} onChange={(event) => change({ yearlyDay: event.target.value })} />
                    <FieldError id={scheduleErrorIds.yearlyDay} message={errors.yearlyDay} />
                  </label>
                  <small>2월 29일은 윤년에만 실행하며 날짜가 없는 해에는 건너뜁니다.</small>
                </div>
              ) : null}
              <label className="schedule-dimming-toggle">
                <input
                  ref={dimmingToggleRef}
                  type="checkbox"
                  aria-label="디밍 사용"
                  {...(!values.dimmingEnabled ? errorAttributes(errors.brightnessPercent, scheduleErrorIds.brightnessPercent) : {})}
                  checked={values.dimmingEnabled}
                  onChange={(event) => change({ dimmingEnabled: event.target.checked })}
                />
                <span>밝기 직접 지정 {values.dimmingEnabled ? "ON" : "OFF"}</span>
              </label>
            </AutomationAdvancedSection>

            <AutomationSummaryBar>{scheduleSummary(values, dashboard)}</AutomationSummaryBar>
            {serverError ? <p className="danger-text schedule-form-server-error" role="alert">{serverError}</p> : null}
            <footer className="schedule-dialog-actions">
              <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>취소</Button>
              <Button className="primary-button" variant="primary" type="submit" isLoading={isPending} loadingLabel="저장 중">
                {schedule ? "변경 저장" : "스케줄 만들기"}
              </Button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );

  function focusTarget(key: keyof ScheduleFormErrors) {
    if (key === "name") return nameInputRef.current;
    if (key === "activeFromDate") return activeFromDateInputRef.current;
    if (key === "activeUntilDate") return activeUntilDateInputRef.current;
    if (key === "localStartTime") return localStartTimeInputRef.current;
    if (key === "localEndTime") return localEndTimeInputRef.current;
    if (key === "weeklyDays") return weeklyDaysInputRef.current;
    if (key === "monthlyDay") return monthlyDayInputRef.current;
    if (key === "yearlyMonth") return yearlyMonthInputRef.current;
    if (key === "yearlyDay") return yearlyDayInputRef.current;
    if (key === "brightnessPercent") return values.dimmingEnabled ? brightnessInputRef.current : dimmingToggleRef.current;
    return targetSectionRef.current;
  }
}

const advancedErrorKeys: readonly (keyof ScheduleFormErrors)[] = [
  "name",
  "activeFromDate",
  "activeUntilDate",
  "weeklyDays",
  "monthlyDay",
  "yearlyMonth",
  "yearlyDay"
];

function firstScheduleError(errors: ScheduleFormErrors): keyof ScheduleFormErrors | null {
  const order: readonly (keyof ScheduleFormErrors)[] = [
    "name",
    "activeFromDate",
    "activeUntilDate",
    "localStartTime",
    "localEndTime",
    "weeklyDays",
    "monthlyDay",
    "yearlyMonth",
    "yearlyDay",
    "brightnessPercent",
    "target"
  ];
  return order.find((key) => Boolean(errors[key])) ?? null;
}

const scheduleErrorIds = {
  name: "schedule-name-error",
  activeFromDate: "schedule-active-from-date-error",
  activeUntilDate: "schedule-active-until-date-error",
  localStartTime: "schedule-local-start-time-error",
  localEndTime: "schedule-local-end-time-error",
  weeklyDays: "schedule-weekly-days-error",
  monthlyDay: "schedule-monthly-day-error",
  yearlyMonth: "schedule-yearly-month-error",
  yearlyDay: "schedule-yearly-day-error",
  brightnessPercent: "schedule-brightness-error",
  target: "schedule-target-error"
} as const;

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <span id={id} className="field-error">{message}</span> : null;
}

function errorAttributes(error: string | undefined, id: string) {
  return error
    ? { "aria-invalid": true, "aria-describedby": id, "aria-errormessage": id }
    : { "aria-invalid": false };
}
