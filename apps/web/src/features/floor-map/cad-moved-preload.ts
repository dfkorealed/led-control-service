import type { CadElementOverride, CadSceneManifest, CadSceneTile } from "@led-control/shared";
import { cadSceneLocatorKey } from "@led-control/shared/cad-scene-contracts";
import type { CadSceneRendererOptions } from "../cad-scene/CadSceneRenderer";
import type { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import type { CadSceneWorkerClient, DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import { applyCadElementOverrides, transformCadBounds } from "../floor-editor/cad-editor-runtime";

const MAX_PRELOAD_TILES = 32;
const MAX_PRELOAD_BYTES = 32 * 1024 * 1024;

/** Moved elements no longer obey manifest culling. Keep their source evidence
 * in one bounded, pinned overlay; never silently drop a persisted edit. */
export async function preloadMovedCadTiles(
  manifest: CadSceneManifest,
  overrides: ReadonlyMap<string, CadElementOverride>,
  loadTile: CadSceneRendererOptions["loadTile"],
  worker: CadSceneWorkerClient,
  budget: CadSceneMemoryBudget,
  owner: string,
  signal: AbortSignal
): Promise<Map<string, DecodedCadSceneTile>> {
  const byLocator = new Map(manifest.tiles.map(tile => [cadSceneLocatorKey(tile), tile]));
  const byCell = new Map<string, CadSceneTile[]>();
  for (const tile of manifest.tiles) {
    const key = `${tile.lod}:${tile.tileX}:${tile.tileY}`;
    const parts = byCell.get(key) ?? [];
    parts.push(tile);
    byCell.set(key, parts);
  }
  const decoded = new Map<string, DecodedCadSceneTile>();
  const included = new Map<string, Set<string>>();
  let payloadBytes = 0;

  const load = async (tile: CadSceneTile) => {
    signal.throwIfAborted();
    const key = cadSceneLocatorKey(tile);
    const cached = decoded.get(key);
    if (cached) return cached;
    if (decoded.size >= MAX_PRELOAD_TILES || payloadBytes + tile.byteSize > MAX_PRELOAD_BYTES) {
      throw new Error("CAD moved preload exceeds tile/byte limit");
    }
    const payload = await loadTile(tile, signal);
    signal.throwIfAborted();
    payloadBytes += payload.byteLength;
    if (payloadBytes > MAX_PRELOAD_BYTES) throw new Error("CAD moved preload exceeds byte limit");
    const result = await worker.decode(payload, tile);
    signal.throwIfAborted();
    if (!budget.reserve(owner, `source:${key}`, Math.max(1, result.memory.cpuBytes))) {
      throw new Error("CAD moved preload exceeds memory budget");
    }
    budget.setPinned(owner, `source:${key}`, true);
    decoded.set(key, result);
    return result;
  };

  for (const override of overrides.values()) {
    if (!override.locator) throw new Error("CAD moved override requires a persisted locator");
    const seed = byLocator.get(cadSceneLocatorKey(override.locator));
    if (!seed) throw new Error("CAD moved override locator is absent from manifest");
    const queue = [seed];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const tile = queue.shift()!;
      const key = cadSceneLocatorKey(tile);
      if (visited.has(key)) continue;
      visited.add(key);
      const result = await load(tile);
      const entries = result.pickEntries.filter(entry => entry.elementId === override.elementId);
      if (entries.length === 0) {
        if (tile === seed) throw new Error("CAD moved override locator does not contain its element");
        continue;
      }
      const ids = included.get(key) ?? new Set<string>();
      ids.add(override.elementId);
      included.set(key, ids);
      // A primitive may be clipped into adjacent tiles/parts. Follow only
      // touched boundaries at the persisted LOD, within the same preload cap.
      for (const entry of entries) {
        const xs = [tile.tileX];
        const ys = [tile.tileY];
        if (entry.bounds.minX <= tile.bounds.minX) xs.push(tile.tileX - 1);
        if (entry.bounds.maxX >= tile.bounds.maxX) xs.push(tile.tileX + 1);
        if (entry.bounds.minY <= tile.bounds.minY) ys.push(tile.tileY - 1);
        if (entry.bounds.maxY >= tile.bounds.maxY) ys.push(tile.tileY + 1);
        for (const x of xs) for (const y of ys) {
          queue.push(...(byCell.get(`${tile.lod}:${x}:${y}`) ?? []).filter(part => !visited.has(cadSceneLocatorKey(part))));
        }
      }
    }
  }

  const overlays = new Map<string, DecodedCadSceneTile>();
  for (const [key, tile] of decoded) {
    const ids = included.get(key);
    if (ids) {
      const selected = new Map(overrides);
      for (const entry of tile.pickEntries) {
        if (!ids.has(entry.elementId)) selected.set(entry.elementId, {
          elementId: entry.elementId, hidden: true, transform: null,
          strokeColor: null, fillColor: null, strokeWidth: null, text: null
        });
      }
      assertBoundedCadTransforms(tile, selected);
      const transformed = applyCadElementOverrides(tile, selected);
      const bytes = transformed.memory.cpuBytes + transformed.memory.gpuBytes + transformed.memory.textAtlasBytes;
      if (!budget.reserve(owner, `overlay:${key}`, Math.max(1, bytes))) {
        throw new Error("CAD moved preload exceeds memory budget");
      }
      budget.setPinned(owner, `overlay:${key}`, true);
      overlays.set(`moved:${key}`, transformed);
    }
    decoded.delete(key);
    budget.release(owner, `source:${key}`);
  }
  return overlays;
}

export function assertBoundedCadTransforms(tile: DecodedCadSceneTile, overrides: ReadonlyMap<string, CadElementOverride>) {
  if (!tile.pickEntries.some(entry => overrides.has(entry.elementId))) return;
  let cells = 0;
  for (const entry of tile.pickEntries) {
    const override = overrides.get(entry.elementId);
    if (override?.hidden) continue;
    const bounds = override?.transform ? transformCadBounds(entry.bounds, override.transform) : entry.bounds;
    cells += (Math.floor(bounds.maxX / 64) - Math.floor(bounds.minX / 64) + 1) *
      (Math.floor(bounds.maxY / 64) - Math.floor(bounds.minY / 64) + 1);
    // Task8's shared override helper builds a 64-unit pick index, even for
    // read-only rendering. Bound its expansion before allocating the index.
    if (cells > 65_536) throw new Error("CAD transformed spatial index exceeds memory budget");
  }
}
