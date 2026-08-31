import type { DimmingTarget } from "@led-control/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import {
  createSchedule,
  createVehicleEventRule,
  deleteSchedule,
  deleteVehicleEventRule,
  listVehicleEventRules,
  listSchedules,
  scheduleMutationErrorMessage,
  scheduleQueryKey,
  vehicleEventRuleQueryKey,
  updateSchedule,
  updateVehicleEventRule,
  type CreateScheduleInput
} from "./automation";

const mocks = vi.hoisted(() => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn()
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  ...mocks
}));

const siteId = "00000000-0000-4000-8000-000000000001";
const scheduleId = "00000000-0000-4000-8000-000000000002";
const target: DimmingTarget = {
  type: "fixture",
  fixtureId: "00000000-0000-4000-8000-000000000003"
};
const input: CreateScheduleInput = {
  name: "평일 운영",
  status: "enabled",
  activeFrom: "2026-09-01T03:00:00.000Z",
  activeUntil: "2026-09-30T03:00:00.000Z",
  localStartTime: "18:00",
  localEndTime: "23:00",
  recurrence: {
    kind: "weekly",
    weeklyDays: [1, 2, 3, 4, 5],
    monthlyDay: null,
    yearlyMonth: null,
    yearlyDay: null
  },
  action: { dimmingEnabled: true, brightnessPercent: 70 },
  target
};

const vehicleEventInput = {
  name: "입구 차량 감지",
  status: "enabled" as const,
  sourceFixtureIds: ["00000000-0000-4000-8000-000000000004"],
  targetFixtureIds: ["00000000-0000-4000-8000-000000000003"],
  action: { dimmingEnabled: true, brightnessPercent: 80 },
  holdSeconds: 60
};

describe("schedule API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGet.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    mocks.apiPost.mockResolvedValue({ id: scheduleId });
    mocks.apiPatch.mockResolvedValue({ id: scheduleId });
    mocks.apiDelete.mockResolvedValue({ id: scheduleId, deleted: true });
  });

  it("keeps the site schedule query key stable", () => {
    expect(scheduleQueryKey(siteId)).toEqual(["automation-schedules", siteId]);
    expect(scheduleQueryKey(siteId)).toEqual(scheduleQueryKey(siteId));
  });

  it("uses the bounded list query contract", async () => {
    await listSchedules(siteId, { limit: 100, cursor: "next/cursor" });

    expect(mocks.apiGet).toHaveBeenCalledWith(
      `/sites/${siteId}/automation/schedules?limit=100&cursor=next%2Fcursor`
    );
  });

  it("uses the production create, patch, and delete routes without reshaping bodies", async () => {
    await createSchedule(siteId, input);
    await updateSchedule(siteId, scheduleId, { status: "disabled" });
    await deleteSchedule(siteId, scheduleId);

    expect(mocks.apiPost).toHaveBeenCalledWith(`/sites/${siteId}/automation/schedules`, input);
    expect(mocks.apiPatch).toHaveBeenCalledWith(
      `/sites/${siteId}/automation/schedules/${scheduleId}`,
      { status: "disabled" }
    );
    expect(mocks.apiDelete).toHaveBeenCalledWith(`/sites/${siteId}/automation/schedules/${scheduleId}`);
  });

  it("uses the production vehicle event CRUD routes and stable query key", async () => {
    await listVehicleEventRules(siteId, { limit: 100, cursor: "next/cursor" });
    await createVehicleEventRule(siteId, vehicleEventInput);
    await updateVehicleEventRule(siteId, scheduleId, { status: "disabled" });
    await deleteVehicleEventRule(siteId, scheduleId);

    expect(vehicleEventRuleQueryKey(siteId)).toEqual(["automation-vehicle-event-rules", siteId]);
    expect(mocks.apiGet).toHaveBeenCalledWith(
      `/sites/${siteId}/automation/vehicle-event-rules?limit=100&cursor=next%2Fcursor`
    );
    expect(mocks.apiPost).toHaveBeenCalledWith(`/sites/${siteId}/automation/vehicle-event-rules`, vehicleEventInput);
    expect(mocks.apiPatch).toHaveBeenCalledWith(
      `/sites/${siteId}/automation/vehicle-event-rules/${scheduleId}`,
      { status: "disabled" }
    );
    expect(mocks.apiDelete).toHaveBeenCalledWith(`/sites/${siteId}/automation/vehicle-event-rules/${scheduleId}`);
  });

  it.each([
    [401, { message: "unauthorized" }, "로그인 세션이 만료되었습니다."],
    [409, { code: "schedule_overlap" }, "같은 대상과 시간대에 겹치는 활성 스케줄이 있습니다."],
    [409, { code: "single_gateway_required" }, "같은 Gateway에 연결된 조명만 선택해 주세요."],
    [400, { message: "invalid automation schedule" }, "스케줄 입력과 대상을 확인해 주세요."],
    [403, { message: "forbidden" }, "스케줄을 변경할 권한이 없습니다."]
  ])("maps API mutation error %s to safe Korean copy", (status, body, expected) => {
    expect(scheduleMutationErrorMessage(new ApiError("failed", status, body))).toBe(expected);
  });

  it("keeps network failures separate from authentication and authorization failures", () => {
    expect(scheduleMutationErrorMessage(new Error("network"))).toBe(
      "스케줄 변경을 완료하지 못했습니다. 연결 상태를 확인해 주세요."
    );
  });
});
