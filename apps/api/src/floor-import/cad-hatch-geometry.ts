import earcut from "earcut";
import { xor, union, type MultiPolygon, type Polygon } from "polygon-clipping";
import { getMapPolygonValidationError, MAP_ELEMENT_MAX_POINTS, type Point } from "@led-control/shared";

export interface CadHatchPolygon { outer: Point[]; holes: Point[][] }
export interface CadHatchRegion {
  boundary: CadHatchPolygon;
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

/** Earcut is only a partitioner, not our boolean/fill-rule authority. Verify its
 * output against the clipping result, including coverage and overlapping area. */
export function triangulateCadHatchPolygon(polygon: CadHatchPolygon): Point[][] {
  const input = coordinates(polygon);
  checkPoints([input]);
  const flat = earcut.flatten(input);
  const indices = earcut(flat.vertices, flat.holes, flat.dimensions);
  if (indices.length > MAP_ELEMENT_MAX_POINTS) throw new Error("CAD HATCH triangulation point limit exceeded");
  const triangles: Point[][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = indices.slice(i, i + 3).map(index => ({ x: flat.vertices[index * 2], y: flat.vertices[index * 2 + 1] }));
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
    throw new Error("CAD HATCH partition does not preserve filled geometry");
  }
  return triangles;
}

/** DXF normal HATCH uses alternating fill across boundaries. Ring orientation
 * and a boundary's first vertex cannot determine containment at contacts. */
export function resolveCadHatchRegions(rings: readonly Point[][]): CadHatchRegion[] {
  const input: MultiPolygon = rings.map(outer => coordinates({ outer, holes: [] }));
  checkPoints(input);
  const normalized = rings.map((ring, index): MultiPolygon => {
    if (!getMapPolygonValidationError(ring, [])) return [input[index]];
    // A fan is an algebraic even-odd decomposition, not an earcut triangulation.
    // XOR cancels its internal edges, including for self-crossing/double-wound rings;
    // passing such a ring directly to polygon-clipping would use its non-zero rule.
    const fan: MultiPolygon[] = [];
    for (let i = 1; i + 1 < ring.length; i++) {
      const outer = [ring[0], ring[i], ring[i + 1]];
      if (ringArea(outer) > 0) fan.push([coordinates({ outer, holes: [] })]);
    }
    return combine(fan, xor);
  });
  const result = combine(normalized, xor);
  if (!result.length) throw new Error("CAD HATCH has empty even-odd filled geometry");
  return result.map(polygon => {
    const boundary = polygonPoints(polygon);
    const error = getMapPolygonValidationError(boundary.outer, boundary.holes);
    if (!error) return { boundary, parts: [boundary] };
    // Polygon clipping permits point-touching rings, unlike the common schema.
    // Partition that same area, keeping real boundary strokes separate from diagonals.
    return { boundary, parts: triangulateCadHatchPolygon(boundary).map(outer => ({ outer, holes: [] })) };
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
