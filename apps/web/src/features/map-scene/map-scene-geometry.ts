import type { CadScenePrimitive } from "@led-control/shared";
import type { MapElement, Point } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds, transformMapPoint } from "@led-control/shared/map-document-geometry";
import earcut from "earcut";
import { buildCadGeometryBatches, type CadGeometryBuildResult } from "../cad-scene/cad-scene-worker";

const MAX_DRAFT_POINTS = 131_072;
const MAX_CURVE_SEGMENTS = 4096;
const box = (p: Point, w: number, h: number): Point[] => [p,
  { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }];

export function mapElementPaths(element: MapElement, zoom: number): { rings: Point[][]; closed: boolean } {
  let rings: Point[][];
  let closed = true;
  switch (element.type) {
    case "line": rings = [[element.geometry.start, element.geometry.end]]; closed = false; break;
    case "rectangle": rings = [box(element.geometry.origin, element.geometry.width, element.geometry.height)]; break;
    case "text": rings = [box(element.geometry.position, element.geometry.width, element.geometry.height)]; break;
    case "triangle": rings = [element.geometry.points]; break;
    case "polyline": rings = [element.geometry.points]; closed = false; break;
    case "polygon": rings = [element.geometry.outer, ...element.geometry.holes]; break;
    case "ellipse":
    case "arc": {
      const ellipse = element.type === "ellipse";
      const rx = ellipse ? element.geometry.radiusX : element.geometry.radius;
      const ry = ellipse ? element.geometry.radiusY : element.geometry.radius;
      const radius = Math.max(rx * element.transform.scaleX, ry * element.transform.scaleY);
      const normalize = (angle: number) => ((angle % 360) + 360) % 360;
      const start = ellipse ? 0 : normalize(element.geometry.startAngle);
      const sweep = ellipse ? 360 : element.geometry.counterClockwise
        ? normalize(element.geometry.endAngle - start) || 360
        : -(normalize(start - element.geometry.endAngle) || 360);
      const step = 2 * Math.acos(Math.max(-1, 1 - Math.min(radius, 0.25 / zoom) / radius));
      const segments = Math.max(4, Math.ceil(Math.abs(sweep) * Math.PI / 180 / step));
      if (!Number.isFinite(segments) || segments > MAX_CURVE_SEGMENTS) {
        throw new RangeError("Map draft curve exceeds the bounded tessellation budget");
      }
      rings = [Array.from({ length: segments + (ellipse ? 0 : 1) }, (_, index) => {
        const angle = (start + sweep * index / segments) * Math.PI / 180;
        return { x: element.geometry.center.x + rx * Math.cos(angle), y: element.geometry.center.y + ry * Math.sin(angle) };
      })];
      closed = ellipse;
    }
  }
  return { rings: rings.map(ring => ring.map(point => transformMapPoint(point, element.transform))), closed };
}

/** Local drafts only. Overview data stays in the existing compact tile worker. */
export function buildMapGeometryBatches(elements: readonly MapElement[], zoomBand: number, nativePaint = false): CadGeometryBuildResult {
  if (!(zoomBand > 0) || !Number.isFinite(zoomBand)) throw new RangeError("Invalid map zoom band");
  if (nativePaint) {
    let points = 0;
    for (const element of elements) {
      if (element.type === "text") continue;
      points += mapElementPaths(element, zoomBand).rings.reduce((sum, ring) => sum + ring.length, 0);
      if (points > MAX_DRAFT_POINTS) throw new RangeError("Map draft point budget exceeded");
    }
    // Canonical objects are already owned/accounted by the bounded draft or
    // persisted overlay. The display cache retains only these references.
    return { nativeDrafts: elements, batches: [], textBatches: [], pickEntries: [], pickPoints: new Float32Array(),
      spatialIndex: { cellSize: 64, buckets: {} }, memory: { cpuBytes: 256 + elements.length * 8, gpuBytes: 0, textAtlasBytes: 0 } };
  }
  const primitives: CadScenePrimitive[] = [];
  let pointCount = 0;
  for (const element of [...elements].sort((a, b) => a.zIndex - b.zIndex)) {
    if (!element.visible || element.style.opacity === 0) continue;
    const base = { elementId: element.id, groupId: element.groupId, layerName: element.layerId,
      sourceType: element.type, bounds: getMapElementBounds(element), clipBounds: null, style: element.style };
    if (element.type === "text") {
      const geometry = element.geometry;
      // Canonical text starts at the top-left; the existing atlas uses a
      // bottom-left baseline. Translate before the one canonical transform.
      primitives.push({ ...base, type: "text", geometry: {
        ...geometry, position: transformMapPoint({ x: geometry.position.x, y: geometry.position.y + geometry.height }, element.transform),
        width: geometry.width * element.transform.scaleX, height: geometry.height * element.transform.scaleY,
        fontSize: geometry.fontSize * element.transform.scaleY, rotation: element.transform.rotation
      } });
      continue;
    }
    const { rings, closed } = mapElementPaths(element, zoomBand);
    pointCount += rings.reduce((sum, ring) => sum + ring.length, 0);
    if (pointCount > MAX_DRAFT_POINTS) throw new RangeError("Map draft point budget exceeded");
    if (rings.length === 1) {
      primitives.push({ ...base, type: "polyline", geometry: { points: rings[0], closed } });
      continue;
    }
    // Earcut sees every ring together. Triangles are a derived CPU input to
    // style batches, never new element IDs, scene nodes, or canonical shapes.
    if (element.style.fillColor !== null) {
      const points = rings.flat();
      const holes: number[] = [];
      let offset = rings[0].length;
      for (const ring of rings.slice(1)) { holes.push(offset); offset += ring.length; }
      const indices = earcut(points.flatMap(point => [point.x, point.y]), holes);
      for (let i = 0; i < indices.length; i += 3) primitives.push({ ...base, type: "triangle",
        style: { ...element.style, strokeColor: null },
        geometry: { points: [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]] } });
    }
    for (const ring of rings) primitives.push({ ...base, type: "polyline",
      style: { ...element.style, fillColor: null }, geometry: { points: ring, closed: true } });
  }
  // Draft picking uses bounded canonical paths. Building the legacy AABB grid
  // here would expand one map-wide polygon into hundreds of thousands of cells.
  return buildCadGeometryBatches(primitives, undefined, { includePickIndex: false });
}

export function hitMapElement(element: MapElement, point: Point, radius: number, zoom = 1): boolean {
  if (!element.visible || element.style.opacity === 0) return false;
  const { rings, closed } = mapElementPaths(element, zoom);
  if (closed && (element.type === "text" || element.style.fillColor !== null) &&
      inside(point, rings[0]) && !rings.slice(1).some(ring => inside(point, ring))) return true;
  if (element.style.strokeColor === null || element.style.strokeWidth <= 0) return false;
  const tolerance = radius + element.style.strokeWidth / 2;
  return rings.some(ring => {
    const length = ring.length - (closed ? 0 : 1);
    for (let i = 0; i < length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= tolerance) return true;
    }
    return false;
  });
}

function inside(point: Point, ring: readonly Point[]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
