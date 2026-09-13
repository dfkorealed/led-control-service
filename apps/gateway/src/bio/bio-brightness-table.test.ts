import { describe, expect, it } from "vitest";
import { bioRawToPercent, percentToBioRaw } from "./bio-brightness-table";

// APK 1.2.0의 deep_all에서 정수 표시값(0%..100%)만 골라 같은 index의
// Scene.DEEP_VALUES와 손으로 대조한 기대값이다. 구현 배열을 재사용하지 않는다.
const expectedRawByIntegerPercent = [
  0, 26, 36, 44, 51, 57, 62, 67, 72, 77, 81,
  85, 88, 92, 95, 99, 102, 105, 108, 111, 114,
  117, 120, 122, 125, 128, 130, 133, 135, 137, 140,
  142, 144, 146, 149, 151, 153, 155, 157, 159, 161,
  163, 165, 167, 169, 171, 173, 175, 177, 179, 180,
  182, 184, 186, 187, 189, 191, 193, 194, 196, 198,
  199, 201, 202, 204, 206, 207, 209, 210, 212, 213,
  215, 216, 218, 219, 221, 222, 224, 225, 227, 228,
  230, 231, 232, 234, 235, 236, 238, 239, 241, 242,
  243, 245, 246, 247, 249, 250, 251, 252, 254, 255
] as const;

describe("BIO APK integer brightness table", () => {
  it("maps every service integer percent through the exact APK lookup", () => {
    expect(expectedRawByIntegerPercent).toHaveLength(101);
    expect(expectedRawByIntegerPercent.map((_, percent) => percentToBioRaw(percent)))
      .toEqual(expectedRawByIntegerPercent);
  });

  it.each([
    [0, 0], [1, 26], [20, 114], [60, 198], [90, 242], [99, 254], [100, 255]
  ] as const)("maps %i%% to raw %i instead of applying a linear scale", (percent, raw) => {
    expect(percentToBioRaw(percent)).toBe(raw);
  });

  it("reverses only raw values that exactly represent an integer service percent", () => {
    expect(expectedRawByIntegerPercent.map((raw) => bioRawToPercent(raw)))
      .toEqual(expectedRawByIntegerPercent.map((_, percent) => percent));
    for (const raw of [1, 8, 11, 25, 127, 197, 253]) expect(bioRawToPercent(raw)).toBeNull();
  });

  it.each([-1, 101, 1.5, Number.NaN])("rejects invalid service percent %s", (percent) => {
    expect(() => percentToBioRaw(percent)).toThrow(RangeError);
  });

  it.each([-1, 256, 1.5, Number.NaN])("returns null for invalid raw value %s", (raw) => {
    expect(bioRawToPercent(raw)).toBeNull();
  });
});
