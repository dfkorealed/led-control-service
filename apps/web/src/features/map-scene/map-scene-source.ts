import type { CadSceneManifest, CadSceneTile } from "@led-control/shared";
import type { MapAssetRef, MapDocumentRef, MapElement, MapGroup, MapLayer } from "@led-control/shared/map-document-contracts";
import type { CadSceneWorkerClient } from "../cad-scene/cad-scene-worker";

export interface MapSceneManifest {
  generationId: string;
  revision: number;
  /** Private canonical metadata identity, NOT an overview geometry payload. */
  canonical: MapAssetRef;
  /** Internal derived compact codec/LOD only; IDs must equal canonical IDs. */
  display: CadSceneManifest;
  /** Required even for identity mappings. Never infer layer IDs from names. */
  displayLayerBindings: Array<{ layerName: string; layerId: string }>;
  groups: MapGroup[];
  layers: MapLayer[];
}

/** One source instance belongs to one authenticated tenant/floor/user scope.
 * Providers verify private asset integrity and enforce streaming body limits.
 * getElements reads only requested canonical IDs, never all document chunks.
 * Injected decoders are provider-owned; the default renderer worker is owned
 * and terminated by the renderer. Decoders must not detach cached input bytes.
 */
export interface MapSceneSource {
  readonly scopeKey: string;
  getManifest(ref: MapDocumentRef, signal: AbortSignal): Promise<MapSceneManifest>;
  loadDisplayTile(tile: CadSceneTile, signal: AbortSignal): Promise<Uint8Array>;
  getElements(ref: MapDocumentRef, ids: readonly string[], signal: AbortSignal): Promise<readonly MapElement[]>;
  decodeDisplayTile?: CadSceneWorkerClient["decode"];
}
