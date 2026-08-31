import { describe, expect, it } from "vitest";
import {
  createEmptyVehicleEventForm,
  validateVehicleEventForm,
  vehicleEventFormToInput,
  type VehicleEventFormValues
} from "./vehicle-event-form";

const sourceFixtureId = "00000000-0000-4000-8000-000000000003";
const targetFixtureId = "00000000-0000-4000-8000-000000000004";

function validForm(overrides: Partial<VehicleEventFormValues> = {}): VehicleEventFormValues {
  return {
    ...createEmptyVehicleEventForm(),
    name: "입구 차량 감지",
    sourceFixtureIds: [sourceFixtureId],
    targetFixtureIds: [targetFixtureId],
    brightnessPercent: "80",
    holdSeconds: "60",
    ...overrides
  };
}

describe("vehicle event form", () => {
  it("requires source sensors, target lights, valid brightness, and a bounded hold", () => {
    expect(validateVehicleEventForm(validForm({ sourceFixtureIds: [], targetFixtureIds: [] }))).toMatchObject({
      sourceFixtureIds: "감지 센서를 한 개 이상 선택하세요.",
      targetFixtureIds: "제어 조명을 한 개 이상 선택하세요."
    });
    expect(validateVehicleEventForm(validForm({ brightnessPercent: "101", holdSeconds: "4" }))).toMatchObject({
      brightnessPercent: "밝기는 0~100 사이의 정수여야 합니다.",
      holdSeconds: "유지 시간은 5~1,800초 사이의 정수여야 합니다."
    });
  });

  it("canonicalizes fixture memberships and emits the event DTO contract", () => {
    const input = vehicleEventFormToInput(validForm({
      sourceFixtureIds: [sourceFixtureId, "00000000-0000-4000-8000-000000000001"],
      targetFixtureIds: [targetFixtureId, "00000000-0000-4000-8000-000000000002"],
      dimmingEnabled: false,
      brightnessPercent: "30"
    }), "enabled");

    expect(input).toEqual({
      name: "입구 차량 감지",
      status: "enabled",
      sourceFixtureIds: ["00000000-0000-4000-8000-000000000001", sourceFixtureId],
      targetFixtureIds: ["00000000-0000-4000-8000-000000000002", targetFixtureId],
      action: { dimmingEnabled: false, brightnessPercent: 100 },
      holdSeconds: 60
    });
  });
});
