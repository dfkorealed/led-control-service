import { z } from "zod";
import { CAD_SCENE_MAX_TILE_PART_COUNT, cadSceneManifestFieldsSchema, cadSceneManifestSchema, cadScenePrimitiveSchema,
  cadSceneTileSchema, refineCadSceneManifestTiles, type CadScenePrimitive } from "./cad-scene-contracts.js";

export const MAP_DISPLAY_VERSION = 2;
export type OrderedMapDisplayPrimitive = CadScenePrimitive & { zIndex: number; fragmentOrder: number };
export const mapDisplayOrderingSchema = z.object({
  zIndex: z.number().int().min(-2147483648).max(2147483647),
  fragmentOrder: z.number().int().min(0).max(0xffffffff)
});

export const mapDisplayPrimitiveSchema = mapDisplayOrderingSchema.passthrough().transform((value, context): OrderedMapDisplayPrimitive => {
  const { zIndex, fragmentOrder, ...legacy } = value;
  const result = cadScenePrimitiveSchema.safeParse(legacy);
  if (!result.success) {
    result.error.issues.forEach(issue => context.addIssue(issue));
    return z.NEVER;
  }
  return { ...result.data, zIndex, fragmentOrder };
});

export const mapDisplayTileSchema = cadSceneTileSchema.extend({ version: z.literal(MAP_DISPLAY_VERSION) });
export type MapDisplayTile = z.infer<typeof mapDisplayTileSchema>;
const mapDisplayManifestFieldsSchema = cadSceneManifestFieldsSchema.extend({
  version: z.literal(MAP_DISPLAY_VERSION),
  tiles: z.array(mapDisplayTileSchema).max(CAD_SCENE_MAX_TILE_PART_COUNT)
});

// Adapt only version tags to reuse the unchanged CAD ledger/normalization checks.
function legacyValidationView(manifest: z.infer<typeof mapDisplayManifestFieldsSchema>) {
  return { ...manifest, version: 1 as const, tiles: manifest.tiles.map(tile => ({ ...tile, version: 1 as const })) };
}

export interface MapDisplayPaintKey {
  layerOrder: number;
  layerId: string;
  zIndex: number;
  elementId: string;
  fragmentOrder: number;
  phase: "fill" | "stroke";
}

/** Current layer order is resolved by the consumer, never baked into the CDTL.
 * Ordinal strings are deliberate: locale collation is not a stable paint key. */
export function compareMapDisplayPaintKeys(left: MapDisplayPaintKey, right: MapDisplayPaintKey): number {
  const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return left.layerOrder - right.layerOrder || ordinal(left.layerId, right.layerId)
    || left.zIndex - right.zIndex || ordinal(left.elementId, right.elementId)
    || left.fragmentOrder - right.fragmentOrder || Number(left.phase === "stroke") - Number(right.phase === "stroke");
}

/** Native/checkpoint display coordinates are already logical map coordinates;
 * unlike imported CAD, they must not be normalized or Y-flipped a second time.
 * This applies equally to empty maps and nonempty derived display generations. */
export const nativeMapDisplayManifestSchema = mapDisplayManifestFieldsSchema.extend({
  padding: z.literal(0),
  gridSize: z.number().int().min(5).max(200)
}).superRefine((manifest, context) => {
  const expectedBounds = { minX: 0, minY: 0, maxX: manifest.width, maxY: manifest.height };
  if (Object.entries(expectedBounds).some(([key, value]) => manifest.sourceBounds[key as keyof typeof expectedBounds] !== value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceBounds"], message: "sourceBounds must equal the logical map extent" });
  }
  const expectedTransform = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 };
  if (Object.entries(expectedTransform).some(([key, value]) => manifest.transform[key as keyof typeof expectedTransform] !== value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["transform"], message: "native map display transform must be identity" });
  }
  refineCadSceneManifestTiles(legacyValidationView(manifest), context);
});

/** Common imports use v2 ordering with the unchanged CAD source normalization.
 * Legacy v1 is intentionally rejected: regenerate derived assets, never infer z. */
export const importedMapDisplayManifestSchema = mapDisplayManifestFieldsSchema.superRefine((manifest, context) => {
  const result = cadSceneManifestSchema.safeParse(legacyValidationView(manifest));
  if (!result.success) result.error.issues.forEach(issue => context.addIssue(issue));
});
export const mapDisplayManifestSchema = z.union([nativeMapDisplayManifestSchema, importedMapDisplayManifestSchema]);
export type MapDisplayManifest = z.infer<typeof mapDisplayManifestSchema>;
