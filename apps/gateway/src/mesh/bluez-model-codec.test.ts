import { describe, expect, it } from "vitest";
import { decodeLightnessStatus, encodeGenericOnOffSet, encodeLightnessSet, percentToLightness } from "./bluez-model-codec";

describe("BlueZ SIG model codec", () => {
  it("encodes acknowledged Light Lightness Set in little endian", () => {
    expect(encodeLightnessSet({ lightness: 32768, tid: 7 })).toEqual(Buffer.from([0x82, 0x4c, 0x00, 0x80, 0x07]));
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

  it("maps brightness percent to the full 16-bit lightness range", () => {
    expect(percentToLightness(0)).toBe(0);
    expect(percentToLightness(50)).toBe(32768);
    expect(percentToLightness(100)).toBe(65535);
  });
});
