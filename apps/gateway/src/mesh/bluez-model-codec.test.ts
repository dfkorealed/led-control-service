import { describe, expect, it } from "vitest";
import {
  decodeGenericOnOffStatus,
  decodeHealthStatus,
  decodeLightnessStatus,
  encodeGenericOnOffSet,
  encodeLightnessSet,
  encodeLightnessSetUnacknowledged,
  percentToLightness
} from "./bluez-model-codec";
import {
  TEST_BLUETOOTH_COMPANY_ID,
  TEST_BLUETOOTH_COMPANY_ID_LE
} from "../test-fixtures/vehicle-sensor-protocol";

describe("BlueZ SIG model codec", () => {
  it("encodes acknowledged Light Lightness Set in little endian", () => {
    expect(encodeLightnessSet({ lightness: 32768, tid: 7 })).toEqual(Buffer.from([0x82, 0x4c, 0x00, 0x80, 0x07]));
  });

  it("encodes unacknowledged Light Lightness Set in little endian", () => {
    expect(encodeLightnessSetUnacknowledged(0xffff, 7)).toEqual(Buffer.from([0x82, 0x4d, 0xff, 0xff, 0x07]));
  });

  it("encodes acknowledged Generic OnOff Set", () => {
    expect(encodeGenericOnOffSet({ on: true, tid: 9 })).toEqual(Buffer.from([0x82, 0x02, 0x01, 0x09]));
  });

  it("decodes present and target lightness status", () => {
    expect(decodeLightnessStatus(Buffer.from([0x82, 0x4e, 0x00, 0x80]))).toEqual({ present: 32768 });
    expect(decodeLightnessStatus(Buffer.from([0x82, 0x4e, 0x00, 0x40, 0xff, 0xff, 0x05]))).toEqual({
      present: 16384,
      target: 65535,
      remainingTime: 5
    });
  });

  it("decodes Generic OnOff and Health Current/Fault status publications", () => {
    expect(decodeGenericOnOffStatus(Buffer.from([0x82, 0x04, 0x01]))).toEqual({ present: true });
    expect(decodeGenericOnOffStatus(Buffer.from([0x82, 0x04, 0x00, 0x01, 0x05]))).toEqual({
      present: false,
      target: true,
      remainingTime: 5
    });
    expect(decodeHealthStatus(Buffer.from([0x04, 0x01, ...TEST_BLUETOOTH_COMPANY_ID_LE, 0x00]))).toEqual({
      kind: "current",
      testId: 1,
      companyId: TEST_BLUETOOTH_COMPANY_ID,
      faults: []
    });
    expect(decodeHealthStatus(Buffer.from([0x05, 0x01, ...TEST_BLUETOOTH_COMPANY_ID_LE, 0x01, 0x02]))).toEqual({
      kind: "registered",
      testId: 1,
      companyId: TEST_BLUETOOTH_COMPANY_ID,
      faults: [1, 2]
    });
  });

  it("maps brightness percent to the full 16-bit lightness range", () => {
    expect(percentToLightness(0)).toBe(0);
    expect(percentToLightness(50)).toBe(32768);
    expect(percentToLightness(100)).toBe(65535);
  });
});
