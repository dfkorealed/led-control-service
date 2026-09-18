import { createHash } from "node:crypto";
import type { CadSceneTile } from "@led-control/shared";

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function cadScenePersistenceIdentity(jobId: string, regionId: string) {
  const sceneId = deterministicUuid(`${jobId}:${regionId}:scene`);
  const manifestAssetId = deterministicUuid(`${sceneId}:manifest`);
  const tileAssetId = (tile: Pick<CadSceneTile, "tileX" | "tileY" | "lod" | "part">) =>
    deterministicUuid(`${sceneId}:tile:${tile.lod}:${tile.tileX}:${tile.tileY}:${tile.part}`);
  return {
    sceneId,
    manifestAssetId,
    tileAssetId,
    manifestObjectKey: (floorId: string) =>
      `floors/${floorId}/${jobId}-${manifestAssetId}.cad-manifest.json`,
    tileObjectKey: (floorId: string, tile: Pick<CadSceneTile, "assetId">) =>
      `floors/${floorId}/${jobId}-${tile.assetId}.cad-tile.bin`
  };
}

export function cadRegionPreviewPersistenceIdentity(jobId: string, regionId: string) {
  const assetId = deterministicUuid(`${jobId}:${regionId}:preview`);
  return {
    assetId,
    objectKey: (floorId: string) => `floors/${floorId}/${assetId}.cad-region-preview.svg`
  };
}
