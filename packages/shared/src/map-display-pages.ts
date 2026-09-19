import { z } from "zod";
import type { CadScenePrimitive } from "./cad-scene-contracts.js";

export const MAP_DISPLAY_ORDERED_ASSET_TARGET_BYTES = 1_048_576;
export const MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES = 2_097_152;
export const MAP_DISPLAY_PAGE_TARGET_BYTES = 65_536;
export const mapDisplayFragmentKeySchema = z.object({
  zIndex: z.number().int().min(-2147483648).max(2147483647),
  elementId: z.string().min(1).max(512), fragmentOrder: z.number().int().min(0).max(0xffffffff)
}).strict();
export type MapDisplayFragmentKey = z.infer<typeof mapDisplayFragmentKeySchema>;
export function compareMapDisplayFragmentKeys(a: MapDisplayFragmentKey, b: MapDisplayFragmentKey): number {
  return a.zIndex - b.zIndex || (a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0)
    || a.fragmentOrder - b.fragmentOrder;
}

/** Logical pages are contiguous record ranges inside an unchanged CDTL v2
 * asset, not separate files. Layers may share an asset without sharing paint.
 * Sequences are per (cell,lod,layer), independent of physical part order.
 * A paintGroup denotes ONLY tessellation of one canonical fill. Keep its path
 * across pages, charge native path scratch, and fill once at final; never merge
 * independent elements merely because they have equal style. */
export const mapDisplayPageSchema = z.object({
  layerId: z.string().min(1).max(512), sequence: z.number().int().nonnegative().max(0xffffffff),
  primitiveStart: z.number().int().nonnegative().max(500_000),
  primitiveCount: z.number().int().positive().max(500_000),
  firstKey: mapDisplayFragmentKeySchema, lastKey: mapDisplayFragmentKeySchema,
  paintGroup: z.object({ id: z.string().min(1).max(512), elementId: z.string().min(1).max(512),
    phase: z.literal("fill"), sequence: z.number().int().nonnegative().max(0xffffffff), final: z.boolean(),
    pointCount: z.number().int().positive().max(0xffffffff) }).strict().optional()
}).strict();
export type MapDisplayPage = z.infer<typeof mapDisplayPageSchema>;
type OrderedPrimitive = CadScenePrimitive & { zIndex: number; fragmentOrder: number };

export function mapDisplayPathPointCount(p: CadScenePrimitive): number {
  return p.type === "polyline" || p.type === "triangle" ? p.geometry.points.length : 0;
}

/** Validate decoded content, not just claims in the manifest. Call after raw
 * size/hash verification, before painting. layerId resolves through the existing
 * scene displayLayerBindings; no order is baked into these pages. */
export function validateMapDisplayPageContent(tile: { primitiveCount: number; pages?: MapDisplayPage[] },
  primitives: readonly OrderedPrimitive[], layerId: (layerName: string) => string | undefined): void {
  if (primitives.length !== tile.primitiveCount) throw new Error("ordered page record count mismatch");
  if (!tile.pages) return;
  let offset = 0;
  for (const page of tile.pages) {
    if (page.primitiveStart !== offset || offset + page.primitiveCount > primitives.length) throw new Error("ordered page coverage mismatch");
    let points = 0;
    let fillStyle: string | undefined;
    for (let i = offset; i < offset + page.primitiveCount; i++) {
      const p = primitives[i];
      if (layerId(p.layerName) !== page.layerId) throw new Error("ordered page layer mismatch");
      if (i > offset && compareMapDisplayFragmentKeys(primitives[i - 1], p) >= 0) throw new Error("ordered page key order mismatch");
      if (page.paintGroup) {
        const style = JSON.stringify([p.style.fillColor, p.style.opacity]);
        if (p.elementId !== page.paintGroup.elementId || p.style.fillColor === null || p.style.strokeColor !== null ||
          !(p.type === "triangle" || p.type === "polyline" && p.geometry.closed) || fillStyle !== undefined && fillStyle !== style) {
          throw new Error("ordered page fill group mismatch");
        }
        fillStyle = style; points += mapDisplayPathPointCount(p);
      }
    }
    if (compareMapDisplayFragmentKeys(page.firstKey, primitives[offset]) !== 0 ||
      compareMapDisplayFragmentKeys(page.lastKey, primitives[offset + page.primitiveCount - 1]) !== 0) throw new Error("ordered page endpoint mismatch");
    if (page.paintGroup && page.paintGroup.pointCount !== points) throw new Error("ordered page path point count mismatch");
    offset += page.primitiveCount;
  }
  if (offset !== primitives.length) throw new Error("ordered page coverage mismatch");
}

/** In orderedPages v1, (elementId,fragmentOrder) is a geometry-fragment identity:
 * copies differ ONLY in bounds/clipBounds. Distinct clipped pieces must have
 * distinct fragmentOrder. Consumers deduplicate copies during influence merges,
 * not independent equal-style elements. This signature excludes those bounds
 * and is stable even when object property insertion order differs. */
export function mapDisplayFragmentSignature(p: OrderedPrimitive): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object" ? Object.keys(value).sort().map(key =>
      [key, canonical((value as Record<string, unknown>)[key])]) : value;
  const geometry = canonical(p.geometry);
  return JSON.stringify([p.type, p.groupId, p.layerName, p.sourceType, p.zIndex,
    p.style.strokeColor, p.style.fillColor, p.style.strokeWidth, p.style.opacity, geometry]);
}
