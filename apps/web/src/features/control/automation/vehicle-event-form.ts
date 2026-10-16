import type { AutomationRuleStatus, VehicleSensorProtocol } from "@led-control/shared";
import type { CreateVehicleEventRuleInput } from "../../../api/automation";

export interface VehicleEventFormValues {
  name: string;
  sourceFixtureIds: string[];
  targetFixtureIds: string[];
  dimmingEnabled: boolean;
  brightnessPercent: string;
  holdSeconds: string;
  selfControlEnabled?: boolean;
}

export type VehicleEventFormErrors = Partial<Record<keyof VehicleEventFormValues, string>>;

export function createEmptyVehicleEventForm(): VehicleEventFormValues {
  return {
    name: "차량 감지 제어",
    sourceFixtureIds: [],
    targetFixtureIds: [],
    dimmingEnabled: true,
    brightnessPercent: "70",
    holdSeconds: "60",
    selfControlEnabled: true
  };
}

export function validateVehicleEventForm(values: VehicleEventFormValues, sourceProtocol: VehicleSensorProtocol = "bluez-stateful"): VehicleEventFormErrors {
  const errors: VehicleEventFormErrors = {};
  const self = sourceProtocol === "bio-usb-pulse" && values.selfControlEnabled === true;
  if (!values.name.trim()) errors.name = "규칙 이름을 입력해 주세요.";
  if (values.sourceFixtureIds.length === 0) errors.sourceFixtureIds = "감지 센서를 한 개 이상 선택하세요.";
  if (self && values.sourceFixtureIds.length !== 1) errors.sourceFixtureIds = "감지 조명을 한 개 선택해 주세요.";
  if (!self && values.targetFixtureIds.length === 0) errors.targetFixtureIds = "제어 조명을 한 개 이상 선택하세요.";
  if (values.dimmingEnabled && !integerInRange(values.brightnessPercent, self ? 1 : 0, 100)) {
    errors.brightnessPercent = self ? "자기 감지 밝기는 1~100 사이의 정수여야 합니다." : "밝기는 0~100 사이의 정수여야 합니다.";
  }
  const minimumHold = sourceProtocol === "bio-usb-pulse" ? 1 : 5;
  if (!integerInRange(values.holdSeconds, minimumHold, 1_800)) {
    errors.holdSeconds = `유지 시간은 ${minimumHold}~1,800초 사이의 정수여야 합니다.`;
  } else if (self && Number(values.holdSeconds) > 127 && Number(values.holdSeconds) % 60 !== 0) {
    errors.holdSeconds = "자기 감지는 1~127초 또는 그 이상은 60초 단위로 설정해 주세요.";
  }
  return errors;
}

export function vehicleEventFormToInput(
  values: VehicleEventFormValues,
  status: AutomationRuleStatus,
  sourceProtocol: VehicleSensorProtocol = "bluez-stateful"
): CreateVehicleEventRuleInput {
  const errors = validateVehicleEventForm(values, sourceProtocol);
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
    holdSeconds: Number(values.holdSeconds),
    ...(sourceProtocol === "bio-usb-pulse" ? { selfControlEnabled: values.selfControlEnabled === true } : {})
  };
}

export function vehicleEventRuleToFormValues(input: CreateVehicleEventRuleInput): VehicleEventFormValues {
  return {
    name: input.name,
    sourceFixtureIds: [...input.sourceFixtureIds],
    targetFixtureIds: [...input.targetFixtureIds],
    dimmingEnabled: input.action.dimmingEnabled,
    brightnessPercent: input.action.brightnessPercent.toString(),
    holdSeconds: input.holdSeconds.toString(),
    selfControlEnabled: input.selfControlEnabled ?? false
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
