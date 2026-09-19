import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultDeserializer, serialize } from "node:v8";
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
type FrameHeader = Pick<OrderedMapDisplayPrimitive, "type" | "elementId" | "groupId" | "layerName" | "sourceType" | "zIndex" | "style" | "clipBounds"> & { paintGroup: string | null };
type FrameRecord = [number, number, OrderedMapDisplayPrimitive["bounds"], OrderedMapDisplayPrimitive["geometry"]];
type Frame = { codec: "v8-display-records"; version: 1; headers: FrameHeader[]; records: FrameRecord[] };

const sameBounds = (a: FrameHeader["clipBounds"], b: FrameHeader["clipBounds"]) => a === b || Boolean(a && b &&
  Object.is(a.minX, b.minX) && Object.is(a.minY, b.minY) && Object.is(a.maxX, b.maxX) && Object.is(a.maxY, b.maxY));

function encodeRunFrame(run: Run): Buffer {
  const headers: FrameHeader[] = [], records: FrameRecord[] = [], latest = new Map<string, number>();
  for (let i = 0; i < run.primitives.length; i++) {
    const p = run.primitives[i], group = run.groups[i];
    let index = latest.get(p.elementId);
    const h = index === undefined ? undefined : headers[index];
    if (!h || h.type !== p.type || h.groupId !== p.groupId || h.layerName !== p.layerName || h.sourceType !== p.sourceType ||
        h.zIndex !== p.zIndex || h.paintGroup !== group || !sameBounds(h.clipBounds, p.clipBounds) ||
        h.style.strokeColor !== p.style.strokeColor || h.style.fillColor !== p.style.fillColor ||
        !Object.is(h.style.strokeWidth, p.style.strokeWidth) || !Object.is(h.style.opacity, p.style.opacity)) {
      index = headers.length;
      headers.push({ type: p.type, elementId: p.elementId, groupId: p.groupId, layerName: p.layerName,
        sourceType: p.sourceType, zIndex: p.zIndex, style: p.style, clipBounds: p.clipBounds, paintGroup: group });
      latest.set(p.elementId, index);
    }
    records.push([index!, p.fragmentOrder, p.bounds, p.geometry]);
  }
  // Private scratch only: written/read by this writer in the same process. V8
  // preserves doubles and shared values without repeatedly stringifying headers;
  // neither these bytes nor a V8-version dependency escape into stored assets.
  return serialize({ codec: "v8-display-records", version: 1, headers, records } satisfies Frame);
}

function decodeRunFrame(bytes: Buffer): Frame {
  const decoder = new DefaultDeserializer(bytes);
  decoder.readHeader();
  const frame = decoder.readValue() as Frame;
  // deserialize() alone accepts trailing bytes. A frame contains exactly one
  // value, so even CRC-valid padding or another serialized value is rejected.
  let exhausted = false;
  try { decoder.readRawBytes(1); } catch { exhausted = true; }
  if (!exhausted) throw new Error("trailing ordered page frame data");
  if (!frame || frame.codec !== "v8-display-records" || frame.version !== 1) throw new Error("invalid ordered page frame version");
  if (!Array.isArray(frame.headers) || !Array.isArray(frame.records) || !frame.headers.length ||
      !frame.records.length || frame.headers.length > frame.records.length) throw new Error("invalid ordered page frame records");
  return frame;
}

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
    // Fresh typed producer records, not external CDTL. Independent bounded gzip
    // frames retain CRC/length checks; final public encoding validates ordering.
    const frame = encodeRunFrame(run);
    if (frame.length > FRAME_MAX) throw new Error("ordered page run frame limit exceeded");
    const compressed = gzipSync(frame, { level: 1 });
    const header = Buffer.alloc(8); header.writeUInt32LE(compressed.length); header.writeUInt32LE(frame.length, 4);
    const size = compressed.length + 8;
    if (physical + size > CAD_SCENE_MAX_TOTAL_TILE_BYTES - 64 * 1024 * 1024 ||
      decoded + run.tracker.byteSize > CAD_SCENE_MAX_TOTAL_TILE_BYTES) throw new Error("ordered page temporary budget exceeded");
    options.claimBytes?.(size);
    const flag = run.bytes ? "a" : "wx";
    // A failed write can leave a partial frame. Register the entire reservation
    // before I/O so failure cleanup removes the file and releases it exactly once.
    run.bytes += size;
    try { writeFileSync(run.path, Buffer.concat([header, compressed]), { flag, mode: 0o600 }); }
    catch (error) { finished = true; dispose(); throw error; }
    physical += size; decoded += run.tracker.byteSize;
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
        const { headers, records } = decodeRunFrame(frame);
        for (const record of records) {
          if (!Array.isArray(record) || record.length !== 4 || !Number.isInteger(record[0]) ||
              record[0] < 0 || record[0] >= headers.length) throw new Error("invalid ordered page frame header reference");
          const header = headers[record[0]];
          yield { primitive: { type: header.type, elementId: header.elementId, groupId: header.groupId,
            layerName: header.layerName, sourceType: header.sourceType, zIndex: header.zIndex, style: header.style,
            clipBounds: header.clipBounds, fragmentOrder: record[1], bounds: record[2], geometry: record[3] } as OrderedMapDisplayPrimitive,
            paintGroup: header.paintGroup ?? undefined };
        }
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
