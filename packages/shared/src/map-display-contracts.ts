import { z } from "zod";
import { CAD_SCENE_MAX_TILE_PART_COUNT, cadSceneManifestFieldsSchema, cadSceneManifestSchema, cadScenePrimitiveSchema,
  cadSceneTileSchema, refineCadSceneManifestTiles, type CadScenePrimitive } from "./cad-scene-contracts.js";
import { compareMapDisplayFragmentKeys, MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES, mapDisplayPageSchema,
  type MapDisplayPage } from "./map-display-pages.js";
export * from "./map-display-pages.js";

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

export const mapDisplayTileSchema = cadSceneTileSchema.extend({ version: z.literal(MAP_DISPLAY_VERSION),
  pages: z.array(mapDisplayPageSchema).min(1).max(500_000).optional() });
export type MapDisplayTile = z.infer<typeof mapDisplayTileSchema>;
const mapDisplayManifestFieldsSchema = cadSceneManifestFieldsSchema.extend({
  version: z.literal(MAP_DISPLAY_VERSION),
  orderedPages: z.object({ version: z.literal(1) }).strict().optional(),
  tiles: z.array(mapDisplayTileSchema).max(CAD_SCENE_MAX_TILE_PART_COUNT)
});

// Adapt only version tags to reuse the unchanged CAD ledger/normalization checks.
function legacyValidationView(manifest: z.infer<typeof mapDisplayManifestFieldsSchema>) {
  const { orderedPages: _ordered, ...legacy } = manifest;
  return { ...legacy, version: 1 as const, tiles: manifest.tiles.map(({ pages: _pages, ...tile }) => ({ ...tile, version: 1 as const })) };
}

function refineOrderedPages(manifest: z.infer<typeof mapDisplayManifestFieldsSchema>, context: z.RefinementCtx) {
  const streams = new Map<string, MapDisplayPage[]>();
  const fail = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: ["tiles"], message });
  for (const tile of manifest.tiles) {
    if (!manifest.orderedPages) { if (tile.pages) fail("pages require orderedPages v1"); continue; }
    if (!tile.pages || tile.byteSize > MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES) { fail("ordered asset page/byte limit"); continue; }
    let offset = 0;
    for (const page of tile.pages) {
      if (page.primitiveStart !== offset || compareMapDisplayFragmentKeys(page.firstKey, page.lastKey) > 0) fail("ordered page coverage/key range mismatch");
      offset += page.primitiveCount;
      const key = JSON.stringify([tile.tileX, tile.tileY, tile.lod, page.layerId]);
      const stream = streams.get(key) ?? []; stream.push(page); streams.set(key, stream);
    }
    if (offset !== tile.primitiveCount) fail("ordered page coverage mismatch");
  }
  for (const pages of streams.values()) {
    pages.sort((a, b) => a.sequence - b.sequence);
    let pending: MapDisplayPage["paintGroup"];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i], group = page.paintGroup;
      if (page.sequence !== i || i > 0 && compareMapDisplayFragmentKeys(pages[i - 1].lastKey, page.firstKey) >= 0) fail("ordered page sequence/range overlap");
      if (group && (group.elementId !== page.firstKey.elementId || group.elementId !== page.lastKey.elementId)) fail("ordered fill group element mismatch");
      if (pending ? !group || group.id !== pending.id || group.elementId !== pending.elementId || group.sequence !== pending.sequence + 1 ||
        group.style.fillColor !== pending.style.fillColor || group.style.opacity !== pending.style.opacity
        : group && group.sequence !== 0) fail("ordered fill continuation mismatch");
      pending = group && !group.final ? group : undefined;
    }
    if (pending) fail("ordered fill continuation incomplete");
  }
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
  refineOrderedPages(manifest, context);
});

/** Common imports use v2 ordering with the unchanged CAD source normalization.
 * Legacy v1 is intentionally rejected: regenerate derived assets, never infer z. */
export const importedMapDisplayManifestSchema = mapDisplayManifestFieldsSchema.superRefine((manifest, context) => {
  const result = cadSceneManifestSchema.safeParse(legacyValidationView(manifest));
  if (!result.success) result.error.issues.forEach(issue => context.addIssue(issue));
  refineOrderedPages(manifest, context);
});
export const mapDisplayManifestSchema = z.union([nativeMapDisplayManifestSchema, importedMapDisplayManifestSchema]);
export type MapDisplayManifest = z.infer<typeof mapDisplayManifestSchema>;
