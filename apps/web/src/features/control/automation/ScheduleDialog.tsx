import type { AutomationRuleStatus } from "@led-control/shared";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { CreateScheduleInput, ScheduleResponse } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { Button, Checkbox, DatePicker, Heading, ModalDialog, SelectBox, Slider, Text, TextField, TimePicker, type FocusableFieldHandle } from "../../../components/ui";
import { resolveControlSelection, type ControlSelection } from "../control-selection";
import { SpatialTargetSelector, spatialTargetDialogClassName } from "../target-selection/SpatialTargetSelector";
import {
  applySchedulePreset,
  fixtureIdsAvailability,
  schedulePreset,
  scheduleSummary,
  scheduleTargetSnapshotSummary,
  scheduleTargetStorageCopy,
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
const recurrenceItems: ReadonlyArray<{ id: ScheduleFormValues["recurrenceKind"]; label: string }> = [
  { id: "once", label: "1회" }, { id: "daily", label: "매일" }, { id: "weekly", label: "매주" },
  { id: "monthly", label: "매월" }, { id: "yearly", label: "매년" }
];

export function ScheduleDialog({
  open,
  schedule,
  dashboard,
  isPending,
  serverError,
  returnFocusRef,
  onClose,
  onSubmit
}: {
  open: boolean;
  schedule: ScheduleResponse | null;
  dashboard: Dashboard;
  isPending: boolean;
  serverError: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (input: CreateScheduleInput) => void;
}) {
  const timeZone = dashboard.site.timeZone;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const activeFromDateInputRef = useRef<FocusableFieldHandle>(null);
  const activeUntilDateInputRef = useRef<FocusableFieldHandle>(null);
  const localStartTimeInputRef = useRef<FocusableFieldHandle>(null);
  const localEndTimeInputRef = useRef<FocusableFieldHandle>(null);
  const weeklyDaysInputRef = useRef<HTMLInputElement>(null);
  const monthlyDayInputRef = useRef<HTMLInputElement>(null);
  const yearlyMonthInputRef = useRef<HTMLInputElement>(null);
  const yearlyDayInputRef = useRef<HTMLInputElement>(null);
  const dimmingToggleRef = useRef<HTMLInputElement>(null);
  const brightnessInputRef = useRef<HTMLInputElement>(null);
  const targetCardRef = useRef<HTMLDivElement>(null);
  const targetTriggerRef = useRef<HTMLButtonElement>(null);
  const targetSectionRef = useRef<HTMLFieldSetElement>(null);
  const [values, setValues] = useState<ScheduleFormValues>(() => createEmptyScheduleForm(timeZone));
  const [targetSource, setTargetSource] = useState<ControlSelection>(() => ({ mode: "fixtures", fixtureIds: [] }));
  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const [view, setView] = useState<"main" | "target">("main");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<keyof ScheduleFormErrors | null>(null);
  const title = schedule ? "스케줄 수정" : "스케줄 추가";

  useEffect(() => {
    if (!open) return;
    const nextValues = schedule
      ? scheduleToFormValues(schedule, timeZone)
      : createEmptyScheduleForm(timeZone);
    setValues(nextValues);
    // API responses only contain fixture IDs, so reopened schedules are direct snapshots.
    setTargetSource(nextValues.target);
    setErrors({});
    setView("main");
    setAdvancedOpen(Boolean(schedule && schedulePreset(nextValues) === "custom"));
    setPendingFocus(null);
  }, [open, schedule, timeZone]);

  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => localStartTimeInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!pendingFocus) return;
    const target = focusTarget(pendingFocus);
    if (!target) return;
    target.focus();
    setPendingFocus(null);
  }, [advancedOpen, pendingFocus, view]);

  const targetResolution = resolveControlSelection(dashboard, values.target);
  const sourceResolution = resolveControlSelection(dashboard, targetSource);
  // Direct fixture selections are already fully represented by `values.target`.
  // Only authored group/floor snapshots need their live source readiness retained.
  const sourceUnavailable = targetSource.mode !== "fixtures" && !sourceResolution.available;
  const targetFixtureIds = values.target.mode === "fixtures" ? values.target.fixtureIds : [];
  const targetSummary = scheduleTargetSnapshotSummary(targetSource, targetFixtureIds, dashboard);
  const selectedPreset = schedulePreset(values);
  const siteToday = createEmptyScheduleForm(timeZone).activeFromDate;
  const singleDay = Boolean(values.activeFromDate) && values.activeFromDate === values.activeUntilDate;

  function change(patch: Partial<ScheduleFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
  }

  function changeTarget(source: ControlSelection) {
    const resolved = resolveControlSelection(dashboard, source);
    // Floor/group membership is resolved now. The schedule payload remains an immutable fixture snapshot.
    const target: ControlSelection = { mode: "fixtures", fixtureIds: resolved.fixtureIds };
    setTargetSource(source);
    change({ target });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors = validateScheduleForm(values);
    const currentTarget = resolveControlSelection(dashboard, values.target);
    if (!currentTarget.available) {
      nextErrors.target = currentTarget.unavailableReason ?? "현재 제어할 수 없는 대상입니다.";
    }
    if (
      values.target.mode === "fixtures"
      && fixtureIdsAvailability(values.target.fixtureIds, dashboard).invalidFixtureIds.length > 0
    ) {
      nextErrors.target = "현재 현장에서 확인되지 않는 조명이 포함되어 있습니다. 대상을 다시 선택해 주세요.";
    }
    if (sourceUnavailable) {
      nextErrors.target = sourceResolution.unavailableReason ?? "현재 제어할 수 없는 대상입니다.";
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
    <ModalDialog
      isOpen={open}
      title={title}
      description={`빠른 설정 · 현장 시간대 ${timeZone}`}
      closeLabel={`${title} 닫기`}
      isPending={isPending}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      className={view === "target"
        ? spatialTargetDialogClassName
        : "max-w-4xl"}
      bodyClassName={view === "target" ? "grid min-h-0 overflow-hidden" : undefined}
    >

        {view === "target" ? (
          <AutomationTargetPickerView
            title="제어 대상 선택"
            description="개별 조명, 층 전체 또는 저장된 구역을 선택하세요."
            disabled={isPending}
            doneLabel={targetResolution.fixtureIds.length > 0 ? `${targetResolution.fixtureIds.length}개 조명 선택 완료` : "선택 완료"}
            doneDisabled={!targetResolution.available || sourceUnavailable}
            className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4"
            onDone={() => {
              setView("main");
              setPendingFocus(null);
              queueMicrotask(() => targetTriggerRef.current?.focus());
            }}
          >
            <fieldset
              ref={targetSectionRef}
              className="m-0 flex min-h-0 flex-col gap-3 overflow-hidden border-0 p-0"
              disabled={isPending}
              tabIndex={-1}
              {...errorAttributes(errors.target, scheduleErrorIds.target)}
            >
              <legend className="sr-only">제어 대상 선택</legend>
              <Text variant="caption" tone="secondary">{scheduleTargetStorageCopy(targetSource, targetFixtureIds)}</Text>
              <SpatialTargetSelector
                siteId={dashboard.site.id}
                dashboard={dashboard}
                selection={targetSource}
                displaySelection={values.target}
                disabled={isPending}
                modeLabels={{ fixtures: "직접 선택" }}
                modeSelectionSemantics="pressed"
                onChange={changeTarget}
              />
              <FieldError id={scheduleErrorIds.target} message={errors.target} />
            </fieldset>
          </AutomationTargetPickerView>
        ) : (
          <form className="grid gap-4" onSubmit={submit} noValidate>
            <fieldset className="m-0 grid gap-3 rounded-panel border border-border-default p-4" disabled={isPending}>
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
              {selectedPreset === "custom" ? <Text variant="caption" tone="secondary">고급 설정에서 사용자 지정 반복을 사용 중입니다.</Text> : null}
              <div className="grid grid-cols-2 gap-3 max-compact:grid-cols-1">
                <DatePicker ref={activeFromDateInputRef} label="적용 시작일" isInvalid={Boolean(errors.activeFromDate)} errorMessage={errors.activeFromDate} value={values.activeFromDate || null} onChange={(value) => change({ activeFromDate: value ?? "" })} />
                <DatePicker ref={activeUntilDateInputRef} label="적용 종료일" isInvalid={Boolean(errors.activeUntilDate)} errorMessage={errors.activeUntilDate} value={values.activeUntilDate || null} onChange={(value) => change({ activeUntilDate: value ?? "" })} />
              </div>
              <Text className="rounded-control bg-surface-inset p-3" variant="body-sm" tone="secondary">
                {singleDay
                  ? values.activeFromDate === siteToday
                    ? "오늘만 적용됩니다. 매일 반복을 계속하려면 적용 종료일을 변경하세요."
                    : "선택한 날짜 하루만 적용됩니다. 반복을 계속하려면 적용 종료일을 변경하세요."
                  : `적용 기간은 ${timeZone} 현장 기준입니다. 종료일 이후에는 반복 실행되지 않습니다.`}
              </Text>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-3 max-compact:grid-cols-1">
                <TimePicker
                  ref={localStartTimeInputRef}
                  label="시작 시각"
                  isDisabled={isPending}
                  isInvalid={Boolean(errors.localStartTime)}
                  errorMessage={errors.localStartTime}
                  value={values.localStartTime || null}
                  onChange={(value) => change({ localStartTime: value ?? "" })}
                />
                <ArrowRight size={20} aria-hidden="true" />
                <TimePicker
                  ref={localEndTimeInputRef}
                  label="종료 시각"
                  isDisabled={isPending}
                  isInvalid={Boolean(errors.localEndTime)}
                  errorMessage={errors.localEndTime}
                  value={values.localEndTime || null}
                  onChange={(value) => change({ localEndTime: value ?? "" })}
                />
              </div>
              <Text variant="caption" tone="secondary">종료 시각이 더 빠르면 다음 날 종료로 실행합니다.</Text>
            </fieldset>

            <section className="grid gap-3 rounded-panel border border-border-default p-4" aria-labelledby="schedule-target-heading">
              <Heading as="h3" id="schedule-target-heading" variant="card-title">어느 조명을 켤까요?</Heading>
              <AutomationSelectionCard
                fieldRef={targetCardRef}
                triggerRef={targetTriggerRef}
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

            <fieldset className="m-0 grid gap-3 rounded-panel border border-border-default p-4" disabled={isPending}>
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
                <TextField
                  ref={brightnessInputRef}
                  label="밝기"
                  inputMode="numeric"
                  isDisabled={!values.dimmingEnabled}
                  isInvalid={values.dimmingEnabled && Boolean(errors.brightnessPercent)}
                  errorMessage={values.dimmingEnabled ? errors.brightnessPercent : undefined}
                  value={values.dimmingEnabled ? values.brightnessPercent : "100"}
                  onChange={(value) => change({ brightnessPercent: value })}
                />
              </div>
              {!values.dimmingEnabled ? <FieldError id={scheduleErrorIds.brightnessPercent} message={errors.brightnessPercent} /> : null}
            </fieldset>

            <AutomationAdvancedSection label="세부 일정 설정" open={advancedOpen} disabled={isPending} onOpenChange={setAdvancedOpen}>
              <TextField ref={nameInputRef} label="스케줄 이름" isInvalid={Boolean(errors.name)} errorMessage={errors.name} value={values.name} isDisabled={isPending} onChange={(value) => change({ name: value })} />
              <SelectBox label="반복" items={recurrenceItems} selectedKey={values.recurrenceKind} onSelectionChange={(key) => key && change({ recurrenceKind: key })} />
              {values.recurrenceKind === "weekly" ? (
                <div className="flex flex-wrap gap-3" role="group" aria-label="반복 요일" {...errorAttributes(errors.weeklyDays, scheduleErrorIds.weeklyDays)}>
                  {weekdays.map(([day, label]) => (
                    <Checkbox
                        key={day}
                        ref={day === weekdays[0][0] ? weeklyDaysInputRef : undefined}
                        label={label}
                        isInvalid={Boolean(errors.weeklyDays)}
                        aria-describedby={errors.weeklyDays ? scheduleErrorIds.weeklyDays : undefined}
                        aria-errormessage={errors.weeklyDays ? scheduleErrorIds.weeklyDays : undefined}
                        isSelected={values.weeklyDays.includes(day)}
                        onChange={() => change({
                          weeklyDays: values.weeklyDays.includes(day)
                            ? values.weeklyDays.filter((value) => value !== day)
                            : [...values.weeklyDays, day]
                        })}
                    />
                  ))}
                  <FieldError id={scheduleErrorIds.weeklyDays} message={errors.weeklyDays} />
                </div>
              ) : null}
              {values.recurrenceKind === "monthly" ? (
                <TextField ref={monthlyDayInputRef} label="매월 날짜" inputMode="numeric" description="29~31일이 없는 달에는 해당 실행을 건너뜁니다." isInvalid={Boolean(errors.monthlyDay)} errorMessage={errors.monthlyDay} value={values.monthlyDay} onChange={(value) => change({ monthlyDay: value })} />
              ) : null}
              {values.recurrenceKind === "yearly" ? (
                <div className="grid grid-cols-2 gap-3 max-compact:grid-cols-1">
                  <TextField ref={yearlyMonthInputRef} label="매년 월" inputMode="numeric" isInvalid={Boolean(errors.yearlyMonth)} errorMessage={errors.yearlyMonth} value={values.yearlyMonth} onChange={(value) => change({ yearlyMonth: value })} />
                  <TextField ref={yearlyDayInputRef} label="매년 날짜" inputMode="numeric" isInvalid={Boolean(errors.yearlyDay)} errorMessage={errors.yearlyDay} value={values.yearlyDay} onChange={(value) => change({ yearlyDay: value })} />
                  <Text className="col-span-full" variant="caption" tone="secondary">2월 29일은 윤년에만 실행하며 날짜가 없는 해에는 건너뜁니다.</Text>
                </div>
              ) : null}
              <Checkbox
                  ref={dimmingToggleRef}
                  aria-label="디밍 사용"
                  label={`밝기 직접 지정 ${values.dimmingEnabled ? "ON" : "OFF"}`}
                  isInvalid={!values.dimmingEnabled && Boolean(errors.brightnessPercent)}
                  aria-describedby={!values.dimmingEnabled && errors.brightnessPercent ? scheduleErrorIds.brightnessPercent : undefined}
                  aria-errormessage={!values.dimmingEnabled && errors.brightnessPercent ? scheduleErrorIds.brightnessPercent : undefined}
                  isSelected={values.dimmingEnabled}
                  onChange={(selected) => change({ dimmingEnabled: selected })}
              />
            </AutomationAdvancedSection>

            <AutomationSummaryBar>{scheduleSummary(values, dashboard)}</AutomationSummaryBar>
            {serverError ? <Text tone="danger" role="alert">{serverError}</Text> : null}
            <footer className="flex justify-end gap-2">
              <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>취소</Button>
              <Button variant="primary" type="submit" isLoading={isPending} loadingLabel="저장 중">
                {schedule ? "변경 저장" : "스케줄 만들기"}
              </Button>
            </footer>
          </form>
        )}
    </ModalDialog>
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
  return message ? <span id={id} className="field-error" role="alert">{message}</span> : null;
}

function errorAttributes(error: string | undefined, id: string) {
  return error
    ? { "aria-invalid": true, "aria-describedby": id, "aria-errormessage": id }
    : { "aria-invalid": false };
}
