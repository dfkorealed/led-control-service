import { describe, expect, it } from "vitest";
import type { Dashboard } from "../../../api/queries";
import { createEmptyScheduleForm } from "./schedule-form";
import { createEmptyVehicleEventForm } from "./vehicle-event-form";
import {
  applySchedulePreset,
  controlSelectionSummary,
  schedulePreset,
  scheduleSummary,
  vehicleEventSummary
} from "./automation-presenters";

const dashboard: Dashboard = {
  site: {
    id: "site-1",
    name: "테스트 현장",
    customerName: "테스트 고객",
    installationStatus: "installed",
    address: null,
    tariffKwhRate: null,
    timeZone: "Asia/Seoul"
  },
  summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, averageBrightness: 70 },
  floors: [{
    id: "floor-1",
    name: "B1",
    level: -1,
    floorPlan: null,
    meshControlGroups: [],
    fixtures: [
      fixture("sensor-1", "B1-SENSOR", {
        gateway: { id: "gateway-1", name: "B1-GW", connectionStatus: "online" },
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: "2026-08-31T00:00:00.000Z"
      }),
      fixture("light-1", "B1-L001")
    ]
  }],
  groups: [{
    id: "group-1",
    name: "입구 구역",
    floorId: "floor-1",
    gatewayId: null,
    lifecycleStatus: "active",
    fixtureCount: 1,
    meshControlGroup: null,
    fixtureIds: ["light-1"],
  }],
  gateways: []
};

describe("automation quick setup presenters", () => {
  it("maps common schedule presets to the existing recurrence contract", () => {
    const values = createEmptyScheduleForm("Asia/Seoul", new Date("2026-08-31T12:00:00.000Z"));

    expect(applySchedulePreset(values, "weekday")).toMatchObject({
      recurrenceKind: "weekly",
      weeklyDays: [1, 2, 3, 4, 5]
    });
    expect(applySchedulePreset(values, "weekend")).toMatchObject({
      recurrenceKind: "weekly",
      weeklyDays: [6, 7]
    });
    expect(applySchedulePreset(values, "once")).toMatchObject({ recurrenceKind: "once", weeklyDays: [] });
  });

  it("recognizes presets and leaves custom weekly combinations unselected", () => {
    const values = createEmptyScheduleForm("Asia/Seoul");

    expect(schedulePreset(values)).toBe("daily");
    expect(schedulePreset({ ...values, recurrenceKind: "weekly", weeklyDays: [1, 2, 3, 4, 5] })).toBe("weekday");
    expect(schedulePreset({ ...values, recurrenceKind: "weekly", weeklyDays: [2, 4] })).toBe("custom");
  });

  it("summarizes fixture, floor, group, and empty control selections", () => {
    expect(controlSelectionSummary({ mode: "fixtures", fixtureIds: [] }, dashboard)).toEqual({
      title: "선택된 조명이 없습니다.",
      description: "대상을 선택해 주세요.",
      count: 0
    });
    expect(controlSelectionSummary({ mode: "fixtures", fixtureIds: ["light-1"] }, dashboard)).toEqual({
      title: "B1-L001",
      description: "B1 · 1개 조명",
      count: 1
    });
    expect(controlSelectionSummary({ mode: "floor", floorId: "floor-1" }, dashboard)).toMatchObject({
      title: "B1",
      count: 2
    });
    expect(controlSelectionSummary({ mode: "group", groupId: "group-1" }, dashboard)).toMatchObject({
      title: "입구 구역",
      count: 1
    });
  });

  it("distinguishes requested fixture ids from dashboard-resolved fixtures", () => {
    expect(controlSelectionSummary({
      mode: "fixtures",
      fixtureIds: ["light-1", "removed-light"]
    }, dashboard)).toMatchObject({
      title: "2개 조명",
      description: "B1 · 1개 확인 · 1개 확인 필요",
      count: 2,
      resolvedCount: 1,
      unresolvedCount: 1
    });

    expect(controlSelectionSummary({
      mode: "fixtures",
      fixtureIds: ["removed-light"]
    }, dashboard)).toMatchObject({
      title: "1개 조명 · 확인 필요",
      description: "현재 현장에서 확인되지 않는 조명 1개",
      count: 1,
      resolvedCount: 0,
      unresolvedCount: 1
    });
  });

  it("builds schedule and event summaries from literal selections", () => {
    const scheduleValues = {
      ...createEmptyScheduleForm("Asia/Seoul", new Date("2026-08-31T12:00:00.000Z")),
      target: { mode: "fixtures" as const, fixtureIds: ["light-1"] }
    };
    const eventValues = {
      ...createEmptyVehicleEventForm(),
      sourceFixtureIds: ["sensor-1"],
      targetFixtureIds: ["light-1"]
    };

    expect(scheduleSummary(scheduleValues, dashboard))
      .toBe("매일 18:00–23:00 · 2026-08-31 하루 · B1-L001 · 밝기 70%");
    expect(vehicleEventSummary(eventValues, dashboard))
      .toBe("B1-SENSOR 감지 → B1-L001 · 밝기 70% · 1분 유지");
  });

  it("marks a resolved source fixture as needing confirmation when its sensor capability is revoked", () => {
    const eventValues = {
      ...createEmptyVehicleEventForm(),
      sourceFixtureIds: ["sensor-1"],
      targetFixtureIds: ["light-1"]
    };
    const revokedDashboard: Dashboard = {
      ...dashboard,
      floors: [{
        ...dashboard.floors[0],
        fixtures: dashboard.floors[0].fixtures.map((candidate) => candidate.id === "sensor-1"
          ? { ...candidate, vehicleSensorCapabilityStatus: "unsupported", vehicleSensorCapabilityVerifiedAt: null }
          : candidate)
      }]
    };

    expect(vehicleEventSummary(eventValues, revokedDashboard))
      .toBe("1개 조명 · 확인 필요 감지 → B1-L001 · 밝기 70% · 1분 유지");
  });
});

function fixture(
  id: string,
  name: string,
  overrides: Partial<Dashboard["floors"][number]["fixtures"][number]> = {}
): Dashboard["floors"][number]["fixtures"][number] {
  return {
    id,
    name,
    x: 0,
    y: 0,
    ratedWatt: 40,
    brightness: 70,
    status: "online",
    health: null,
    rssi: null,
    hopCount: null,
    commandSuccessRate: null,
    lastSeenAt: null,
    gateway: null,
    controllable: true,
    controlBlockReason: null,
    ...overrides
  };
}
