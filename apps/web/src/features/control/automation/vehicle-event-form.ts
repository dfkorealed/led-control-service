import type { AutomationRuleStatus } from "@led-control/shared";
import type { CreateVehicleEventRuleInput } from "../../../api/automation";

export interface VehicleEventFormValues {
  name: string;
  sourceFixtureIds: string[];
  targetFixtureIds: string[];
  dimmingEnabled: boolean;
  brightnessPercent: string;
  holdSeconds: string;
}

export type VehicleEventFormErrors = Partial<Record<keyof VehicleEventFormValues, string>>;

export function createEmptyVehicleEventForm(): VehicleEventFormValues {
  return {
    name: "차량 감지 제어",
    sourceFixtureIds: [],
    targetFixtureIds: [],
    dimmingEnabled: true,
    brightnessPercent: "70",
    holdSeconds: "60"
  };
}

export function validateVehicleEventForm(values: VehicleEventFormValues): VehicleEventFormErrors {
  const errors: VehicleEventFormErrors = {};
  if (!values.name.trim()) errors.name = "규칙 이름을 입력해 주세요.";
  if (values.sourceFixtureIds.length === 0) errors.sourceFixtureIds = "감지 센서를 한 개 이상 선택하세요.";
  if (values.targetFixtureIds.length === 0) errors.targetFixtureIds = "제어 조명을 한 개 이상 선택하세요.";
  if (!integerInRange(values.brightnessPercent, 0, 100)) {
    errors.brightnessPercent = "밝기는 0~100 사이의 정수여야 합니다.";
  }
  if (!integerInRange(values.holdSeconds, 5, 1_800)) {
    errors.holdSeconds = "유지 시간은 5~1,800초 사이의 정수여야 합니다.";
  }
  return errors;
}

export function vehicleEventFormToInput(
  values: VehicleEventFormValues,
  status: AutomationRuleStatus
): CreateVehicleEventRuleInput {
  const errors = validateVehicleEventForm(values);
  if (Object.keys(errors).length > 0) throw new Error("invalid vehicle event form");
  return {
    name: values.name.trim(),
    status,
    sourceFixtureIds: uniqueSorted(values.sourceFixtureIds),
    targetFixtureIds: uniqueSorted(values.targetFixtureIds),
    action: {
      dimmingEnabled: values.dimmingEnabled,
      brightnessPercent: values.dimmingEnabled ? Number(values.brightnessPercent) : 100
    },
    holdSeconds: Number(values.holdSeconds)
  };
}

export function vehicleEventRuleToFormValues(input: CreateVehicleEventRuleInput): VehicleEventFormValues {
  return {
    name: input.name,
    sourceFixtureIds: [...input.sourceFixtureIds],
    targetFixtureIds: [...input.targetFixtureIds],
    dimmingEnabled: input.action.dimmingEnabled,
    brightnessPercent: input.action.brightnessPercent.toString(),
    holdSeconds: input.holdSeconds.toString()
  };
}

function integerInRange(value: string, minimum: number, maximum: number) {
  if (!/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}
