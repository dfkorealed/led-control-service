import type { CadSceneManifest, CadSceneTile } from "@led-control/shared";
import type { MapDisplayManifest, MapDisplayTile } from "@led-control/shared/map-display-contracts";

/** Renderer internals support two strict codecs; common providers expose only v2. */
export type SceneTile = CadSceneTile | MapDisplayTile;
export type SceneManifest = CadSceneManifest | MapDisplayManifest;
