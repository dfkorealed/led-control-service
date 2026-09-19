import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { CAD_SCENE_MAX_MANIFEST_BYTES, CAD_SCENE_MAX_PARTS_PER_TILE, CAD_SCENE_MAX_TILE_PART_COUNT,
  CAD_SCENE_MAX_TOTAL_TILE_BYTES, compareMapDisplayFragmentKeys, MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES,
  MAP_DISPLAY_ORDERED_ASSET_TARGET_BYTES, MAP_DISPLAY_PAGE_TARGET_BYTES, mapDisplayPathPointCount,
  validateMapDisplayPageContent, type MapDisplayPage, type MapDisplayTile, type OrderedMapDisplayPrimitive } from "@led-control/shared";
import { encodeTrustedMapDisplayTile, getCadSceneTileIntegrity, MapDisplayTileSizeTracker } from "./cad-scene-codec";

type Cell = { tileX: number; tileY: number; lod: 0 | 1 | 2 };
type Record = { primitive: OrderedMapDisplayPrimitive; paintGroup?: string };
export interface OrderedPageWriterOptions {
  sceneId: string; width: number; height: number; directory?: string;
  claimBytes?: (bytes: number) => void; checkBudget?: () => void;
  assetTargetBytes?: number; pageTargetBytes?: number;
  maximumByteSize?: number; maximumPartsPerCell?: number; maximumPartCount?: number; maximumTotalByteSize?: number;
  tileAssetId?: (cell: Cell & { part: number }) => string;
}
type Run = Cell & { path: string; bytes: number; primitives: OrderedMapDisplayPrimitive[]; groups: (string | null)[]; tracker: MapDisplayTileSizeTracker };
const FRAME_TARGET = 64 * 1024, RETAINED_BYTES = 4 * 1024 * 1024, FRAME_MAX = 4 * 1024 * 1024;
const keyOf = (p: OrderedMapDisplayPrimitive) => ({ zIndex: p.zIndex, elementId: p.elementId, fragmentOrder: p.fragmentOrder });

/** Input is monotonic within each canonical layer. Tiny compressed per-cell
 * runs decouple eviction from public part boundaries: a sparse layer does not
 * consume its own file/part, and no dense cell is retained whole. Runs are
 * consumed once, one bounded frame/asset at a time, then deleted. */
export function createMapDisplayPageWriter(options: OrderedPageWriterOptions) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "map-display-pages-"));
  const maximum = Math.min(options.maximumByteSize ?? MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES, MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES);
  const target = Math.min(options.assetTargetBytes ?? MAP_DISPLAY_ORDERED_ASSET_TARGET_BYTES, maximum);
  const pageTarget = Math.min(options.pageTargetBytes ?? MAP_DISPLAY_PAGE_TARGET_BYTES, maximum);
  if (![maximum, target, pageTarget].every(n => Number.isSafeInteger(n) && n >= 52)) throw new Error("invalid ordered page byte limit");
  const runs = new Map<string, Run>(), layers = new Map<string, string>();
  let retained = 0, physical = 0, decoded = 0, finished = false;
  const flush = (run: Run) => {
    if (!run.primitives.length) return;
    // These are this writer's fresh typed producer records, not external CDTL.
    // Avoid re-running the public schema parser over the entire scene on replay.
    // JSON preserves doubles exactly; independent gzip frames verify CRC/length.
    const frame = Buffer.from(JSON.stringify([run.groups, run.primitives]));
    if (frame.length > FRAME_MAX) throw new Error("ordered page run frame limit exceeded");
    const compressed = gzipSync(frame, { level: 1 });
    const header = Buffer.alloc(8); header.writeUInt32LE(compressed.length); header.writeUInt32LE(frame.length, 4);
    const size = compressed.length + 8;
    if (physical + size > CAD_SCENE_MAX_TOTAL_TILE_BYTES - 64 * 1024 * 1024 ||
      decoded + run.tracker.byteSize > CAD_SCENE_MAX_TOTAL_TILE_BYTES) throw new Error("ordered page temporary budget exceeded");
    options.claimBytes?.(size);
    writeFileSync(run.path, Buffer.concat([header, compressed]), { flag: run.bytes ? "a" : "wx", mode: 0o600 });
    physical += size; decoded += run.tracker.byteSize; run.bytes += size;
    retained -= run.tracker.byteSize; run.primitives = []; run.groups = []; run.tracker = new MapDisplayTileSizeTracker(maximum);
  };
  const dispose = () => {
    for (const run of runs.values()) {
      rmSync(run.path, { force: true });
      if (run.bytes) options.claimBytes?.(-run.bytes);
      run.bytes = 0;
    }
    runs.clear(); retained = 0;
    if (!options.directory) rmSync(directory, { recursive: true, force: true });
  };
  function* readRun(run: Run): Generator<Record> {
    const fd = openSync(run.path, "r"); let total = 0;
    const read = (n: number) => {
      const bytes = Buffer.allocUnsafe(n); let offset = 0;
      while (offset < n) { const size = readSync(fd, bytes, offset, n - offset, null); if (!size) throw new Error("truncated ordered page run"); offset += size; }
      total += n; return bytes;
    };
    try {
      while (total < run.bytes) {
        options.checkBudget?.();
        const header = read(8), compressed = header.readUInt32LE(0), size = header.readUInt32LE(4);
        if (size > FRAME_MAX || compressed > FRAME_MAX + 1024 || compressed > run.bytes - total) throw new Error("invalid ordered page run length");
        const frame = gunzipSync(read(compressed), { maxOutputLength: size });
        if (frame.length !== size) throw new Error("ordered page run size mismatch");
        const [groups, primitives]: [(string | null)[], OrderedMapDisplayPrimitive[]] = JSON.parse(frame.toString("utf8"));
        if (groups.length !== primitives.length) throw new Error("ordered page run count mismatch");
        for (let i = 0; i < primitives.length; i++) yield { primitive: primitives[i], paintGroup: groups[i] ?? undefined };
      }
    } finally { closeSync(fd); }
  }
  return {
    dispose,
    append(cell: Cell, primitive: OrderedMapDisplayPrimitive, layerId: string, paintGroup?: string) {
      if (finished) throw new Error("ordered page writer finished");
      const previous = layers.get(primitive.layerName);
      if (previous !== undefined && previous !== layerId) throw new Error("ordered page layer binding conflict");
      layers.set(primitive.layerName, layerId);
      const key = `${cell.lod}:${cell.tileY}:${cell.tileX}`;
      let run = runs.get(key);
      if (!run) {
        run = { ...cell, path: join(directory, `${randomUUID()}.ordered-run`), bytes: 0, primitives: [], groups: [], tracker: new MapDisplayTileSizeTracker(maximum) };
        runs.set(key, run);
      }
      const before = run.tracker.byteSize;
      if (!run.tracker.tryAdd(primitive)) { flush(run); if (!run.tracker.tryAdd(primitive)) throw new Error("ordered primitive exceeds asset hard limit"); retained += run.tracker.byteSize; }
      else retained += run.primitives.length ? run.tracker.byteSize - before : run.tracker.byteSize;
      run.primitives.push(primitive); run.groups.push(paintGroup ?? null);
      if (run.tracker.byteSize >= FRAME_TARGET) flush(run);
      if (retained >= RETAINED_BYTES) for (const pending of runs.values()) flush(pending);
    },
    *finish(): Generator<{ descriptor: MapDisplayTile; payload: Buffer }> {
      if (finished) throw new Error("ordered page writer finished"); finished = true;
      let totalBytes = 0, parts = 0, metadataBytes = 0;
      try {
        for (const run of runs.values()) flush(run);
        for (const run of [...runs.values()].sort((a, b) => a.lod - b.lod || a.tileY - b.tileY || a.tileX - b.tileX)) {
          const sequence = new Map<string, number>(), lastKeys = new Map<string, ReturnType<typeof keyOf>>();
          const groups = new Map<string, { id: string; sequence: number }>();
          let part = 0, batch: Record[] = [], tracker = new MapDisplayTileSizeTracker(maximum);
          const encode = (nextGroup?: string) => {
            options.checkBudget?.();
            batch.sort((a, b) => {
              const left = layers.get(a.primitive.layerName)!, right = layers.get(b.primitive.layerName)!;
              return (left < right ? -1 : left > right ? 1 : 0) || compareMapDisplayFragmentKeys(a.primitive, b.primitive);
            });
            const primitives = batch.map(r => r.primitive), pages: MapDisplayPage[] = [];
            for (let start = 0; start < batch.length;) {
              const first = batch[start], layerId = layers.get(first.primitive.layerName)!;
              const pageTracker = new MapDisplayTileSizeTracker(maximum); let end = start, points = 0;
              while (end < batch.length && layers.get(batch[end].primitive.layerName) === layerId && batch[end].paintGroup === first.paintGroup) {
                if (end > start && pageTracker.byteSize >= pageTarget) break;
                if (!pageTracker.tryAdd(batch[end].primitive)) break;
                points += mapDisplayPathPointCount(batch[end].primitive); end++;
              }
              if (end === start) throw new Error("ordered page primitive cannot fit");
              const firstKey = keyOf(first.primitive), lastKey = keyOf(batch[end - 1].primitive), previous = lastKeys.get(layerId);
              if (previous && compareMapDisplayFragmentKeys(previous, firstKey) >= 0) throw new Error("ordered page input order mismatch");
              const page: MapDisplayPage = { layerId, sequence: sequence.get(layerId) ?? 0, primitiveStart: start,
                primitiveCount: end - start, firstKey, lastKey };
              sequence.set(layerId, page.sequence + 1); lastKeys.set(layerId, lastKey);
              if (first.paintGroup) {
                const previousGroup = groups.get(layerId);
                const continues = batch[end]?.paintGroup === first.paintGroup || nextGroup === first.paintGroup;
                const groupSequence = previousGroup?.id === first.paintGroup ? previousGroup.sequence + 1 : 0;
                page.paintGroup = { id: first.paintGroup, elementId: first.primitive.elementId, phase: "fill",
                  style: { fillColor: first.primitive.style.fillColor!, opacity: first.primitive.style.opacity },
                  sequence: groupSequence, final: !continues, pointCount: points };
                if (continues) groups.set(layerId, { id: first.paintGroup, sequence: groupSequence }); else groups.delete(layerId);
              }
              pages.push(page); start = end;
            }
            if (part >= (options.maximumPartsPerCell ?? CAD_SCENE_MAX_PARTS_PER_TILE) || ++parts > (options.maximumPartCount ?? CAD_SCENE_MAX_TILE_PART_COUNT)) throw new Error("ordered page part limit exceeded");
            const payload = encodeTrustedMapDisplayTile(primitives);
            if (payload.length > maximum || (totalBytes += payload.length) > (options.maximumTotalByteSize ?? CAD_SCENE_MAX_TOTAL_TILE_BYTES)) throw new Error("ordered page output byte limit exceeded");
            const descriptor: MapDisplayTile = { version: 2, sceneId: options.sceneId, tileX: run.tileX, tileY: run.tileY, lod: run.lod, part,
              assetId: options.tileAssetId?.({ tileX: run.tileX, tileY: run.tileY, lod: run.lod, part }) ?? randomUUID(),
              ...getCadSceneTileIntegrity(payload), primitiveCount: primitives.length, pages,
              bounds: { minX: run.tileX * 512, minY: run.tileY * 512, maxX: Math.min(options.width, (run.tileX + 1) * 512), maxY: Math.min(options.height, (run.tileY + 1) * 512) } };
            metadataBytes += Buffer.byteLength(JSON.stringify(descriptor)) + 1;
            if (metadataBytes > CAD_SCENE_MAX_MANIFEST_BYTES - 2048) throw new Error("ordered page manifest byte limit exceeded");
            validateMapDisplayPageContent(descriptor, primitives, name => layers.get(name));
            part++; batch = []; tracker = new MapDisplayTileSizeTracker(maximum);
            return { descriptor, payload };
          };
          for (const record of readRun(run)) {
            if (batch.length && tracker.byteSize >= target) yield encode(record.paintGroup);
            if (!tracker.tryAdd(record.primitive)) { yield encode(record.paintGroup); if (!tracker.tryAdd(record.primitive)) throw new Error("ordered primitive exceeds asset hard limit"); }
            batch.push(record);
          }
          if (batch.length) yield encode();
          rmSync(run.path, { force: true });
          options.claimBytes?.(-run.bytes); run.bytes = 0;
        }
      } finally { dispose(); }
    }
  };
}
