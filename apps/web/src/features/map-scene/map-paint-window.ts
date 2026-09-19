import { MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES, validateMapDisplayPageContent,
  type MapDisplayPage, type MapDisplayTile, type OrderedMapDisplayPrimitive } from "@led-control/shared/map-display-contracts";
import { createMapDisplayPaintAsset, type MapDisplayPaintAsset } from "../cad-scene/cad-scene-worker";
import type { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";
import type { MapPaintCursor, MapPaintRecord } from "./map-ordered-pages";

export interface MapPageRef { tile: MapDisplayTile; page: MapDisplayPage }
interface PageEntry { values: OrderedMapDisplayPrimitive[]; bytes: number; pins: number }
let sequence = 0;

/** Exactly one raw asset, plus a bounded LRU of materialized logical pages.
 * Merge heads contain keys only; a page is pinned only while a record is used. */
export class MapPaintWindow {
  private readonly owner = `map-pages:${++sequence}`;
  private asset: MapDisplayPaintAsset | null = null;
  private assetKey = "";
  private readonly pages = new Map<string, PageEntry>();
  private pageBytes = 0;
  private closed = false;
  private readonly abort = () => this.close();

  constructor(private readonly options: {
    budget: CadSceneMemoryBudget; signal: AbortSignal;
    layerId(name: string): string | undefined;
    load(tile: MapDisplayTile, signal: AbortSignal): Promise<Uint8Array>;
  }) { options.signal.addEventListener("abort", this.abort, { once: true }); }

  get rawBytes(): number { return this.asset?.memoryBytes ?? 0; }

  async read(tile: MapDisplayTile, page: MapDisplayPage, index: number): Promise<MapPaintRecord> {
    this.assertOpen();
    if (index < 0 || index >= page.primitiveCount) throw new Error("Invalid ordered page index");
    const key = `${tile.assetId}:${tile.sha256}:${page.primitiveStart}`;
    let entry = this.pages.get(key);
    if (!entry) {
      const asset = await this.openAsset(tile);
      let bytes = 256;
      for (let i = 0; i < page.primitiveCount; i++) bytes += asset.estimate(page.primitiveStart + i);
      // Local cache bound supplements the shared aggregate cap. Large single
      // records are legal; admit them alone, never sample or split their path.
      for (const [candidate, value] of this.pages) {
        if (this.pageBytes + bytes <= 8 * 1024 * 1024) break;
        if (!value.pins) this.dropPage(candidate);
      }
      this.reserve(key, bytes, () => this.dropPage(key));
      try {
        const values = Array.from({ length: page.primitiveCount }, (_, i) => asset.read(page.primitiveStart + i));
        validateMapDisplayPageContent({ primitiveCount: values.length, pages: [{ ...page, primitiveStart: 0 }] }, values, this.options.layerId);
        entry = { values, bytes, pins: 0 }; this.pages.set(key, entry); this.pageBytes += bytes;
      } catch (error) { this.options.budget.release(this.owner, key); throw error; }
    }
    this.pages.delete(key); this.pages.set(key, entry);
    this.options.budget.touch(this.owner, key); this.options.budget.setPinned(this.owner, key, true); entry.pins++;
    let released = false;
    return { primitive: entry.values[index], paintGroup: page.paintGroup, release: () => {
      if (released) return; released = true; entry!.pins--;
      if (!entry!.pins) this.options.budget.setPinned(this.owner, key, false);
    } };
  }

  close(): void {
    this.options.signal.removeEventListener("abort", this.abort);
    this.closed = true; this.asset = null; this.assetKey = "";
    this.pages.clear(); this.pageBytes = 0; this.options.budget.releaseOwner(this.owner);
  }

  private async openAsset(tile: MapDisplayTile): Promise<MapDisplayPaintAsset> {
    const key = `${tile.assetId}:${tile.sha256}`;
    if (this.asset && this.assetKey === key) return this.asset;
    if (tile.byteSize > MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES) throw new Error("Map ordered asset byte limit exceeded");
    this.asset = null; this.assetKey = ""; this.options.budget.release(this.owner, "raw");
    // Fetch, SHA copies, indexed validation, one maximum-size primitive and
    // temporary identity map all precede retained-asset accounting. Admission
    // evicts unpinned pages before any response/body allocation begins.
    this.reserve("raw", tile.byteSize * 7 + tile.primitiveCount * 160 + 1024 * 1024);
    this.options.budget.setPinned(this.owner, "raw", true);
    try {
      const bytes = await this.load(tile); this.assertOpen();
      const asset = await createMapDisplayPaintAsset(bytes, tile); this.assertOpen();
      this.reserve("raw", asset.memoryBytes + 1024);
      this.asset = asset; this.assetKey = key;
      return asset;
    } catch (error) { this.options.budget.release(this.owner, "raw"); throw error; }
  }

  private reserve(key: string, bytes: number, evict?: () => void): void {
    if (!this.options.budget.reserve(this.owner, key, bytes, evict)) throw new Error("Ordered map page exceeds aggregate memory budget");
  }
  private load(tile: MapDisplayTile): Promise<Uint8Array> {
    const signal = this.options.signal;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      this.options.load(tile, signal).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private dropPage(key: string): void {
    const page = this.pages.get(key);
    if (page) { this.pageBytes -= page.bytes; this.pages.delete(key); }
    this.options.budget.release(this.owner, key);
  }
  private assertOpen(): void {
    this.options.signal.throwIfAborted();
    if (this.closed) throw new Error("Ordered map page window is closed");
  }
}

export function createMapPageCursor(pages: readonly MapPageRef[], window: MapPaintWindow): MapPaintCursor {
  let pageIndex = 0, recordIndex = 0;
  let key = pages[0]?.page.firstKey ?? null;
  return {
    get key() { return key; },
    read() { const ref = pages[pageIndex]; return window.read(ref.tile, ref.page, recordIndex); },
    async advance() {
      const ref = pages[pageIndex];
      if (++recordIndex === ref.page.primitiveCount) {
        recordIndex = 0; pageIndex++; key = pages[pageIndex]?.page.firstKey ?? null;
      } else {
        const record = await window.read(ref.tile, ref.page, recordIndex);
        const { zIndex, elementId, fragmentOrder } = record.primitive;
        key = { zIndex, elementId, fragmentOrder }; record.release?.();
      }
    }
  };
}
