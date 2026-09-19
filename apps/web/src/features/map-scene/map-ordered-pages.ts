import { compareMapDisplayFragmentKeys, mapDisplayFragmentSignature, validateMapDisplayPageContent,
  type MapDisplayFragmentKey, type MapDisplayPage, type MapDisplayTile, type OrderedMapDisplayPrimitive } from "@led-control/shared/map-display-contracts";
import type { MapDisplayPaintAsset } from "../cad-scene/cad-scene-worker";

export function validateMapPaintAssetPages(asset: MapDisplayPaintAsset, tile: MapDisplayTile,
  layerId: (name: string) => string | undefined): void {
  if (!tile.pages) throw new Error("Ordered asset pages are required");
  let offset = 0;
  for (const page of tile.pages) {
    if (page.primitiveStart !== offset || page.primitiveCount < 1 ||
        offset + page.primitiveCount > asset.primitiveOffsets.length) throw new Error("ordered page coverage mismatch");
    // The shared content validator sees only this logical page (normally64KiB),
    // never the cell's combined geometry. Large single primitives stay within
    // the ordered asset's hard2MiB limit and the caller's working reservation.
    const primitives = Array.from({ length: page.primitiveCount }, (_, index) => asset.read(offset + index));
    validateMapDisplayPageContent({ primitiveCount: primitives.length, pages: [{ ...page, primitiveStart: 0 }] }, primitives, layerId);
    primitives.length = 0;
    offset += page.primitiveCount;
  }
  if (offset !== tile.primitiveCount || offset !== asset.primitiveOffsets.length) throw new Error("ordered page coverage mismatch");
}

export interface MapPaintRecord {
  primitive: OrderedMapDisplayPrimitive;
  paintGroup?: MapDisplayPage["paintGroup"];
}

/** A cursor owns only a key and source position. Reading/refilling uses a shared
 * bounded asset window, never one retained decoded page per cursor. */
export interface MapPaintCursor {
  readonly key: MapDisplayFragmentKey | null;
  read(): Promise<MapPaintRecord>;
  advance(): Promise<void>;
}

export async function* mergeMapPaintStreams(cursors: readonly MapPaintCursor[], options: {
  signal: AbortSignal;
  reserveHeads(bytes: number): void;
}): AsyncGenerator<MapPaintRecord> {
  const headSize = (key: MapDisplayFragmentKey | null) => key ? 128 + key.elementId.length * 2 : 0;
  let bytes = cursors.length * 16;
  for (const cursor of cursors) bytes += headSize(cursor.key);
  options.reserveHeads(bytes);
  const keys = cursors.map(cursor => cursor.key);
  const heap = new Uint32Array(cursors.length);
  let count = 0;
  const less = (a: number, b: number) => compareMapDisplayFragmentKeys(keys[a]!, keys[b]!) < 0;
  const push = (index: number) => {
    let at = count++;
    while (at > 0) {
      const parent = (at - 1) >>> 1;
      if (!less(index, heap[parent])) break;
      heap[at] = heap[parent]; at = parent;
    }
    heap[at] = index;
  };
  const pop = () => {
    const first = heap[0], last = heap[--count];
    if (count) {
      let at = 0;
      while (at * 2 + 1 < count) {
        let child = at * 2 + 1;
        if (child + 1 < count && less(heap[child + 1], heap[child])) child++;
        if (!less(heap[child], last)) break;
        heap[at] = heap[child]; at = child;
      }
      heap[at] = last;
    }
    return first;
  };
  const advance = async (index: number) => {
    const old = keys[index]!;
    await cursors[index].advance(); options.signal.throwIfAborted();
    const next = cursors[index].key;
    if (next && compareMapDisplayFragmentKeys(old, next) >= 0) throw new Error("Invalid ordered paint stream order");
    bytes += headSize(next) - headSize(old); options.reserveHeads(bytes);
    keys[index] = next;
    if (next) push(index);
  };
  try {
    keys.forEach((key, index) => { if (key) push(index); });
    while (count) {
      options.signal.throwIfAborted();
      const index = pop(), key = keys[index]!;
      const record = await cursors[index].read(); options.signal.throwIfAborted();
      if (compareMapDisplayFragmentKeys(key, record.primitive) !== 0) throw new Error("Ordered paint head key mismatch");
      await advance(index);
      let signature: string | undefined;
      // Equal keys become adjacent in the merge, so exact influence-copy dedup
      // needs no map-wide ID set. Different clipped pieces keep distinct keys.
      while (count && compareMapDisplayFragmentKeys(key, keys[heap[0]]!) === 0) {
        const duplicate = pop(), other = await cursors[duplicate].read(); options.signal.throwIfAborted();
        signature ??= mapDisplayFragmentSignature(record.primitive);
        if (compareMapDisplayFragmentKeys(key, other.primitive) !== 0 ||
            signature !== mapDisplayFragmentSignature(other.primitive) || record.paintGroup?.id !== other.paintGroup?.id) {
          throw new Error("Conflicting ordered fragment identity");
        }
        await advance(duplicate);
      }
      yield record;
    }
  } finally { options.reserveHeads(0); }
}
