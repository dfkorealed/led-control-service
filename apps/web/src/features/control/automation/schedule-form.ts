import type {
  AutomationRuleStatus,
  LightingScheduleSnapshotV1,
  ScheduleRecurrenceKind,
  ScheduleRecurrenceV1
} from "@led-control/shared";
import type { CreateScheduleInput } from "../../../api/automation";
import {
  controlSelectionToDimmingTarget,
  type ControlSelection
} from "../ControlTargetPicker";

export interface ScheduleFormValues {
  name: string;
  activeFromDate: string;
  activeUntilDate: string;
  localStartTime: string;
  localEndTime: string;
  recurrenceKind: ScheduleRecurrenceKind;
  weeklyDays: number[];
  monthlyDay: string;
  yearlyMonth: string;
  yearlyDay: string;
  dimmingEnabled: boolean;
  brightnessPercent: string;
  target: ControlSelection;
}

export type ScheduleFormErrors = Partial<Record<
  | "name"
  | "activeFromDate"
  | "activeUntilDate"
  | "localStartTime"
  | "localEndTime"
  | "weeklyDays"
  | "monthlyDay"
  | "yearlyMonth"
  | "yearlyDay"
  | "brightnessPercent"
  | "target",
  string
>>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function createEmptyScheduleForm(timeZone: string, now = new Date()): ScheduleFormValues {
  const today = dateInTimeZone(now.toISOString(), timeZone);
  return {
    name: "",
    activeFromDate: today,
    activeUntilDate: today,
    localStartTime: "18:00",
    localEndTime: "23:00",
    recurrenceKind: "daily",
    weeklyDays: [],
    monthlyDay: "1",
    yearlyMonth: "1",
    yearlyDay: "1",
    dimmingEnabled: true,
    brightnessPercent: "70",
    target: { mode: "fixtures", fixtureIds: [] }
  };
}

export function scheduleToFormValues(
  schedule: LightingScheduleSnapshotV1,
  timeZone: string
): ScheduleFormValues {
  return {
    name: schedule.name,
    activeFromDate: dateInTimeZone(schedule.activeFrom, timeZone),
    activeUntilDate: dateInTimeZone(schedule.activeUntil, timeZone),
    localStartTime: schedule.localStartTime,
    localEndTime: schedule.localEndTime,
    recurrenceKind: schedule.recurrence.kind,
    weeklyDays: [...schedule.recurrence.weeklyDays],
    monthlyDay: schedule.recurrence.monthlyDay?.toString() ?? "",
    yearlyMonth: schedule.recurrence.yearlyMonth?.toString() ?? "",
    yearlyDay: schedule.recurrence.yearlyDay?.toString() ?? "",
    dimmingEnabled: schedule.action.dimmingEnabled,
    brightnessPercent: schedule.action.brightnessPercent.toString(),
    target: { mode: "fixtures", fixtureIds: [...schedule.fixtureIds] }
  };
}

export function validateScheduleForm(values: ScheduleFormValues): ScheduleFormErrors {
  const errors: ScheduleFormErrors = {};
  if (!values.name.trim()) errors.name = "스케줄 이름을 입력해 주세요.";

  if (!isCalendarDate(values.activeFromDate)) {
    errors.activeFromDate = "적용 시작일을 선택해 주세요.";
  }
  if (!isCalendarDate(values.activeUntilDate)) {
    errors.activeUntilDate = "적용 종료일을 선택해 주세요.";
  } else if (!errors.activeFromDate && values.activeUntilDate < values.activeFromDate) {
    errors.activeUntilDate = "종료일은 시작일보다 빠를 수 없습니다.";
  }

  if (!TIME_PATTERN.test(values.localStartTime)) {
    errors.localStartTime = "시작 시각을 선택해 주세요.";
  }
  if (!TIME_PATTERN.test(values.localEndTime)) {
    errors.localEndTime = "종료 시각을 선택해 주세요.";
  } else if (!errors.localStartTime && values.localStartTime === values.localEndTime) {
    errors.localEndTime = "시작 시각과 종료 시각은 달라야 합니다.";
  }

  if (values.recurrenceKind === "weekly" && values.weeklyDays.length === 0) {
    errors.weeklyDays = "요일을 하나 이상 선택해 주세요.";
  }
  if (values.recurrenceKind === "monthly" && !integerInRange(values.monthlyDay, 1, 31)) {
    errors.monthlyDay = values.monthlyDay
      ? "날짜는 1~31 사이의 정수여야 합니다."
      : "반복할 날짜를 입력해 주세요.";
  }
  if (values.recurrenceKind === "yearly") {
    const validMonth = integerInRange(values.yearlyMonth, 1, 12);
    const validDay = integerInRange(values.yearlyDay, 1, 31);
    if (!validMonth) {
      errors.yearlyMonth = values.yearlyMonth
        ? "월은 1~12 사이의 정수여야 합니다."
        : "반복할 월을 입력해 주세요.";
    }
    if (!validDay) {
      errors.yearlyDay = values.yearlyDay
        ? "날짜는 1~31 사이의 정수여야 합니다."
        : "반복할 날짜를 입력해 주세요.";
    } else if (validMonth && !isValidYearlyDate(Number(values.yearlyMonth), Number(values.yearlyDay))) {
      errors.yearlyDay = "해당 월에 존재하는 날짜를 입력해 주세요.";
    }
  }

  if (!integerInRange(values.brightnessPercent, 0, 100)) {
    errors.brightnessPercent = "밝기는 0~100 사이의 정수여야 합니다.";
  }

  const target = controlSelectionToDimmingTarget(values.target);
  if (!target) {
    errors.target = "제어 대상을 하나 이상 선택해 주세요.";
  } else if (target.type === "fixtures" && target.fixtureIds.length > 1000) {
    errors.target = "개별 조명은 최대 1,000개까지 선택할 수 있습니다.";
  }
  return errors;
}

export function scheduleFormToInput(
  values: ScheduleFormValues,
  timeZone: string,
  status: AutomationRuleStatus
): CreateScheduleInput {
  const errors = validateScheduleForm(values);
  if (Object.keys(errors).length > 0) throw new Error("invalid schedule form");
  const target = controlSelectionToDimmingTarget(values.target);
  if (!target) throw new Error("schedule target is required");

  return {
    name: values.name.trim(),
    status,
    activeFrom: siteCalendarDateToIso(values.activeFromDate, timeZone),
    activeUntil: siteCalendarDateToIso(values.activeUntilDate, timeZone),
    localStartTime: values.localStartTime,
    localEndTime: values.localEndTime,
    recurrence: recurrenceFromForm(values),
    action: {
      dimmingEnabled: values.dimmingEnabled,
      brightnessPercent: values.dimmingEnabled ? Number(values.brightnessPercent) : 100
    },
    target: target.type === "fixtures"
      ? { ...target, fixtureIds: [...target.fixtureIds].sort() }
      : target
  };
}

function recurrenceFromForm(values: ScheduleFormValues): ScheduleRecurrenceV1 {
  return {
    kind: values.recurrenceKind,
    weeklyDays: values.recurrenceKind === "weekly"
      ? [...new Set(values.weeklyDays)].sort((left, right) => left - right)
      : [],
    monthlyDay: values.recurrenceKind === "monthly" ? Number(values.monthlyDay) : null,
    yearlyMonth: values.recurrenceKind === "yearly" ? Number(values.yearlyMonth) : null,
    yearlyDay: values.recurrenceKind === "yearly" ? Number(values.yearlyDay) : null
  };
}

function isCalendarDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function integerInRange(value: string, minimum: number, maximum: number) {
  if (!/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum;
}

function isValidYearlyDate(month: number, day: number) {
  // Leap year 2000 keeps February 29 valid while rejecting dates that never occur.
  const date = new Date(Date.UTC(2000, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateInTimeZone(isoInstant: string, timeZone: string) {
  const parts = dateTimeParts(new Date(isoInstant), timeZone);
  return `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)}`;
}

function siteCalendarDateToIso(calendarDate: string, timeZone: string) {
  const [year, month, day] = calendarDate.split("-").map(Number);
  const desired = { year, month, day, hour: 12, minute: 0, second: 0 };
  let epochMs = Date.UTC(year, month - 1, day, 12, 0, 0);

  // The API stores an instant but recurrence is bounded by the Site's calendar date.
  // Resolve local noon iteratively to avoid browser-local conversion and DST midnight edges.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = dateTimeParts(new Date(epochMs), timeZone);
    const difference = Date.UTC(
      desired.year,
      desired.month - 1,
      desired.day,
      desired.hour,
      desired.minute,
      desired.second
    ) - Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    if (difference === 0) break;
    epochMs += difference;
  }

  const resolved = dateTimeParts(new Date(epochMs), timeZone);
  if (resolved.year !== year || resolved.month !== month || resolved.day !== day || resolved.hour !== 12) {
    throw new Error("site calendar date cannot be represented in the selected time zone");
  }
  return new Date(epochMs).toISOString();
}

function dateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}
