import type { BioSelfSensorConfigurationObservation } from "./bio-dongle-client";
import { BioUsbError } from "./bio-usb-error";

export interface BioSelfSensorConfiguration {
  highBrightnessPercent: number;
  standbyBrightnessPercent: number;
  holdSeconds: number;
}

export function encodeExactBioHoldInterval(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) unsupported();
  if (seconds <= 127) return seconds << 1;
  if (seconds % 60 !== 0) unsupported();
  return ((seconds / 60) << 1) | 1;
}

/** Validate raw originals independently of the narrower new-user UI range. */
export function assertRestorableSelfSensorConfiguration(value: BioSelfSensorConfigurationObservation): void {
  if (!value || !integer(value.highBrightnessPercent, 1, 100) || !integer(value.standbyBrightnessPercent, 0, 100)
    || ![0, 1].includes(value.delayMode) || !["sensor", "force-on", "force-off"].includes(value.bioMode)
    || !integer(value.rawHoldInterval, 0, 255) || !integer(value.rawStandbyInterval, 0, 255)
    || value.holdSeconds !== decodeInterval(value.rawHoldInterval)
    || value.standbySeconds !== decodeInterval(value.rawStandbyInterval)) unsupported();
}

export function buildSelfSensorConfiguration(
  original: BioSelfSensorConfigurationObservation, desired: BioSelfSensorConfiguration
): BioSelfSensorConfigurationObservation {
  assertRestorableSelfSensorConfiguration(original);
  // Do not convert an unknown phase into a guessed single-stage behavior. This
  // low-level operation preserves observed phase0; optical semantics/1s support
  // still require qualification before a production rule may call it.
  if (original.delayMode !== 0 || !integer(desired.highBrightnessPercent, 1, 100)
    || !integer(desired.standbyBrightnessPercent, 0, 100)) unsupported();
  return { ...original, highBrightnessPercent: desired.highBrightnessPercent, standbyBrightnessPercent: desired.standbyBrightnessPercent,
    holdSeconds: desired.holdSeconds, rawHoldInterval: encodeExactBioHoldInterval(desired.holdSeconds), bioMode: "sensor" };
}

export function sameSelfSensorConfiguration(a: BioSelfSensorConfigurationObservation, b: BioSelfSensorConfigurationObservation): boolean {
  return a.highBrightnessPercent === b.highBrightnessPercent && a.standbyBrightnessPercent === b.standbyBrightnessPercent
    && a.holdSeconds === b.holdSeconds && a.standbySeconds === b.standbySeconds && a.delayMode === b.delayMode
    && a.bioMode === b.bioMode && a.rawHoldInterval === b.rawHoldInterval && a.rawStandbyInterval === b.rawStandbyInterval;
}

function decodeInterval(raw: number) { return (raw >>> 1) * ((raw & 1) ? 60 : 1); }
function integer(value: number, min: number, max: number) { return Number.isInteger(value) && value >= min && value <= max; }
function unsupported(): never {
  throw new BioUsbError("BIO_SELF_CONFIGURATION_UNSUPPORTED", "BIO self-sensor configuration cannot be represented or restored exactly");
}
