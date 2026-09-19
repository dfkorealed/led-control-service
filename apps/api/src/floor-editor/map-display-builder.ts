import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { CadScenePrimitive, MapDocumentRef, MapElement, Point, getMapElementBounds, transformMapPoint } from "@led-control/shared";
import { MAP_DISPLAY_VERSION, MapDisplayManifest, MapDisplayTile, OrderedMapDisplayPrimitive, nativeMapDisplayManifestSchema } from "@led-control/shared";
import { appendPrimitiveToTiles, splitOversizedPolyline, TilePrimitiveAccumulator } from "../floor-import/cad-scene-builder";
import { createMapDisplayPageWriter } from "../floor-import/map-display-page-writer";
import { sortMapDisplayElements } from "../floor-import/map-display-element-sort";
import { triangulateCadHatchPolygon } from "../floor-import/cad-hatch-geometry";

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
  const directory = await mkdtemp(join(tmpdir(), "map-display-checkpoint-"));
  let physicalBytes = 0, primitiveCount = 0;
  const claim = (bytes: number) => {
    if (physicalBytes + bytes > 448 * 1024 * 1024) throw new Error("map display temporary byte budget exceeded");
    physicalBytes += bytes;
  };
  const writer = createMapDisplayPageWriter({ directory, sceneId: ref.generationId, width: ref.width,
    height: ref.height, claimBytes: claim, checkBudget: budget });
  const descriptors: MapDisplayTile[] = [], scratch = new Map<string, TilePrimitiveAccumulator>();
  try {
  for await (const element of sortMapDisplayElements(elements, directory, claim, budget, ref.elementCount)) {
    let fragmentOrder = 0;
    for (const primitive of primitives(element)) {
      if (++primitiveCount > 1_000_000) throw new Error("map display primitive count budget exceeded");
      for (const fragment of splitOversizedPolyline(primitive)) {
        const ordered: OrderedMapDisplayPrimitive = { ...fragment, zIndex: element.zIndex, fragmentOrder: 0 };
        const paintGroup = fragment.type === "triangle" && fragment.style.fillColor !== null && fragment.style.strokeColor === null ? element.id : undefined;
        appendPrimitiveToTiles(ordered, ref.width, ref.height, scratch, undefined, {
          nextFragmentOrder: () => fragmentOrder++,
          consume: (occurrence, cell) => writer.append(cell, occurrence as OrderedMapDisplayPrimitive, element.layerId, paintGroup)
        });
      }
    }
  }
  for (const tile of writer.finish()) { budget(); await write(tile); descriptors.push(tile.descriptor); await setImmediate(); }
  descriptors.sort((a, b) => a.lod - b.lod || a.tileY - b.tileY || a.tileX - b.tileX || a.part - b.part);
  const body = { version: MAP_DISPLAY_VERSION, sceneId: ref.generationId, regionId: ref.generationId, manifestAssetId,
    orderedPages: { version: 1 as const },
    width: ref.width, height: ref.height, gridSize: ref.gridSize, padding: 0, tileSize: 512 as const,
    lodMode: "additive" as const, primitiveCount, tileCount: descriptors.length,
    sourceBounds: { minX: 0, minY: 0, maxX: ref.width, maxY: ref.height },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: descriptors };
  const bytes = Buffer.from(JSON.stringify(body));
  return nativeMapDisplayManifestSchema.parse({ ...body, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  } finally { writer.dispose(); await rm(directory, { recursive: true, force: true }); }
}
