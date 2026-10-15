import { assertVehicleEventRuleHoldSeconds, parseCreateVehicleEventRuleInput, parseUpdateVehicleEventRuleInput } from "./vehicle-event-rule.dto";

const input = { name: "동일 센서 조명군", status: "disabled", sourceFixtureIds: ["00000000-0000-4000-8000-000000000001"],
  targetFixtureIds: ["00000000-0000-4000-8000-000000000002"], action: { dimmingEnabled: true, brightnessPercent: 70 } };

describe("vehicle event effective hold duration", () => {
  it.each([1, 2, 9, 10, 60, 1800])("preserves a %ss BIO create/PATCH value without coercion", holdSeconds => {
    expect(parseCreateVehicleEventRuleInput({ ...input, holdSeconds }).holdSeconds).toBe(holdSeconds);
    expect(parseUpdateVehicleEventRuleInput({ holdSeconds })).toEqual({ holdSeconds });
    expect(() => assertVehicleEventRuleHoldSeconds(holdSeconds, "bio_usb_pulse")).not.toThrow();
  });
  it.each([0, -1, 1.5, 1801, NaN, "1"])("rejects invalid hold %s before admission", holdSeconds => {
    expect(() => parseCreateVehicleEventRuleInput({ ...input, holdSeconds })).toThrow();
    expect(() => parseUpdateVehicleEventRuleInput({ holdSeconds })).toThrow();
    expect(() => assertVehicleEventRuleHoldSeconds(holdSeconds as number, "bio_usb_pulse")).toThrow();
  });
  it("preserves the default and the effective BlueZ five-second floor", () => {
    expect(parseCreateVehicleEventRuleInput(input).holdSeconds).toBe(60);
    expect(() => assertVehicleEventRuleHoldSeconds(1, "bluez_stateful")).toThrow();
    expect(() => assertVehicleEventRuleHoldSeconds(5, "bluez_stateful")).not.toThrow();
  });
});
