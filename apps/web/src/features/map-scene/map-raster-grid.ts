import type { CadBounds } from "@led-control/shared";
import type { CadSceneCamera } from "../cad-scene/cad-scene-camera";

export function mapRasterGrid(manifest: { width: number; height: number; tileSize: number }, camera: CadSceneCamera, resolution: number) {
  const scale = camera.zoom * resolution;
  const offsetX = (camera.viewportWidth / 2 - camera.centerX * camera.zoom) * resolution;
  const offsetY = (camera.viewportHeight / 2 - camera.centerY * camera.zoom) * resolution;
  // Coalesce tiny source cells instead of assigning each a forced single pixel.
  // Native miter10 hairlines can influence 2.5 screen pixels, plus AA support.
  const margin = 2.5 / camera.zoom + 2 / scale;
  const size = Math.min(2 ** Math.floor(Math.log2(512 / scale)),
    Math.max(manifest.tileSize, 2 ** Math.ceil(Math.log2(64 / scale))));
  const envelope = { minX: -margin, minY: -margin, maxX: manifest.width + margin, maxY: manifest.height + margin };
  const halfWidth = camera.viewportWidth / camera.zoom / 2, halfHeight = camera.viewportHeight / camera.zoom / 2;
  const minX = Math.max(envelope.minX, camera.centerX - halfWidth), maxX = Math.min(envelope.maxX, camera.centerX + halfWidth);
  const minY = Math.max(envelope.minY, camera.centerY - halfHeight), maxY = Math.min(envelope.maxY, camera.centerY + halfHeight);
  const jobs: { key: string; bounds: CadBounds; rasterBounds: CadBounds; left: number; top: number; width: number; height: number }[] = [];
  if (minX >= maxX || minY >= maxY) return { jobs, size, scale, offsetX, offsetY, margin };
  for (let y = Math.floor(minY / size); y < Math.ceil(maxY / size); y++) for (let x = Math.floor(minX / size); x < Math.ceil(maxX / size); x++) {
    const bounds = { minX: Math.max(envelope.minX, x * size), minY: Math.max(envelope.minY, y * size),
      maxX: Math.min(envelope.maxX, (x + 1) * size), maxY: Math.min(envelope.maxY, (y + 1) * size) };
    const left = Math.ceil(bounds.minX * scale + offsetX), top = Math.ceil(bounds.minY * scale + offsetY);
    const width = Math.ceil(bounds.maxX * scale + offsetX) - left, height = Math.ceil(bounds.maxY * scale + offsetY) - top;
    if (width <= 0 || height <= 0) continue;
    jobs.push({ key: `${size}:${x}:${y}`, bounds, left, top, width, height,
      rasterBounds: { minX: (left - offsetX) / scale, minY: (top - offsetY) / scale,
        maxX: (left + width - offsetX) / scale, maxY: (top + height - offsetY) / scale } });
  }
  return { jobs, size, scale, offsetX, offsetY, margin };
}
