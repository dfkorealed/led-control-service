import { describe, expect, it } from "vitest";
import { isMapViewportCamera, cameraFromBounds } from "./map-camera";

describe("normalized map camera", () => {
  it("uses the full viewport center and relative zoom", () => {
    expect(cameraFromBounds({ left: 100, top: 50, width: 200, height: 100 }, { left: 0, top: 0, width: 800, height: 400 }, 2))
      .toEqual({ centerXRatio: 0.25, centerYRatio: 0.25, zoom: 2 });
  });
  it.each([null, {}, { centerXRatio: NaN, centerYRatio: .5, zoom: 1 }, { centerXRatio: .5, centerYRatio: .5, zoom: 5 }])("rejects invalid cameras %s", value => {
    expect(isMapViewportCamera(value)).toBe(false);
  });
  it("does not capture an unmeasured map", () => {
    expect(cameraFromBounds({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 800, height: 400 }, 1)).toBeNull();
  });
});
