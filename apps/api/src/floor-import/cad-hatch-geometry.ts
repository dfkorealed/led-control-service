import { GluTesselator, gluEnum, windingRule, primitiveType } from "libtess";
import { xor, union, type MultiPolygon, type Polygon } from "polygon-clipping";
import { getMapPolygonValidationError, MAP_ELEMENT_MAX_POINTS, type Point } from "@led-control/shared";

export interface CadHatchPolygon { outer: Point[]; holes: Point[][] }
export interface CadHatchRegion {
  boundary: CadHatchPolygon;
  /** Keep sub-ULP intersections local when adding the world origin collapses them. */
  origin?: Point;
  /** More than one part is needed when a hole touches another boundary. */
  parts: CadHatchPolygon[];
}

function checkPoints(polygons: MultiPolygon): void {
  let count = 0;
  for (const polygon of polygons) for (const ring of polygon) {
    count += ring.length;
    if (count > MAP_ELEMENT_MAX_POINTS) throw new Error("CAD HATCH boolean point limit exceeded");
    for (const p of ring) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error("Invalid CAD HATCH coordinate");
  }
}

const coordinates = ({ outer, holes }: CadHatchPolygon): Polygon => [outer, ...holes].map(ring => ring.map(p => [p.x, p.y]));
const ringArea = (ring: readonly Point[]) => Math.abs(ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length], origin = ring[0];
  return sum + (p.x - origin.x) * (q.y - origin.y) - (q.x - origin.x) * (p.y - origin.y);
}, 0)) / 2;
const polygonArea = (p: CadHatchPolygon) => ringArea(p.outer) - p.holes.reduce((sum, h) => sum + ringArea(h), 0);
function polygonPoints(polygon: Polygon): CadHatchPolygon {
  const rings = polygon.map(ring => {
    const result = ring.map(([x, y]) => ({ x, y }));
    const first = result[0], last = result[result.length - 1];
    if (first.x === last.x && first.y === last.y) result.pop();
    return result;
  });
  return { outer: rings[0], holes: rings.slice(1) };
}

// Bound aggregate inputs/intermediates as well as each shared-schema element.
// Balanced pairs avoid argument-stack limits and repeatedly scanning a growing union.
function combine(inputs: MultiPolygon[], operation: typeof xor): MultiPolygon {
  let level = inputs;
  let work = 0;
  while (level.length > 1) {
    const next: MultiPolygon[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const result = i + 1 < level.length ? operation(level[i], level[i + 1]) : level[i];
      checkPoints(result);
      for (const polygon of result) for (const ring of polygon) work += ring.length;
      if (work > 1_000_000) throw new Error("CAD HATCH boolean work limit exceeded");
      next.push(result);
    }
    level = next;
  }
  return level[0] ?? [];
}

/** GLU's sweep implements odd winding directly. Fan XOR introduces artificial
 * intersecting diagonals and tiny residual polygons for self-crossing contours. */
function tessellateOdd(rings: Point[][], boundaryOnly: boolean): Point[][] {
  const tess = new GluTesselator();
  const output: Point[][] = [];
  let current: Point[] = [], vertices = 0, intersections = 0;
  tess.gluTessNormal(0, 0, 1);
  tess.gluTessProperty(gluEnum.GLU_TESS_WINDING_RULE, windingRule.GLU_TESS_WINDING_ODD);
  tess.gluTessProperty(gluEnum.GLU_TESS_BOUNDARY_ONLY, boundaryOnly);
  // Registering edge flags disables strips/fans and requests independent triangles.
  if (!boundaryOnly) tess.gluTessCallback(gluEnum.GLU_TESS_EDGE_FLAG, () => {});
  tess.gluTessCallback(gluEnum.GLU_TESS_BEGIN, (type: number) => {
    if (type !== (boundaryOnly ? primitiveType.GL_LINE_LOOP : primitiveType.GL_TRIANGLES)) throw new Error("Invalid CAD HATCH tessellation primitive");
    current = [];
    if (boundaryOnly) output.push(current);
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_VERTEX, (point: Point) => {
    if (++vertices > MAP_ELEMENT_MAX_POINTS) throw new Error("CAD HATCH tessellation point limit exceeded");
    current.push(point);
    if (!boundaryOnly && current.length === 3) { output.push(current); current = []; }
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_COMBINE, (coords: number[]) => {
    if (++intersections > MAP_ELEMENT_MAX_POINTS) throw new Error("CAD HATCH tessellation intersection limit exceeded");
    return { x: coords[0], y: coords[1] };
  });
  tess.gluTessCallback(gluEnum.GLU_TESS_ERROR, (code: number) => { throw new Error(`CAD HATCH tessellation failed: ${code}`); });
  tess.gluTessBeginPolygon(null);
  for (const ring of rings) {
    tess.gluTessBeginContour();
    ring.forEach(p => tess.gluTessVertex([p.x, p.y, 0], p));
    tess.gluTessEndContour();
  }
  tess.gluTessEndPolygon();
  return output;
}

/** The tessellator is only a partitioner here. Verify its
 * output against the clipping result, including coverage and overlapping area. */
export function triangulateCadHatchPolygon(source: CadHatchPolygon): Point[][] {
  const origin = source.outer[0];
  const local = (ring: Point[]) => ring.map(p => ({ x: p.x - origin.x, y: p.y - origin.y }));
  const polygon = { outer: local(source.outer), holes: source.holes.map(local) };
  const input = coordinates(polygon);
  checkPoints([input]);
  const triangles: Point[][] = [];
  for (const triangle of tessellateOdd([polygon.outer, ...polygon.holes], false)) {
    if (ringArea(triangle) === 0) continue;
    const error = getMapPolygonValidationError(triangle, []);
    if (error) throw new Error(`Invalid CAD HATCH partition: ${error}`);
    triangles.push(triangle);
  }
  const merged = combine(triangles.map(outer => [coordinates({ outer, holes: [] })]), union);
  const difference = xor(input, merged);
  checkPoints(difference);
  const expectedArea = polygonArea(polygon);
  const tolerance = Math.max(1, expectedArea) * 1e-12;
  const actualArea = triangles.reduce((sum, ring) => sum + ringArea(ring), 0);
  if (!triangles.length || Math.abs(expectedArea - actualArea) > tolerance ||
      difference.reduce((sum, p) => sum + polygonArea(polygonPoints(p)), 0) > tolerance) {
    throw new Error(`CAD HATCH partition does not preserve filled geometry: expected=${expectedArea}, actual=${actualArea}, difference=${difference.reduce((sum, p) => sum + polygonArea(polygonPoints(p)), 0)}`);
  }
  return triangles.map(ring => ring.map(p => ({ x: p.x + origin.x, y: p.y + origin.y })));
}

/** DXF normal HATCH uses alternating fill across boundaries. Ring orientation
 * and a boundary's first vertex cannot determine containment at contacts. */
export function resolveCadHatchRegions(sourceRings: readonly Point[][]): CadHatchRegion[] {
  // Work relative to this HATCH bbox, not map/world magnitude: clipping's
  // binary64 coalescing must not erase thin but representable source differences.
  let minX = Infinity, minY = Infinity;
  for (const ring of sourceRings) for (const p of ring) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  const rings = sourceRings.map(ring => ring.map(p => ({ x: p.x - minX, y: p.y - minY })));
  const input: MultiPolygon = rings.map(outer => coordinates({ outer, holes: [] }));
  checkPoints(input);
  const normalized = rings.map((ring, index): MultiPolygon => {
    if (!getMapPolygonValidationError(ring, [])) return [input[index]];
    return combine(tessellateOdd([ring], true).map(outer => [coordinates({ outer, holes: [] })]), xor);
  });
  const result = combine(normalized, xor);
  return result.map(polygon => {
    const localBoundary = polygonPoints(polygon);
    const absolute = (ring: Point[]) => ring.map(p => ({ x: p.x + minX, y: p.y + minY }));
    const boundary = { outer: absolute(localBoundary.outer), holes: localBoundary.holes.map(absolute) };
    const error = getMapPolygonValidationError(boundary.outer, boundary.holes);
    if (!error) return { boundary, parts: [boundary] };
    if (!getMapPolygonValidationError(localBoundary.outer, localBoundary.holes)) {
      return { boundary: localBoundary, parts: [localBoundary], origin: { x: minX, y: minY } };
    }
    // Polygon clipping permits point-touching rings, unlike the common schema.
    // Partition that same area, keeping real boundary strokes separate from diagonals.
    const localParts = triangulateCadHatchPolygon(localBoundary).map(outer => ({ outer, holes: [] }));
    const parts = localParts.map(part => ({ outer: absolute(part.outer), holes: [] }));
    if (parts.some(part => getMapPolygonValidationError(part.outer, part.holes))) {
      return { boundary: localBoundary, parts: localParts, origin: { x: minX, y: minY } };
    }
    return { boundary, parts };
  });
}

/** Orientation/start-vertex independent key; coordinates are never quantized. */
export function cadHatchRingKey(ring: readonly Point[]): string {
  let start = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i].x < ring[start].x ||
    (ring[i].x === ring[start].x && ring[i].y < ring[start].y)) start = i;
  const direction = (step: number) => Array.from({ length: ring.length }, (_, i) => ring[(start + step * i + ring.length) % ring.length]);
  const forward = JSON.stringify(direction(1)), backward = JSON.stringify(direction(-1));
  return forward < backward ? forward : backward;
}
