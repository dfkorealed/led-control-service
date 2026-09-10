import type { Dashboard, DashboardFixture } from "../../../api/queries";
import type { ControlSelection } from "../ControlTargetPicker";
import type { ScheduleFormValues } from "./schedule-form";
import type { VehicleEventFormValues } from "./vehicle-event-form";

export type SchedulePreset = "daily" | "weekday" | "weekend" | "once";
export type SchedulePresetState = SchedulePreset | "custom";

export interface AutomationSelectionSummary {
  title: string;
  description: string;
  count: number;
  resolvedCount?: number;
  unresolvedCount?: number;
}

const weekdayDays = [1, 2, 3, 4, 5];
const weekendDays = [6, 7];

export function applySchedulePreset(
  values: ScheduleFormValues,
  preset: SchedulePreset
): Partial<ScheduleFormValues> {
  if (preset === "daily") return { recurrenceKind: "daily", weeklyDays: [] };
  if (preset === "once") return { recurrenceKind: "once", weeklyDays: [] };
  return {
    recurrenceKind: "weekly",
    weeklyDays: preset === "weekday" ? [...weekdayDays] : [...weekendDays]
  };
}

export function schedulePreset(values: ScheduleFormValues): SchedulePresetState {
  if (values.recurrenceKind === "daily") return "daily";
  if (values.recurrenceKind === "once") return "once";
  if (values.recurrenceKind !== "weekly") return "custom";
  if (sameDays(values.weeklyDays, weekdayDays)) return "weekday";
  if (sameDays(values.weeklyDays, weekendDays)) return "weekend";
  return "custom";
}

export function controlSelectionSummary(
  selection: ControlSelection,
  dashboard: Dashboard
): AutomationSelectionSummary {
  if (selection.mode === "floor") {
    const floor = dashboard.floors.find((candidate) => candidate.id === selection.floorId);
    return floor
      ? { title: floor.name, description: `층 전체 · ${floor.fixtures.length}개 조명`, count: floor.fixtures.length }
      : emptySelectionSummary();
  }

  if (selection.mode === "group") {
    const group = dashboard.groups.find((candidate) => candidate.id === selection.groupId);
    return group
      ? { title: group.name, description: `저장된 구역 · ${group.fixtureIds.length}개 조명`, count: group.fixtureIds.length }
      : emptySelectionSummary();
  }

  return fixtureIdsSummary(selection.fixtureIds, dashboard);
}

export function scheduleSummary(values: ScheduleFormValues, dashboard: Dashboard) {
  const target = controlSelectionSummary(values.target, dashboard);
  const period = values.activeFromDate === values.activeUntilDate
    ? `${values.activeFromDate} 하루`
    : `${values.activeFromDate}–${values.activeUntilDate}`;
  const brightness = values.dimmingEnabled ? values.brightnessPercent : "100";
  return `${recurrenceLabel(values)} ${values.localStartTime}–${values.localEndTime} · ${period} · ${target.count > 0 ? target.title : "대상 선택 필요"} · 밝기 ${brightness}%`;
}

export function vehicleEventSummary(values: VehicleEventFormValues, dashboard: Dashboard) {
  const source = fixtureIdsSummary(values.sourceFixtureIds, dashboard, isVehicleEventSource);
  const target = fixtureIdsSummary(values.targetFixtureIds, dashboard);
  const brightness = values.dimmingEnabled ? values.brightnessPercent : "100";
  return `${source.count > 0 ? source.title : "감지 센서 선택 필요"} 감지 → ${target.count > 0 ? target.title : "실행 조명 선택 필요"} · 밝기 ${brightness}% · ${durationLabel(values.holdSeconds)} 유지`;
}

export function fixtureIdsSummary(
  fixtureIds: readonly string[],
  dashboard: Dashboard,
  fixtureFilter?: (fixture: DashboardFixture) => boolean
): AutomationSelectionSummary {
  if (fixtureIds.length === 0) return emptySelectionSummary();

  const requestedIds = [...new Set(fixtureIds)];
  const selected = dashboard.floors.flatMap((floor) => floor.fixtures
    .filter((fixture) => requestedIds.includes(fixture.id) && (!fixtureFilter || fixtureFilter(fixture)))
    .map((fixture) => ({ fixture, floor })));
  const unresolvedCount = requestedIds.length - selected.length;
  if (unresolvedCount > 0) {
    const floorNames = [...new Set(selected.map(({ floor }) => floor.name))];
    return {
      title: selected.length === 0 && requestedIds.length === 1
        ? "1개 조명 · 확인 필요"
        : `${requestedIds.length}개 조명`,
      description: selected.length === 0
        ? `현재 현장에서 확인되지 않는 조명 ${unresolvedCount}개`
        : `${floorNames.join(", ")} · ${selected.length}개 확인 · ${unresolvedCount}개 확인 필요`,
      count: requestedIds.length,
      resolvedCount: selected.length,
      unresolvedCount
    };
  }
  if (requestedIds.length === 1 && selected[0]) {
    return {
      title: selected[0].fixture.name,
      description: `${selected[0].floor.name} · 1개 조명`,
      count: 1
    };
  }

  const floorNames = [...new Set(selected.map(({ floor }) => floor.name))];
  return {
    title: `${requestedIds.length}개 조명`,
    description: floorNames.length > 0 ? `${floorNames.join(", ")} · 개별 선택` : "개별 선택",
    count: requestedIds.length
  };
}

export function fixtureIdsAvailability(
  fixtureIds: readonly string[],
  dashboard: Dashboard,
  fixtureFilter?: (fixture: DashboardFixture) => boolean
) {
  const fixtures = new Map(
    dashboard.floors.flatMap((floor) => floor.fixtures).map((fixture) => [fixture.id, fixture] as const)
  );
  const requestedIds = new Set(fixtureIds);
  const invalidFixtureIds = [...requestedIds].filter((fixtureId) => {
    const fixture = fixtures.get(fixtureId);
    return !fixture || (fixtureFilter ? !fixtureFilter(fixture) : false);
  });
  return {
    requestedCount: requestedIds.size,
    resolvedCount: requestedIds.size - invalidFixtureIds.length,
    invalidFixtureIds
  };
}

export function isVehicleEventSource(fixture: DashboardFixture) {
  const verifiedAt = fixture.vehicleSensorCapabilityVerifiedAt;
  return fixture.gateway !== null
    && fixture.vehicleSensorCapabilityStatus === "supported"
    && typeof verifiedAt === "string"
    && isCanonicalIsoTimestamp(verifiedAt);
}

function recurrenceLabel(values: ScheduleFormValues) {
  const preset = schedulePreset(values);
  if (preset === "daily") return "매일";
  if (preset === "weekday") return "평일";
  if (preset === "weekend") return "주말";
  if (preset === "once") return "한 번";
  if (values.recurrenceKind === "monthly") return `매월 ${values.monthlyDay}일`;
  if (values.recurrenceKind === "yearly") return `매년 ${values.yearlyMonth}월 ${values.yearlyDay}일`;
  return "사용자 지정";
}

function durationLabel(seconds: string) {
  const numericSeconds = Number(seconds);
  if (Number.isInteger(numericSeconds) && numericSeconds > 0 && numericSeconds % 60 === 0) {
    return `${numericSeconds / 60}분`;
  }
  return `${seconds}초`;
}

function emptySelectionSummary(): AutomationSelectionSummary {
  return {
    title: "선택된 조명이 없습니다.",
    description: "대상을 선택해 주세요.",
    count: 0
  };
}

function sameDays(actual: readonly number[], expected: readonly number[]) {
  return actual.length === expected.length
    && [...actual].sort((left, right) => left - right).every((day, index) => day === expected[index]);
}

function isCanonicalIsoTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
