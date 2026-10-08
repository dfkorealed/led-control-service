import type { CadSceneCamera } from "../cad-scene/cad-scene-camera";
import type { MapPoint, MapRect, MapSize } from "./map-gestures";

/** Physical world-to-screen scale. Operating relative zoom must include fitScale. */
export type MapTransform = { pan: MapPoint; zoom: number };

function isMeasuredSize(size: MapSize): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

function isValidTransform(transform: MapTransform): boolean {
  return Number.isFinite(transform.pan.x) && Number.isFinite(transform.pan.y)
    && Number.isFinite(transform.zoom) && transform.zoom > 0;
}

export function screenToMapWorld(point: MapPoint, transform: MapTransform): MapPoint {
  return { x: (point.x - transform.pan.x) / transform.zoom, y: (point.y - transform.pan.y) / transform.zoom };
}

export function mapWorldToScreen(point: MapPoint, transform: MapTransform): MapPoint {
  return { x: point.x * transform.zoom + transform.pan.x, y: point.y * transform.zoom + transform.pan.y };
}

export function cameraFromTransform(transform: MapTransform, viewport: MapSize): CadSceneCamera | null {
  if (!isMeasuredSize(viewport) || !isValidTransform(transform)) return null;
  const center = screenToMapWorld({ x: viewport.width / 2, y: viewport.height / 2 }, transform);
  return { centerX: center.x, centerY: center.y, zoom: transform.zoom, viewportWidth: viewport.width, viewportHeight: viewport.height };
}

export function transformFromCamera(camera: CadSceneCamera): MapTransform | null {
  if (!isMeasuredSize({ width: camera.viewportWidth, height: camera.viewportHeight })
    || !Number.isFinite(camera.centerX) || !Number.isFinite(camera.centerY)
    || !Number.isFinite(camera.zoom) || camera.zoom <= 0) return null;
  return {
    pan: { x: camera.viewportWidth / 2 - camera.centerX * camera.zoom, y: camera.viewportHeight / 2 - camera.centerY * camera.zoom },
    zoom: camera.zoom
  };
}

export function mapViewportBounds(transform: MapTransform, viewport: MapSize): MapRect {
  const origin = screenToMapWorld({ x: 0, y: 0 }, transform);
  return { left: origin.x, top: origin.y, width: viewport.width / transform.zoom, height: viewport.height / transform.zoom };
}

export function fitMapTransform(input: {
  bounds: MapRect;
  viewport: MapSize;
  padding: number;
  minZoom: number;
  maxZoom: number;
}): MapTransform | null {
  const { bounds, viewport, padding, minZoom, maxZoom } = input;
  if (!isMeasuredSize(viewport) || !isMeasuredSize(bounds) || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
    || !Number.isFinite(padding) || padding < 0 || !Number.isFinite(minZoom) || minZoom <= 0
    || !Number.isFinite(maxZoom) || maxZoom < minZoom) return null;
  const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(
    (viewport.width - padding * 2) / bounds.width,
    (viewport.height - padding * 2) / bounds.height
  )));
  return {
    zoom,
    pan: { x: (viewport.width - bounds.width * zoom) / 2 - bounds.left * zoom, y: (viewport.height - bounds.height * zoom) / 2 - bounds.top * zoom }
  };
}
