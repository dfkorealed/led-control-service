import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { CAD_SCENE_MAX_PARTS_PER_TILE, CAD_SCENE_MAX_TILE_PART_COUNT, CAD_SCENE_MAX_TOTAL_TILE_BYTES,
  CadScenePrimitive, MapDocumentRef, MapElement, Point, getMapElementBounds, transformMapPoint } from "@led-control/shared";
import { MAP_DISPLAY_VERSION, MapDisplayManifest, MapDisplayTile, OrderedMapDisplayPrimitive, nativeMapDisplayManifestSchema } from "@led-control/shared";
import { appendPrimitiveToTiles, splitOversizedPolyline,
  TilePrimitiveAccumulator, TilePartLimits } from "../floor-import/cad-scene-builder";
import { MapDisplayTileSizeTracker, encodeTrustedMapDisplayTile, getCadSceneTileIntegrity } from "../floor-import/cad-scene-codec";
import { triangulateCadHatchPolygon } from "../floor-import/cad-hatch-geometry";

const RETAINED_BYTES = 8 * 1024 * 1024, PENDING_BYTES = 32 * 1024 * 1024;
export interface BuiltMapDisplayTile { descriptor: MapDisplayTile; payload: Buffer }
const box = (p: Point, w: number, h: number) => [p, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }];

function* primitives(element: MapElement): Generator<CadScenePrimitive> {
  const base = { elementId: element.id, groupId: element.groupId, layerName: element.layerId,
    sourceType: element.type, bounds: getMapElementBounds(element), clipBounds: null,
    style: { ...element.style, opacity: element.visible ? element.style.opacity : 0 } };
  const transform = (points: Point[]) => points.map(point => transformMapPoint(point, element.transform));
  if (element.type === "text") {
    const g = element.geometry;
    yield { ...base, type: "text", geometry: { ...g,
      position: transformMapPoint({ x: g.position.x, y: g.position.y + g.height }, element.transform),
      width: g.width * element.transform.scaleX, height: g.height * element.transform.scaleY,
      fontSize: g.fontSize * element.transform.scaleY, rotation: element.transform.rotation } }; return;
  }
  let rings: Point[][], closed = true;
  switch (element.type) {
    case "line": rings = [[element.geometry.start, element.geometry.end]]; closed = false; break;
    case "rectangle": rings = [box(element.geometry.origin, element.geometry.width, element.geometry.height)]; break;
    case "triangle": rings = [element.geometry.points]; break;
    case "polyline": rings = [element.geometry.points]; closed = false; break;
    case "polygon": rings = [element.geometry.outer, ...element.geometry.holes]; break;
    case "ellipse":
    case "arc": {
      const g = element.geometry, ellipse = element.type === "ellipse";
      const rx = ellipse ? element.geometry.radiusX : element.geometry.radius;
      const ry = ellipse ? element.geometry.radiusY : element.geometry.radius;
      const radius = Math.max(rx * element.transform.scaleX, ry * element.transform.scaleY);
      const normalize = (angle: number) => ((angle % 360) + 360) % 360;
      const start = ellipse ? 0 : normalize(element.geometry.startAngle);
      const sweep = ellipse ? 360 : element.geometry.counterClockwise
        ? normalize(element.geometry.endAngle - start) || 360 : -(normalize(start - element.geometry.endAngle) || 360);
      const step = 2 * Math.acos(Math.max(-1, 1 - Math.min(radius, 0.05) / radius));
      const segments = Math.max(4, Math.ceil(Math.abs(sweep) * Math.PI / 180 / step));
      if (!Number.isFinite(segments) || segments > 4096) throw new Error("map display curve tessellation budget exceeded");
      rings = [Array.from({ length: segments + (ellipse ? 0 : 1) }, (_, i) => {
        const angle = (start + sweep * i / segments) * Math.PI / 180;
        return { x: g.center.x + rx * Math.cos(angle), y: g.center.y + ry * Math.sin(angle) };
      })]; closed = ellipse;
    }
  }
  const paths = rings.map(transform);
  // Closed fills are triangulated once, not independently per ring, so holes
  // remain holes. Existing CAD clipping/codec handles the resulting primitives.
  if (closed && element.style.fillColor !== null) {
    for (const points of triangulateCadHatchPolygon({ outer: paths[0], holes: paths.slice(1) })) {
      yield { ...base, type: "triangle", style: { ...base.style, strokeColor: null },
        geometry: { points: points as [Point, Point, Point] } };
    }
  }
  for (const points of paths) yield { ...base, type: "polyline", style: { ...base.style, fillColor: null }, geometry: { points, closed } };
}

/** Streams uploads with bounded retained primitives and encoded output. The CAD
 * writer is reused below normalization: dimensions and coordinates are identity.
 * No encoded whole-scene array is retained after the sink acknowledges a tile. */
export async function buildMapDisplay(ref: MapDocumentRef, elements: AsyncIterable<MapElement>,
  write: (tile: BuiltMapDisplayTile) => Promise<void>, check = () => {}): Promise<MapDisplayManifest> {
  const deadline = Date.now() + 5 * 60_000, manifestAssetId = randomUUID();
  const budget = () => { check(); if (Date.now() > deadline) throw new Error("map display deadline exceeded"); };
  const accumulators = new Map<string, TilePrimitiveAccumulator>(), descriptors: MapDisplayTile[] = [], pending: BuiltMapDisplayTile[] = [];
  const limits: TilePartLimits = { maximumByteSize: 8 * 1024 * 1024, maximumPartsPerCell: CAD_SCENE_MAX_PARTS_PER_TILE,
    maximumPartCount: CAD_SCENE_MAX_TILE_PART_COUNT, maximumTotalByteSize: CAD_SCENE_MAX_TOTAL_TILE_BYTES };
  let totalByteSize = 0;
  let retained = 0, pendingBytes = 0, count = 0, primitiveCount = 0;
  const flush = (tile: TilePrimitiveAccumulator) => {
    let tracker = new MapDisplayTileSizeTracker(limits.maximumByteSize), batch: OrderedMapDisplayPrimitive[] = [];
    const encode = () => {
      if (!batch.length) return;
      if (tile.nextPart >= limits.maximumPartsPerCell || descriptors.length + pending.length >= limits.maximumPartCount) throw new Error("map display descriptor budget exceeded");
      const payload = encodeTrustedMapDisplayTile(batch);
      if (payload.length !== tracker.byteSize || (totalByteSize += payload.length) > limits.maximumTotalByteSize) throw new Error("map display encoded budget exceeded");
      pendingBytes += payload.length;
      if (pendingBytes > PENDING_BYTES) throw new Error("map display pending byte budget exceeded");
      pending.push({ payload, descriptor: { version: MAP_DISPLAY_VERSION, sceneId: ref.generationId,
        tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.nextPart++, assetId: randomUUID(),
        primitiveCount: batch.length, ...getCadSceneTileIntegrity(payload),
        bounds: { minX: tile.tileX * 512, minY: tile.tileY * 512, maxX: Math.min(ref.width, (tile.tileX + 1) * 512),
          maxY: Math.min(ref.height, (tile.tileY + 1) * 512) } } });
      tracker = new MapDisplayTileSizeTracker(limits.maximumByteSize); batch = [];
    };
    for (let i = 0; i < tile.primitives.length; i++) {
      const primitive = tile.primitives[i] as OrderedMapDisplayPrimitive; tile.primitives[i] = null;
      if (!tracker.tryAdd(primitive)) {
        encode(); if (!tracker.tryAdd(primitive)) throw new Error("map display primitive exceeds tile budget");
      }
      batch.push(primitive);
    }
    tile.primitives.length = 0; encode();
  };
  const drain = async () => {
    for (const tile of pending) { budget(); await write(tile); descriptors.push(tile.descriptor); }
    pending.length = 0; pendingBytes = 0; await setImmediate();
  };
  for await (const element of elements) {
    budget(); if (++count > 500_000) throw new Error("map display canonical count budget exceeded");
    let fragmentOrder = 0;
    for (const primitive of primitives(element)) {
      if (++primitiveCount > 1_000_000) throw new Error("map display primitive count budget exceeded");
      for (const fragment of splitOversizedPolyline(primitive)) {
        const estimate = Buffer.byteLength(JSON.stringify(fragment)) + 256;
        const ordered: OrderedMapDisplayPrimitive = { ...fragment, zIndex: element.zIndex, fragmentOrder: fragmentOrder++ };
        appendPrimitiveToTiles(ordered, ref.width, ref.height, accumulators, added => {
          retained += added * estimate;
          if (retained >= RETAINED_BYTES) {
            for (const tile of accumulators.values()) if (tile.primitives.length) flush(tile);
            retained = 0;
          }
        });
        await drain();
      }
    }
  }
  if (count !== ref.elementCount) throw new Error("map display canonical count mismatch");
  for (const tile of accumulators.values()) if (tile.primitives.length) { flush(tile); await drain(); }
  descriptors.sort((a, b) => a.lod - b.lod || a.tileY - b.tileY || a.tileX - b.tileX || a.part - b.part);
  const body = { version: MAP_DISPLAY_VERSION, sceneId: ref.generationId, regionId: ref.generationId, manifestAssetId,
    width: ref.width, height: ref.height, gridSize: ref.gridSize, padding: 0, tileSize: 512 as const,
    lodMode: "additive" as const, primitiveCount, tileCount: descriptors.length,
    sourceBounds: { minX: 0, minY: 0, maxX: ref.width, maxY: ref.height },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: descriptors };
  const bytes = Buffer.from(JSON.stringify(body));
  return nativeMapDisplayManifestSchema.parse({ ...body, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
