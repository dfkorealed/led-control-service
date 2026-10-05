import { describe, expect, it } from "vitest";
import { cameraFromBounds } from "./map-camera";
import * as geometry from "./map-camera-geometry";

describe("shared map camera geometry", () => {
  it("round trips physical transforms without changing relative camera", () => {
    expect(geometry.cameraFromTransform).toBeTypeOf("function");
    const transform = { pan: { x: 10, y: 10 }, zoom: 2 };
    expect(geometry.screenToMapWorld({ x: 50, y: 70 }, transform)).toEqual({ x: 20, y: 30 });
    expect(geometry.mapWorldToScreen({ x: 20, y: 30 }, transform)).toEqual({ x: 50, y: 70 });
    const camera = geometry.cameraFromTransform(transform, { width: 800, height: 600 });
    expect(camera).toEqual({ centerX: 195, centerY: 145, zoom: 2, viewportWidth: 800, viewportHeight: 600 });
    expect(geometry.transformFromCamera(camera!)).toEqual(transform);
    expect(geometry.mapViewportBounds(transform, { width: 800, height: 600 })).toEqual({ left: -5, top: -5, width: 400, height: 300 });

    // Fit scale .25 * stored relative zoom 2 = physical world-to-screen scale .5.
    expect(geometry.cameraFromTransform({ pan: { x: 10, y: 10 }, zoom: 0.5 }, { width: 800, height: 600 }))
      .toEqual({ centerX: 780, centerY: 580, zoom: 0.5, viewportWidth: 800, viewportHeight: 600 });
    expect(cameraFromBounds({ left: 0, top: 0, width: 800, height: 600 }, { left: 10, top: 10, width: 1000, height: 800 }, 2))
      .toEqual({ centerXRatio: 0.39, centerYRatio: 0.3625, zoom: 2 });
    expect(transform).toEqual({ pan: { x: 10, y: 10 }, zoom: 2 });
  });

  it("unmeasured viewport waits without resetting user camera", () => {
    expect(geometry.cameraFromTransform).toBeTypeOf("function");
    const transform = { pan: { x: -80, y: 25 }, zoom: 0.001 };
    for (const viewport of [{ width: 0, height: 0 }, { width: -1, height: 600 }, { width: 800, height: NaN }, { width: Infinity, height: 600 }]) {
      expect(geometry.cameraFromTransform(transform, viewport)).toBeNull();
      expect(geometry.fitMapTransform({ bounds: { left: 0, top: 0, width: 1200, height: 800 }, viewport, padding: 24, minZoom: 0.001, maxZoom: 2 })).toBeNull();
    }
    expect(transform).toEqual({ pan: { x: -80, y: 25 }, zoom: 0.001 });
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid physical zoom %s instead of manufacturing a camera", zoom => {
    expect(geometry.cameraFromTransform).toBeTypeOf("function");
    expect(geometry.cameraFromTransform({ pan: { x: 0, y: 0 }, zoom }, { width: 800, height: 600 })).toBeNull();
    expect(geometry.transformFromCamera({ centerX: 10, centerY: 20, zoom, viewportWidth: 800, viewportHeight: 600 })).toBeNull();
  });

  it("rejects nonfinite camera centers and pan", () => {
    expect(geometry.transformFromCamera).toBeTypeOf("function");
    expect(geometry.transformFromCamera({ centerX: NaN, centerY: 20, zoom: 1, viewportWidth: 800, viewportHeight: 600 })).toBeNull();
    expect(geometry.cameraFromTransform({ pan: { x: 0, y: Infinity }, zoom: 1 }, { width: 800, height: 600 })).toBeNull();
  });

  it("fits translated world bounds with caller-owned editor and operating scale limits", () => {
    expect(geometry.fitMapTransform).toBeTypeOf("function");
    expect(geometry.fitMapTransform({ bounds: { left: 100, top: 200, width: 1000, height: 500 }, viewport: { width: 1048, height: 548 }, padding: 24, minZoom: 0.001, maxZoom: 2 }))
      .toEqual({ pan: { x: -76, y: -176 }, zoom: 1 });
    expect(geometry.fitMapTransform({ bounds: { left: 0, top: 0, width: 100, height: 100 }, viewport: { width: 1048, height: 548 }, padding: 24, minZoom: 0.001, maxZoom: 2 }))
      .toEqual({ pan: { x: 424, y: 174 }, zoom: 2 });
    const tinyFit = geometry.fitMapTransform({ bounds: { left: 0, top: 0, width: 32768, height: 16384 }, viewport: { width: 320, height: 240 }, padding: 24, minZoom: 0.001, maxZoom: 2 });
    expect(tinyFit?.zoom).toBeCloseTo(0.00830078125);
    expect(tinyFit?.pan).toEqual({ x: 24, y: 52 });
  });

  it("waits for valid map bounds and fit policy", () => {
    expect(geometry.fitMapTransform).toBeTypeOf("function");
    const input = { bounds: { left: 0, top: 0, width: 1200, height: 800 }, viewport: { width: 800, height: 600 }, padding: 24, minZoom: 0.001, maxZoom: 2 };
    expect(geometry.fitMapTransform({ ...input, bounds: { ...input.bounds, width: 0 } })).toBeNull();
    expect(geometry.fitMapTransform({ ...input, bounds: { ...input.bounds, left: NaN } })).toBeNull();
    expect(geometry.fitMapTransform({ ...input, minZoom: 0 })).toBeNull();
    expect(geometry.fitMapTransform({ ...input, maxZoom: 0.0001 })).toBeNull();
    expect(geometry.fitMapTransform({ ...input, padding: -1 })).toBeNull();
  });
});
