import { describe, expect, it } from "vitest";
import {
  createEmptyVehicleEventForm,
  validateVehicleEventForm,
  vehicleEventFormToInput,
  vehicleEventRuleToFormValues,
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
  it.each([["0", false], ["1", true], ["2", true], ["9", true], ["1.5", false], ["10", true], ["60", true], ["1800", true], ["1801", false]] as const)("validates BIO hold %s without changing BlueZ bounds", (holdSeconds, valid) => {
    expect(Boolean(validateVehicleEventForm(validForm({ holdSeconds }), "bio-usb-pulse").holdSeconds)).toBe(!valid);
    expect(validateVehicleEventForm(validForm({ holdSeconds: "5" }), "bluez-stateful")).toEqual({});
  });

  it("preserves an edited BIO hold and never submits server capability fields", () => {
    expect(createEmptyVehicleEventForm().holdSeconds).toBe("60");
    const input = vehicleEventFormToInput(validForm({ holdSeconds: "10" }), "disabled", "bio-usb-pulse");
    expect(vehicleEventRuleToFormValues(input).holdSeconds).toBe("10");
    expect(input).not.toHaveProperty("sensorProtocol");
    expect(input).not.toHaveProperty("readiness");
    expect(() => vehicleEventFormToInput(validForm({ holdSeconds: "0" }), "disabled", "bio-usb-pulse")).toThrow();
    expect(() => vehicleEventFormToInput(validForm({ holdSeconds: "1" }), "disabled", "bluez-stateful")).toThrow();
  });
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

  it("ignores a stale brightness value and normalizes to 100 when dimming is off", () => {
    const values = validForm({ dimmingEnabled: false, brightnessPercent: "101" });

    expect(validateVehicleEventForm(values)).not.toHaveProperty("brightnessPercent");
    expect(vehicleEventFormToInput(values, "enabled").action).toEqual({
      dimmingEnabled: false,
      brightnessPercent: 100
    });
  });

  it("reloads persisted event fixture-id snapshots without adding selection-mode fields", () => {
    const values = vehicleEventRuleToFormValues({
      ...vehicleEventFormToInput(validForm(), "enabled"),
      sourceFixtureIds: [sourceFixtureId],
      targetFixtureIds: [targetFixtureId, "00000000-0000-4000-8000-000000000002"]
    });

    expect(values).toMatchObject({
      sourceFixtureIds: [sourceFixtureId],
      targetFixtureIds: [targetFixtureId, "00000000-0000-4000-8000-000000000002"]
    });
  });
});
