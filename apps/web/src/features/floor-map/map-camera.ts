export interface MapViewportCamera {
  centerXRatio: number;
  centerYRatio: number;
  zoom: number;
}

export function isMapViewportCamera(value: unknown): value is MapViewportCamera {
  if (!value || typeof value !== "object") return false;
  const camera = value as MapViewportCamera;
  return [camera.centerXRatio, camera.centerYRatio, camera.zoom].every(Number.isFinite)
    && camera.centerXRatio >= 0 && camera.centerXRatio <= 1
    && camera.centerYRatio >= 0 && camera.centerYRatio <= 1
    && camera.zoom >= .1 && camera.zoom <= 4;
}

type Bounds = Pick<DOMRect, "left" | "top" | "width" | "height">;
export function cameraFromBounds(viewport: Bounds, surface: Bounds, zoom: number): MapViewportCamera | null {
  if (viewport.width <= 0 || viewport.height <= 0 || surface.width <= 0 || surface.height <= 0) return null;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const camera = {
    centerXRatio: clamp((viewport.left + viewport.width / 2 - surface.left) / surface.width),
    centerYRatio: clamp((viewport.top + viewport.height / 2 - surface.top) / surface.height),
    zoom
  };
  return isMapViewportCamera(camera) ? camera : null;
}
