export interface CadSceneCamera {
  centerX: number;
  centerY: number;
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface CadSceneSize {
  width: number;
  height: number;
  tileSize: number;
}

export interface CadTileCoordinate {
  tileX: number;
  tileY: number;
}

export type CadRendererPlatform = "desktop" | "mobile";

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
}

export function validateCadSceneCamera(camera: CadSceneCamera): CadSceneCamera {
  if (!Number.isFinite(camera.centerX) || !Number.isFinite(camera.centerY)) {
    throw new Error("CAD scene camera center must be finite");
  }
  assertPositiveFinite(camera.zoom, "CAD scene camera zoom");
  assertPositiveFinite(camera.viewportWidth, "CAD scene viewport width");
  assertPositiveFinite(camera.viewportHeight, "CAD scene viewport height");
  return camera;
}

export function computeVisibleTileCoordinates(
  scene: CadSceneSize,
  camera: CadSceneCamera,
  surroundingTileRing = 1
): CadTileCoordinate[] {
  validateCadSceneCamera(camera);
  assertPositiveFinite(scene.width, "CAD scene width");
  assertPositiveFinite(scene.height, "CAD scene height");
  assertPositiveFinite(scene.tileSize, "CAD scene tile size");
  if (!Number.isSafeInteger(surroundingTileRing) || surroundingTileRing < 0) {
    throw new Error("CAD scene surrounding tile ring must be a nonnegative integer");
  }

  const halfWidth = camera.viewportWidth / (2 * camera.zoom);
  const halfHeight = camera.viewportHeight / (2 * camera.zoom);
  const maximumTileX = Math.ceil(scene.width / scene.tileSize) - 1;
  const maximumTileY = Math.ceil(scene.height / scene.tileSize) - 1;
  const minimumX = Math.max(0, camera.centerX - halfWidth);
  const minimumY = Math.max(0, camera.centerY - halfHeight);
  const maximumX = Math.min(scene.width, camera.centerX + halfWidth);
  const maximumY = Math.min(scene.height, camera.centerY + halfHeight);
  const firstTileX = Math.max(0, Math.floor(minimumX / scene.tileSize) - surroundingTileRing);
  const firstTileY = Math.max(0, Math.floor(minimumY / scene.tileSize) - surroundingTileRing);
  const lastTileX = Math.min(
    maximumTileX,
    Math.max(0, Math.ceil(maximumX / scene.tileSize) - 1) + surroundingTileRing
  );
  const lastTileY = Math.min(
    maximumTileY,
    Math.max(0, Math.ceil(maximumY / scene.tileSize) - 1) + surroundingTileRing
  );
  const coordinates: CadTileCoordinate[] = [];
  for (let tileY = firstTileY; tileY <= lastTileY; tileY++) {
    for (let tileX = firstTileX; tileX <= lastTileX; tileX++) coordinates.push({ tileX, tileY });
  }
  return coordinates;
}

export function selectCadSceneLods(zoom: number, representation: "source" | "display" = "source"): Array<0 | 1 | 2> {
  assertPositiveFinite(zoom, "CAD scene camera zoom");
  // Existing manifests partition by entity type, not geometric importance.
  // Native overview must read every partition, including structural polylines.
  if (representation === "display") return [0, 1, 2];
  if (zoom < 0.5) return [0];
  if (zoom < 1.5) return [0, 1];
  return [0, 1, 2];
}

export function cadDisplayZoomBand(zoom: number): number {
  assertPositiveFinite(zoom, "CAD scene camera zoom");
  return 2 ** (Math.ceil(Math.log2(zoom) * 2) / 2);
}

export function capCadRendererResolution(
  devicePixelRatio: number,
  platform: CadRendererPlatform
): number {
  const normalizedRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(normalizedRatio, platform === "mobile" ? 1 : 1.5);
}

export function screenToCadWorld(
  point: { x: number; y: number },
  camera: CadSceneCamera
): { x: number; y: number } {
  validateCadSceneCamera(camera);
  return {
    x: camera.centerX + (point.x - camera.viewportWidth / 2) / camera.zoom,
    y: camera.centerY + (point.y - camera.viewportHeight / 2) / camera.zoom
  };
}
