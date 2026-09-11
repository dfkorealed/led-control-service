import { describe, expect, it } from "vitest";
import {
  createEmptyScheduleForm,
  scheduleFormToInput,
  scheduleToFormValues,
  validateScheduleForm,
  type ScheduleFormValues
} from "./schedule-form";

const fixtureId = "00000000-0000-4000-8000-000000000003";

function validForm(overrides: Partial<ScheduleFormValues> = {}): ScheduleFormValues {
  return {
    ...createEmptyScheduleForm("Asia/Seoul", new Date("2026-08-31T12:00:00.000Z")),
    name: "평일 운영",
    activeFromDate: "2026-09-01",
    activeUntilDate: "2026-09-30",
    localStartTime: "18:00",
    localEndTime: "23:00",
    recurrenceKind: "daily",
    brightnessPercent: "70",
    target: { mode: "fixtures", fixtureIds: [fixtureId] },
    ...overrides
  };
}

describe("schedule form validation", () => {
  it("새 스케줄은 고급 설정을 열지 않아도 저장 가능한 기본 이름을 갖는다", () => {
    expect(createEmptyScheduleForm("Asia/Seoul", new Date("2026-08-31T12:00:00.000Z")).name)
      .toBe("조명 스케줄");
  });

  it("requires a valid date period and one non-zero time segment", () => {
    expect(validateScheduleForm(validForm({ activeFromDate: "" }))).toMatchObject({
      activeFromDate: "적용 시작일을 선택해 주세요."
    });
    expect(validateScheduleForm(validForm({ activeUntilDate: "2026-08-31" }))).toMatchObject({
      activeUntilDate: "종료일은 시작일보다 빠를 수 없습니다."
    });
    expect(validateScheduleForm(validForm({ localEndTime: "18:00" }))).toMatchObject({
      localEndTime: "시작 시각과 종료 시각은 달라야 합니다."
    });
  });

  it("requires recurrence-specific weekly, monthly, and yearly values", () => {
    expect(validateScheduleForm(validForm({ recurrenceKind: "weekly", weeklyDays: [] }))).toMatchObject({
      weeklyDays: "요일을 하나 이상 선택해 주세요."
    });
    expect(validateScheduleForm(validForm({ recurrenceKind: "monthly", monthlyDay: "" }))).toMatchObject({
      monthlyDay: "반복할 날짜를 입력해 주세요."
    });
    expect(validateScheduleForm(validForm({ recurrenceKind: "yearly", yearlyMonth: "", yearlyDay: "" }))).toMatchObject({
      yearlyMonth: "반복할 월을 입력해 주세요.",
      yearlyDay: "반복할 날짜를 입력해 주세요."
    });
  });

  it("accepts monthly day 31 and yearly February 29", () => {
    expect(validateScheduleForm(validForm({ recurrenceKind: "monthly", monthlyDay: "31" }))).toEqual({});
    expect(validateScheduleForm(validForm({
      recurrenceKind: "yearly",
      yearlyMonth: "2",
      yearlyDay: "29"
    }))).toEqual({});
  });

  it("rejects yearly month and day combinations that never occur", () => {
    expect(validateScheduleForm(validForm({
      recurrenceKind: "yearly",
      yearlyMonth: "4",
      yearlyDay: "31"
    }))).toMatchObject({
      yearlyDay: "해당 월에 존재하는 날짜를 입력해 주세요."
    });
    expect(validateScheduleForm(validForm({
      recurrenceKind: "yearly",
      yearlyMonth: "2",
      yearlyDay: "30"
    }))).toMatchObject({
      yearlyDay: "해당 월에 존재하는 날짜를 입력해 주세요."
    });
  });

  it("requires an integer brightness from 0 through 100 and at least one target", () => {
    expect(validateScheduleForm(validForm({ brightnessPercent: "101" }))).toMatchObject({
      brightnessPercent: "밝기는 0~100 사이의 정수여야 합니다."
    });
    expect(validateScheduleForm(validForm({ brightnessPercent: "10.5" }))).toMatchObject({
      brightnessPercent: "밝기는 0~100 사이의 정수여야 합니다."
    });
    expect(validateScheduleForm(validForm({ target: { mode: "fixtures", fixtureIds: [] } }))).toMatchObject({
      target: "제어 대상을 하나 이상 선택해 주세요."
    });
  });
});

describe("schedule form DTO conversion", () => {
  it("encodes site calendar dates as ISO instants without using the browser time zone", () => {
    const input = scheduleFormToInput(validForm({
      recurrenceKind: "weekly",
      weeklyDays: [5, 1, 3]
    }), "Asia/Seoul", "enabled");

    expect(input).toMatchObject({
      activeFrom: "2026-09-01T03:00:00.000Z",
      activeUntil: "2026-09-30T03:00:00.000Z",
      recurrence: {
        kind: "weekly",
        weeklyDays: [1, 3, 5],
        monthlyDay: null,
        yearlyMonth: null,
        yearlyDay: null
      },
      action: { dimmingEnabled: true, brightnessPercent: 70 },
      target: { type: "fixture", fixtureId }
    });
  });

  it("sends dimming off as 100 percent and clears unrelated recurrence fields", () => {
    const input = scheduleFormToInput(validForm({
      recurrenceKind: "monthly",
      monthlyDay: "31",
      weeklyDays: [1],
      yearlyMonth: "2",
      yearlyDay: "29",
      dimmingEnabled: false,
      brightnessPercent: "20"
    }), "Asia/Seoul", "disabled");

    expect(input.status).toBe("disabled");
    expect(input.recurrence).toEqual({
      kind: "monthly",
      weeklyDays: [],
      monthlyDay: 31,
      yearlyMonth: null,
      yearlyDay: null
    });
    expect(input.action).toEqual({ dimmingEnabled: false, brightnessPercent: 100 });
  });

  it("canonicalizes a direct multi-fixture target", () => {
    const secondFixtureId = "00000000-0000-4000-8000-000000000002";
    const input = scheduleFormToInput(validForm({
      target: { mode: "fixtures", fixtureIds: [fixtureId, secondFixtureId] }
    }), "Asia/Seoul", "enabled");

    expect(input.target).toEqual({
      type: "fixtures",
      fixtureIds: [secondFixtureId, fixtureId]
    });
  });

  it("restores API instants as dates in the site time zone", () => {
    const values = scheduleToFormValues({
      id: "00000000-0000-4000-8000-000000000002",
      name: "야간 운영",
      status: "enabled",
      activeFrom: "2026-09-01T03:00:00.000Z",
      activeUntil: "2026-09-30T03:00:00.000Z",
      localStartTime: "23:00",
      localEndTime: "05:00",
      recurrence: {
        kind: "yearly",
        weeklyDays: [],
        monthlyDay: null,
        yearlyMonth: 2,
        yearlyDay: 29
      },
      action: { dimmingEnabled: true, brightnessPercent: 30 },
      fixtureIds: [fixtureId]
    }, "Asia/Seoul");

    expect(values).toMatchObject({
      activeFromDate: "2026-09-01",
      activeUntilDate: "2026-09-30",
      recurrenceKind: "yearly",
      yearlyMonth: "2",
      yearlyDay: "29",
      target: { mode: "fixtures", fixtureIds: [fixtureId] }
    });
  });
});
