import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  CAD_SCENE_MAX_EXPANDED_PRIMITIVES,
  CAD_SCENE_MAX_PARTS_PER_TILE,
  CAD_SCENE_MAX_POINTS_PER_PRIMITIVE,
  CAD_SCENE_MAX_SELECTED_PRIMITIVES,
  CAD_SCENE_MAX_TILE_BYTE_SIZE,
  CAD_SCENE_MAX_TILE_PART_COUNT,
  CAD_SCENE_MAX_TOTAL_TILE_BYTES,
  CAD_SCENE_TILE_SIZE,
  CAD_SCENE_VERSION,
  cadSceneManifestSchema,
  normalizeCadMapSize,
  type CadBounds as SceneBounds,
  type CadSceneManifest,
  type CadScenePrimitive,
  type CadSceneTile,
  type CadSceneTransform
} from "@led-control/shared";
import type { CadDetectedRegion } from "./cad-region-detector";
import {
  cadBulgeArc,
  cadEllipseAngles,
  cadEllipseMatrix,
  cadTransformedArcExtremaPoints,
  createCadSplineSampler,
  iterateCadDocumentExpansion,
  multiplyCadMatrices,
  transformPoint,
  type CadMatrix,
  type ExpandedCadEntity
} from "./cad-geometry";
import { CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT } from "./cad-runtime-contract";
import {
  CadSceneTileSizeTracker,
  encodeTrustedCadSceneTile,
  getCadSceneTileIntegrity
} from "./cad-scene-codec";
import { measureCadText } from "./cad-text-layout";
import type {
  CadPoint,
  CadPolylineVertex,
  NormalizedCadDocument,
  NormalizedCadEntity,
  NormalizedCadHatchEdgeLoop
} from "./cad-types";

const DEFAULT_STYLE = Object.freeze({
  strokeColor: "#111111",
  fillColor: null,
  strokeWidth: 1,
  opacity: 1
});
const COORDINATE_PRECISION = 1_000_000;
const GEOMETRY_EPSILON = 1e-6;
const MAX_RETAINED_TILE_OCCURRENCES = 50_000;

export interface BuildCadSceneOptions {
  sceneId: string;
  manifestAssetId?: string;
  tileAssetId?: (tile: { tileX: number; tileY: number; lod: 0 | 1 | 2; part: number }) => string;
  maxExpandedEntities?: number;
  maxSelectedPrimitives?: number;
  maxBlockDepth?: number;
  maxSplineSamples?: number;
  simplifyTolerance?: number;
  maxTileByteSize?: number;
  maxTilePartsPerCell?: number;
  maxTilePartCount?: number;
  maxTotalTileBytes?: number;
  maxRetainedTileOccurrences?: number;
  checkBudget?: () => void;
  /** Synchronous, bounded source hook. Called before display deduplication,
   * simplification or clipping. Throwing aborts the entire build. */
  onSemanticEntity?: (entity: CadSemanticEntity) => void;
}

export interface CadSemanticEntity {
  source: ExpandedCadEntity;
  primitives: readonly CadScenePrimitive[];
  transform: CadSceneTransform;
}

export interface BuiltCadSceneTile {
  descriptor: CadSceneTile;
  payload: Buffer;
}

export interface BuiltCadScene {
  manifest: CadSceneManifest;
  manifestPayload: Buffer;
  tiles: BuiltCadSceneTile[];
}

interface ProjectionContext {
  transform: CadSceneTransform;
  contentBounds: SceneBounds;
  simplifyTolerance: number;
  sampleSpline: ReturnType<typeof createCadSplineSampler>;
  preserveGeometry?: boolean;
}

function round(value: number): number {
  const rounded = Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function stableId(prefix: string, parts: readonly string[]): string {
  const canonical = parts.map(part => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
  return `${prefix}-${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}`;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function projectPoint(context: ProjectionContext, point: CadPoint): { x: number; y: number } {
  return {
    x: round(point.x * context.transform.scaleX + context.transform.translateX),
    y: round(point.y * context.transform.scaleY + context.transform.translateY)
  };
}

function projectEntityPoint(
  context: ProjectionContext,
  matrix: CadMatrix,
  point: CadPoint
): { x: number; y: number } {
  return projectPoint(context, transformPoint(matrix, point));
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function samePoint(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return distance(left, right) <= GEOMETRY_EPSILON;
}

function removeConsecutiveDuplicates(
  input: readonly { x: number; y: number }[],
  closed: boolean
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  input.forEach(point => {
    if (!points.length || !samePoint(points.at(-1)!, point)) points.push(point);
  });
  if (closed && points.length > 1 && samePoint(points[0], points.at(-1)!)) points.pop();
  return points;
}

function pointLineDistance(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number }
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function simplifyOpenPolyline(
  points: readonly { x: number; y: number }[],
  tolerance: number
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return [...points];
  const retained = new Uint8Array(points.length);
  retained[0] = 1;
  retained[points.length - 1] = 1;
  const ranges: number[] = [0, points.length - 1];
  const maximumDistanceChecks = Math.max(1_000_000, points.length * 64);
  let distanceChecks = 0;

  while (ranges.length > 0) {
    const endIndex = ranges.pop()!;
    const startIndex = ranges.pop()!;
    let farthestIndex = -1;
    let farthestDistance = tolerance;
    for (let index = startIndex + 1; index < endIndex; index++) {
      distanceChecks++;
      // Adversarial zig-zags make RDP quadratic. Preserving the unsimplified path
      // is deterministic and safer than spending an unbounded import budget.
      if (distanceChecks > maximumDistanceChecks) return [...points];
      const candidate = pointLineDistance(points[index], points[startIndex], points[endIndex]);
      if (candidate > farthestDistance) {
        farthestDistance = candidate;
        farthestIndex = index;
      }
    }
    if (farthestIndex < 0) continue;
    retained[farthestIndex] = 1;
    ranges.push(startIndex, farthestIndex, farthestIndex, endIndex);
  }

  const simplified: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < points.length; index++) {
    if (retained[index]) simplified.push(points[index]);
  }
  return simplified;
}

function simplifyClosedPolyline(
  input: readonly { x: number; y: number }[],
  tolerance: number
): Array<{ x: number; y: number }> {
  if (input.length <= 3) return [...input];
  const retained = input.filter((current, index) => {
    const previous = input[(index - 1 + input.length) % input.length];
    const next = input[(index + 1) % input.length];
    return pointLineDistance(current, previous, next) > tolerance;
  });
  return retained.length >= 3 ? retained : [...input];
}

function simplifyPoints(
  input: readonly { x: number; y: number }[],
  closed: boolean,
  tolerance: number
): Array<{ x: number; y: number }> {
  const points = removeConsecutiveDuplicates(input, closed);
  if (closed) return simplifyClosedPolyline(points, tolerance);
  return simplifyOpenPolyline(points, tolerance);
}

function boundsOfPoints(points: readonly { x: number; y: number }[]): SceneBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (maxX <= minX) maxX = minX + GEOMETRY_EPSILON;
  if (maxY <= minY) maxY = minY + GEOMETRY_EPSILON;
  return { minX: round(minX), minY: round(minY), maxX: round(maxX), maxY: round(maxY) };
}

function intersects(left: SceneBounds, right: SceneBounds): boolean {
  return left.maxX >= right.minX && left.minX <= right.maxX &&
    left.maxY >= right.minY && left.minY <= right.maxY;
}

function sweepFraction(angle: number, start: number, sweep: number): number | null {
  const fullTurn = Math.PI * 2;
  const normalize = (value: number) => ((value % fullTurn) + fullTurn) % fullTurn;
  const distance = sweep >= 0 ? normalize(angle - start) : normalize(start - angle);
  const magnitude = Math.abs(sweep);
  return distance <= magnitude + 1e-10 ? Math.min(1, distance / magnitude) : null;
}

function parametricCurvePoints(
  center: { x: number; y: number },
  xCos: number,
  xSin: number,
  yCos: number,
  ySin: number,
  start: number,
  sweep: number,
  bounds: SceneBounds
): Array<{ x: number; y: number }> {
  const sweepRadians = Math.abs(sweep);
  const maximumError = 0.5;
  const radiusBound = Math.hypot(xCos, xSin, yCos, ySin);
  const maximumAngle = radiusBound <= maximumError
    ? Math.PI / 12
    : 2 * Math.acos(Math.max(-1, 1 - maximumError / radiusBound));
  const segments = Math.max(2, Math.min(4_096, Math.ceil(sweepRadians / maximumAngle)));
  const fractions = new Set<number>();
  for (let index = 0; index <= segments; index++) fractions.add(index / segments);
  const addAngle = (angle: number): void => {
    const fraction = sweepFraction(angle, start, sweep);
    if (fraction !== null) fractions.add(Math.round(fraction * 1e12) / 1e12);
  };
  for (const angle of [
    Math.atan2(xSin, xCos), Math.atan2(xSin, xCos) + Math.PI,
    Math.atan2(ySin, yCos), Math.atan2(ySin, yCos) + Math.PI
  ]) addAngle(angle);

  const addBoundaryRoots = (cosine: number, sine: number, target: number): void => {
    const radius = Math.hypot(cosine, sine);
    if (radius <= GEOMETRY_EPSILON || Math.abs(target) > radius + GEOMETRY_EPSILON) return;
    const phase = Math.atan2(sine, cosine);
    const offset = Math.acos(Math.max(-1, Math.min(1, target / radius)));
    addAngle(phase - offset);
    addAngle(phase + offset);
  };
  const firstVertical = Math.ceil(bounds.minX / CAD_SCENE_TILE_SIZE) * CAD_SCENE_TILE_SIZE;
  for (let x = firstVertical; x <= bounds.maxX; x += CAD_SCENE_TILE_SIZE) {
    addBoundaryRoots(xCos, xSin, x - center.x);
  }
  const firstHorizontal = Math.ceil(bounds.minY / CAD_SCENE_TILE_SIZE) * CAD_SCENE_TILE_SIZE;
  for (let y = firstHorizontal; y <= bounds.maxY; y += CAD_SCENE_TILE_SIZE) {
    addBoundaryRoots(yCos, ySin, y - center.y);
  }

  return [...fractions].sort((left, right) => left - right).map(fraction => {
    const angle = start + sweep * fraction;
    return {
      x: round(center.x + xCos * Math.cos(angle) + xSin * Math.sin(angle)),
      y: round(center.y + yCos * Math.cos(angle) + ySin * Math.sin(angle))
    };
  });
}

function projectedArcPoints(
  center: CadPoint,
  radius: number,
  startAngle: number,
  sweepAngle: number,
  matrix: CadMatrix,
  bounds: SceneBounds
): Array<{ x: number; y: number }> {
  const projectedCenter = transformPoint(matrix, center);
  return parametricCurvePoints(
    projectedCenter,
    radius * matrix.a,
    radius * matrix.c,
    radius * matrix.b,
    radius * matrix.d,
    startAngle * Math.PI / 180,
    sweepAngle * Math.PI / 180,
    bounds
  );
}

function polylineProjectedGeometry(
  item: ExpandedCadEntity,
  context: ProjectionContext,
  vertices: readonly CadPolylineVertex[],
  closed: boolean
): { points: Array<{ x: number; y: number }>; bounds: SceneBounds; hasCurves: boolean } {
  const matrix = projectedMatrix(item.matrix, context.transform);
  const points: Array<{ x: number; y: number }> = [];
  const boundsPoints = vertices.map(vertex => transformPoint(matrix, vertex));
  let hasCurves = false;
  const segmentCount = closed ? vertices.length : Math.max(0, vertices.length - 1);
  for (let index = 0; index < segmentCount; index++) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const arc = cadBulgeArc(start, end, start.bulge);
    if (arc) {
      hasCurves = true;
      const sampled = projectedArcPoints(
        arc.center,
        arc.radius,
        arc.startAngle,
        arc.sweepAngle,
        matrix,
        context.contentBounds
      );
      const extrema = cadTransformedArcExtremaPoints(
        arc.center,
        arc.radius,
        arc.startAngle,
        arc.sweepAngle,
        matrix
      );
      boundsPoints.push(...extrema);
      points.push(...insertExactPolylinePoints(sampled, extrema, false).slice(0, -1));
    } else {
      points.push(transformPoint(matrix, start));
    }
  }
  if (!closed && vertices.length > 0) points.push(transformPoint(matrix, vertices.at(-1)!));
  return {
    points: points.map(point => ({ x: round(point.x), y: round(point.y) })),
    bounds: boundsOfPoints(boundsPoints),
    hasCurves
  };
}

function insertExactPolylinePoints(
  points: readonly { x: number; y: number }[],
  exactPoints: readonly { x: number; y: number }[],
  closed: boolean
): Array<{ x: number; y: number }> {
  if (points.length < 2 || exactPoints.length === 0) return [...points];
  const segmentCount = closed ? points.length : points.length - 1;
  const insertions = new Map<number, Array<{ point: { x: number; y: number }; ratio: number }>>();

  for (const exactPoint of exactPoints) {
    if (points.some(point => samePoint(point, exactPoint))) continue;
    let bestSegment = 0;
    let bestRatio = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < segmentCount; index++) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(
        1,
        ((exactPoint.x - start.x) * dx + (exactPoint.y - start.y) * dy) / lengthSquared
      ));
      const distanceToSegment = Math.hypot(
        exactPoint.x - (start.x + ratio * dx),
        exactPoint.y - (start.y + ratio * dy)
      );
      if (distanceToSegment < bestDistance) {
        bestDistance = distanceToSegment;
        bestSegment = index;
        bestRatio = ratio;
      }
    }
    const segmentInsertions = insertions.get(bestSegment) ?? [];
    segmentInsertions.push({ point: exactPoint, ratio: bestRatio });
    insertions.set(bestSegment, segmentInsertions);
  }

  const result: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < points.length; index++) {
    result.push(points[index]);
    for (const insertion of (insertions.get(index) ?? []).sort((left, right) => left.ratio - right.ratio)) {
      if (!samePoint(result.at(-1)!, insertion.point)) result.push(insertion.point);
    }
  }
  return removeConsecutiveDuplicates(result, closed);
}

function signedArea(points: readonly { x: number; y: number }[]): number {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function rectangleGeometry(points: readonly { x: number; y: number }[]):
  | Extract<CadScenePrimitive, { type: "rectangle" }>["geometry"]
  | null {
  if (points.length !== 4) return null;
  const oriented = signedArea(points) < 0 ? [...points].reverse() : [...points];
  const edges = oriented.map((point, index) => ({
    x: oriented[(index + 1) % 4].x - point.x,
    y: oriented[(index + 1) % 4].y - point.y
  }));
  const lengths = edges.map(edge => Math.hypot(edge.x, edge.y));
  const scale = Math.max(...lengths, 1);
  if (lengths.some(length => length <= GEOMETRY_EPSILON)) return null;
  const dot = (left: { x: number; y: number }, right: { x: number; y: number }) => left.x * right.x + left.y * right.y;
  const cross = (left: { x: number; y: number }, right: { x: number; y: number }) => left.x * right.y - left.y * right.x;
  if (Math.abs(dot(edges[0], edges[1])) > scale * scale * 1e-6 ||
      Math.abs(dot(edges[1], edges[2])) > scale * scale * 1e-6 ||
      Math.abs(cross(edges[0], edges[2])) > scale * scale * 1e-6 ||
      Math.abs(cross(edges[1], edges[3])) > scale * scale * 1e-6) return null;
  return {
    origin: oriented[0],
    width: round(lengths[0]),
    height: round(lengths[1]),
    rotation: round(Math.atan2(edges[0].y, edges[0].x) * 180 / Math.PI)
  };
}

function sourceType(entity: Exclude<NormalizedCadEntity, { type: "insert" }>): string {
  return entity.type.toUpperCase();
}

function resolvedLayer(item: ExpandedCadEntity): string {
  return item.entity.layer === "0" && item.insertLayer ? item.insertLayer : item.entity.layer;
}

function canonicalMatrix(matrix: CadMatrix): string {
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]
    .map(value => (Object.is(value, -0) ? 0 : value).toPrecision(17))
    .join(",");
}

function primitiveBase(
  item: ExpandedCadEntity,
  suffix: string,
  bounds: SceneBounds,
  forceGroup = false
) {
  const matrixIdentity = canonicalMatrix(item.matrix);
  const semanticGroup = item.semanticGroupSourceId && item.semanticGroupMatrix
    ? stableId("cad-group", [item.semanticGroupSourceId, canonicalMatrix(item.semanticGroupMatrix)])
    : null;
  const occurrenceGroup = item.occurrencePath && item.occurrencePath.length > 0
    ? stableId("cad-group", [...item.occurrencePath, matrixIdentity])
    : null;
  return {
    elementId: stableId("cad-element", [item.sourceEntityId, matrixIdentity, suffix]),
    groupId: semanticGroup ?? occurrenceGroup ?? (
      forceGroup ? stableId("cad-group", [item.sourceEntityId, matrixIdentity]) : null
    ),
    layerName: resolvedLayer(item),
    sourceType: item.semanticSourceType ?? sourceType(item.entity),
    bounds,
    clipBounds: null,
    style: DEFAULT_STYLE
  };
}

function transformedLinear(matrix: CadMatrix, transform: CadSceneTransform): CadMatrix {
  return {
    a: transform.scaleX * matrix.a,
    b: transform.scaleY * matrix.b,
    c: transform.scaleX * matrix.c,
    d: transform.scaleY * matrix.d,
    e: 0,
    f: 0
  };
}

function projectedMatrix(matrix: CadMatrix, transform: CadSceneTransform): CadMatrix {
  return {
    ...transformedLinear(matrix, transform),
    e: matrix.e * transform.scaleX + transform.translateX,
    f: matrix.f * transform.scaleY + transform.translateY
  };
}

function ellipseGeometry(
  item: ExpandedCadEntity,
  context: ProjectionContext,
  center: CadPoint,
  radius: number
): CadScenePrimitive {
  const matrix = transformedLinear(item.matrix, context.transform);
  const xx = matrix.a * matrix.a + matrix.c * matrix.c;
  const xy = matrix.a * matrix.b + matrix.c * matrix.d;
  const yy = matrix.b * matrix.b + matrix.d * matrix.d;
  const trace = xx + yy;
  const discriminant = Math.sqrt(Math.max(0, (xx - yy) ** 2 + 4 * xy * xy));
  const radiusX = radius * Math.sqrt(Math.max(0, (trace + discriminant) / 2));
  // det / major singular value preserves thin ellipses where subtracting two
  // nearly equal eigenvalues would erase a real, nonzero minor axis.
  const radiusY = radiusX > 0 ? radius * radius * Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) / radiusX : 0;
  const rotation = discriminant <= GEOMETRY_EPSILON
    ? 0
    : Math.atan2(2 * xy, xx - yy) * 90 / Math.PI;
  const projectedCenter = projectEntityPoint(context, item.matrix, center);
  const radians = rotation * Math.PI / 180;
  const extentX = Math.hypot(radiusX * Math.cos(radians), radiusY * Math.sin(radians));
  const extentY = Math.hypot(radiusX * Math.sin(radians), radiusY * Math.cos(radians));
  const roundedRadiusX = context.preserveGeometry ? radiusX : round(radiusX);
  const roundedRadiusY = context.preserveGeometry ? radiusY : round(radiusY);
  if (roundedRadiusY <= 0) {
    if (roundedRadiusX <= 0) throw new Error("CAD ellipse collapses below coordinate precision");
    const direction = { x: Math.cos(radians), y: Math.sin(radians) };
    const start = {
      x: round(projectedCenter.x - roundedRadiusX * direction.x),
      y: round(projectedCenter.y - roundedRadiusX * direction.y)
    };
    const end = {
      x: round(projectedCenter.x + roundedRadiusX * direction.x),
      y: round(projectedCenter.y + roundedRadiusX * direction.y)
    };
    return {
      ...primitiveBase(item, "ellipse-line", boundsOfPoints([start, end])),
      type: "line",
      geometry: { start, end }
    };
  }
  const bounds = {
    minX: round(projectedCenter.x - extentX),
    minY: round(projectedCenter.y - extentY),
    maxX: round(projectedCenter.x + extentX),
    maxY: round(projectedCenter.y + extentY)
  };
  return {
    ...primitiveBase(item, "ellipse", bounds),
    type: "ellipse",
    geometry: {
      center: projectedCenter,
      radiusX: roundedRadiusX,
      radiusY: roundedRadiusY,
      rotation: round(rotation)
    }
  };
}

function isSimilarity(matrix: CadMatrix): boolean {
  const firstLength = Math.hypot(matrix.a, matrix.b);
  const secondLength = Math.hypot(matrix.c, matrix.d);
  const scale = Math.max(firstLength, secondLength, 1);
  return Math.abs(firstLength - secondLength) <= scale * 1e-9 &&
    Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) <= scale * scale * 1e-9;
}

function normalizeAngle(value: number): number {
  return round(((value % 360) + 360) % 360);
}

function polylinePrimitive(
  item: ExpandedCadEntity,
  context: ProjectionContext,
  localPoints: readonly CadPoint[],
  closed: boolean,
  suffix: string,
  forceGroup = false,
  exactBounds?: SceneBounds,
  projectedPoints?: readonly { x: number; y: number }[],
  preserveProjectedPoints = false
): CadScenePrimitive | null {
  const rawPoints = projectedPoints ?? localPoints.map(point => projectEntityPoint(context, item.matrix, point));
  const points = preserveProjectedPoints || context.preserveGeometry
    ? removeConsecutiveDuplicates(rawPoints, closed)
    : simplifyPoints(rawPoints, closed, context.simplifyTolerance);
  if (points.length < (closed ? 3 : 2)) return null;
  const bounds = exactBounds ?? boundsOfPoints(points);
  const base = primitiveBase(item, suffix, bounds, forceGroup);
  return classifyPolyline(base, points, closed);
}

function classifyPolyline(base: Omit<CadScenePrimitive, "type" | "geometry">, points: Array<{ x: number; y: number }>, closed: boolean): CadScenePrimitive {
  if (closed && points.length === 3 && Math.abs(signedArea(points)) > GEOMETRY_EPSILON) {
    const triangle = signedArea(points) < 0 ? [...points].reverse() : points;
    return { ...base, type: "triangle", geometry: { points: [triangle[0], triangle[1], triangle[2]] } };
  }
  const rectangle = closed ? rectangleGeometry(points) : null;
  if (rectangle) return { ...base, type: "rectangle", geometry: rectangle };
  return { ...base, type: "polyline", geometry: { points, closed } };
}

function hatchEdgeProjectedPoints(
  loop: NormalizedCadHatchEdgeLoop,
  item: ExpandedCadEntity,
  context: ProjectionContext
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  const matrix = projectedMatrix(item.matrix, context.transform);
  loop.edges.forEach(edge => {
    if (edge.type === "line") {
      if (!points.length) points.push(transformPoint(matrix, edge.start));
      points.push(transformPoint(matrix, edge.end));
      return;
    }
    const rawSweep = ((edge.endAngle - edge.startAngle) % 360 + 360) % 360 || 360;
    const sweep = edge.counterClockwise ? rawSweep : -(360 - rawSweep || 360);
    const sampled = projectedArcPoints(
      edge.center,
      edge.radius,
      edge.startAngle,
      sweep,
      matrix,
      context.contentBounds
    );
    if (points.length && samePoint(points.at(-1)!, sampled[0])) sampled.shift();
    points.push(...sampled);
  });
  return points;
}

function convertEntity(item: ExpandedCadEntity, context: ProjectionContext): CadScenePrimitive[] {
  const entity = item.entity;
  if (entity.type === "line") {
    const start = projectEntityPoint(context, item.matrix, entity.start);
    const end = projectEntityPoint(context, item.matrix, entity.end);
    if (samePoint(start, end)) return [];
    return [{
      ...primitiveBase(item, "line", boundsOfPoints([start, end])),
      type: "line",
      geometry: { start, end }
    }];
  }
  if (entity.type === "lwpolyline" || entity.type === "polyline") {
    const projected = polylineProjectedGeometry(item, context, entity.vertices, entity.closed);
    const primitive = polylinePrimitive(
      item,
      context,
      [],
      entity.closed,
      "polyline",
      false,
      projected.bounds,
      projected.points,
      projected.hasCurves
    );
    return primitive ? [primitive] : [];
  }
  if (entity.type === "circle") return [ellipseGeometry(item, context, entity.center, entity.radius)];
  if (entity.type === "ellipse") {
    const matrix = multiplyCadMatrices(item.matrix, cadEllipseMatrix(entity));
    const origin = { x: 0, y: 0, z: entity.center.z };
    const { startAngle, sweepAngle } = cadEllipseAngles(entity);
    if (sweepAngle === 360) return [ellipseGeometry({ ...item, matrix }, context, origin, 1)];
    const projected = projectedMatrix(matrix, context.transform);
    const exactBounds = boundsOfPoints(cadTransformedArcExtremaPoints(origin, 1, startAngle, sweepAngle, projected));
    const primitive = polylinePrimitive(item, context, [], false, "ellipse-arc", false, exactBounds,
      projectedArcPoints(origin, 1, startAngle, sweepAngle, projected, context.contentBounds), true);
    return primitive ? [primitive] : [];
  }
  if (entity.type === "arc") {
    const linear = transformedLinear(item.matrix, context.transform);
    const projected = projectedMatrix(item.matrix, context.transform);
    const rawSweep = ((entity.endAngle - entity.startAngle) % 360 + 360) % 360 || 360;
    const projectedPoints = projectedArcPoints(
      entity.center,
      entity.radius,
      entity.startAngle,
      rawSweep,
      projected,
      context.contentBounds
    );
    const exactBounds = boundsOfPoints(cadTransformedArcExtremaPoints(
      entity.center,
      entity.radius,
      entity.startAngle,
      rawSweep,
      projected
    ));
    if (!isSimilarity(linear)) {
      const primitive = polylinePrimitive(
        item,
        context,
        [],
        false,
        "arc",
        false,
        exactBounds,
        projectedPoints,
        true
      );
      return primitive ? [primitive] : [];
    }
    const center = projectEntityPoint(context, item.matrix, entity.center);
    const start = projectedPoints[0];
    const end = projectedPoints.at(-1)!;
    const radius = distance(center, start);
    return [{
      ...primitiveBase(item, "arc", exactBounds),
      type: "arc",
      geometry: {
        center,
        radius: round(radius),
        startAngle: normalizeAngle(Math.atan2(start.y - center.y, start.x - center.x) * 180 / Math.PI),
        endAngle: normalizeAngle(Math.atan2(end.y - center.y, end.x - center.x) * 180 / Math.PI),
        counterClockwise: linear.a * linear.d - linear.b * linear.c > 0
      }
    }];
  }
  if (entity.type === "text" || entity.type === "mtext") {
    const layout = measureCadText(entity.text, entity.height);
    const radians = entity.rotation * Math.PI / 180;
    const localPoint = (x: number, y: number): CadPoint => ({
      x: entity.position.x + x * Math.cos(radians) - y * Math.sin(radians),
      y: entity.position.y + x * Math.sin(radians) + y * Math.cos(radians),
      z: entity.position.z
    });
    const corners = [
      localPoint(layout.bounds.minX, layout.bounds.minY),
      localPoint(layout.bounds.maxX, layout.bounds.minY),
      localPoint(layout.bounds.maxX, layout.bounds.maxY),
      localPoint(layout.bounds.minX, layout.bounds.maxY)
    ].map(point => projectEntityPoint(context, item.matrix, point));
    const origin = projectEntityPoint(context, item.matrix, entity.position);
    const xAxis = projectEntityPoint(context, item.matrix, localPoint(1, 0));
    const yAxis = projectEntityPoint(context, item.matrix, localPoint(0, 1));
    const xScale = distance(origin, xAxis);
    const yScale = distance(origin, yAxis);
    return [{
      ...primitiveBase(item, "text", boundsOfPoints(corners)),
      type: "text",
      geometry: {
        position: origin,
        text: layout.text,
        width: round((layout.bounds.maxX - layout.bounds.minX) * xScale),
        height: round((layout.bounds.maxY - layout.bounds.minY) * yScale),
        rotation: normalizeAngle(Math.atan2(xAxis.y - origin.y, xAxis.x - origin.x) * 180 / Math.PI),
        fontSize: round(entity.height * yScale)
      }
    }];
  }
  if (entity.type === "spline") {
    const primitive = polylinePrimitive(
      item,
      context,
      context.sampleSpline(entity),
      entity.closed,
      "spline"
    );
    return primitive ? [primitive] : [];
  }
  if (entity.type === "hatch") {
    return entity.loops.flatMap((loop, index) => {
      const projected = loop.type === "polyline"
        ? polylineProjectedGeometry(item, context, loop.vertices, loop.closed)
        : null;
      const projectedEdgePoints = loop.type === "edges"
        ? hatchEdgeProjectedPoints(loop, item, context)
        : null;
      const preserveCurvePoints = projected?.hasCurves ?? (
        loop.type === "edges" && loop.edges.some(edge => edge.type === "arc")
      );
      const primitive = polylinePrimitive(
        item,
        context,
        [],
        true,
        `hatch:${index}`,
        true,
        projected?.bounds ?? (projectedEdgePoints ? boundsOfPoints(projectedEdgePoints) : undefined),
        projected?.points ?? projectedEdgePoints ?? undefined,
        preserveCurvePoints
      );
      if (!primitive) return [];
      return [{ ...primitive, type: "polyline" as const, geometry: {
        points: primitive.type === "polyline"
          ? primitive.geometry.points
          : projected?.points ?? projectedEdgePoints ?? [],
        closed: true
      }}];
    });
  }
  if (entity.type === "wipeout") {
    const primitive = polylinePrimitive(item, context, entity.vertices, true, "wipeout");
    return primitive ? [primitive] : [];
  }
  if (entity.type === "dimension") {
    const start = projectEntityPoint(context, item.matrix, entity.extensionStart);
    const end = projectEntityPoint(context, item.matrix, entity.extensionEnd);
    const primitives: CadScenePrimitive[] = [];
    if (!samePoint(start, end)) {
      primitives.push({
        ...primitiveBase(item, "dimension-line", boundsOfPoints([start, end]), true),
        type: "line",
        geometry: { start, end }
      });
    }
    if (entity.text.length > 0) {
      const sourceHeight = Math.max(1, distance(entity.extensionStart, entity.extensionEnd) * 0.1);
      const layout = measureCadText(entity.text, sourceHeight);
      const radians = entity.rotation * Math.PI / 180;
      const localPoint = (x: number, y: number): CadPoint => ({
        x: entity.textPosition.x + x * Math.cos(radians) - y * Math.sin(radians),
        y: entity.textPosition.y + x * Math.sin(radians) + y * Math.cos(radians),
        z: entity.textPosition.z
      });
      const position = projectEntityPoint(context, item.matrix, entity.textPosition);
      const xAxis = projectEntityPoint(context, item.matrix, localPoint(1, 0));
      const yAxis = projectEntityPoint(context, item.matrix, localPoint(0, 1));
      const xScale = distance(position, xAxis);
      const yScale = distance(position, yAxis);
      const corners = [
        localPoint(layout.bounds.minX, layout.bounds.minY),
        localPoint(layout.bounds.maxX, layout.bounds.minY),
        localPoint(layout.bounds.maxX, layout.bounds.maxY),
        localPoint(layout.bounds.minX, layout.bounds.maxY)
      ].map(point => projectEntityPoint(context, item.matrix, point));
      primitives.push({
        ...primitiveBase(item, "dimension-text", boundsOfPoints(corners), true),
        type: "text",
        geometry: {
          position,
          text: layout.text,
          width: round((layout.bounds.maxX - layout.bounds.minX) * xScale),
          height: round((layout.bounds.maxY - layout.bounds.minY) * yScale),
          rotation: normalizeAngle(Math.atan2(xAxis.y - position.y, xAxis.x - position.x) * 180 / Math.PI),
          fontSize: round(sourceHeight * yScale)
        }
      });
    }
    return primitives;
  }
  return [];
}

function deduplicationDigest(primitive: CadScenePrimitive): string {
  const geometry = primitive.type === "line"
    ? (() => {
        const points = [primitive.geometry.start, primitive.geometry.end]
          .sort((left, right) => left.x - right.x || left.y - right.y);
        return { ...primitive.geometry, start: points[0], end: points[1] };
      })()
    : primitive.geometry;
  const canonical = JSON.stringify({
    groupId: primitive.groupId,
    layerName: primitive.layerName,
    sourceType: primitive.sourceType,
    style: primitive.style,
    type: primitive.type,
    geometry
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function splitOversizedPolyline(primitive: CadScenePrimitive): CadScenePrimitive[] {
  if (primitive.type !== "polyline" || primitive.geometry.points.length <= CAD_SCENE_MAX_POINTS_PER_PRIMITIVE) {
    return [primitive];
  }
  const points = primitive.geometry.closed
    ? [...primitive.geometry.points, primitive.geometry.points[0]]
    : primitive.geometry.points;
  const groupId = primitive.groupId ?? stableId("cad-group", [primitive.elementId]);
  const chunks: CadScenePrimitive[] = [];
  let start = 0;
  while (start < points.length - 1) {
    const chunk = points.slice(start, start + CAD_SCENE_MAX_POINTS_PER_PRIMITIVE);
    chunks.push({
      ...primitive,
      groupId,
      bounds: boundsOfPoints(chunk),
      geometry: { points: chunk, closed: false }
    });
    start += chunk.length - 1;
  }
  return chunks;
}

function lodFor(primitive: CadScenePrimitive): 0 | 1 | 2 {
  if (primitive.sourceType === "HATCH" || primitive.sourceType === "DIMENSION") return 2;
  if (primitive.type === "polyline" || primitive.type === "text" || primitive.sourceType === "SPLINE") return 1;
  return 0;
}

function tileCellBounds(tileX: number, tileY: number, width: number, height: number): SceneBounds {
  return {
    minX: tileX * CAD_SCENE_TILE_SIZE,
    minY: tileY * CAD_SCENE_TILE_SIZE,
    maxX: Math.min(width, (tileX + 1) * CAD_SCENE_TILE_SIZE),
    maxY: Math.min(height, (tileY + 1) * CAD_SCENE_TILE_SIZE)
  };
}

function clippedBounds(bounds: SceneBounds, clip: SceneBounds): SceneBounds | null {
  const intersection = {
    minX: Math.max(bounds.minX, clip.minX),
    minY: Math.max(bounds.minY, clip.minY),
    maxX: Math.min(bounds.maxX, clip.maxX),
    maxY: Math.min(bounds.maxY, clip.maxY)
  };
  if (intersection.maxX < intersection.minX || intersection.maxY < intersection.minY) return null;
  if (intersection.maxX === intersection.minX && intersection.maxY === intersection.minY) return null;
  return intersection;
}

function tileRange(minimum: number, maximum: number, axisSize: number): [number, number] {
  const maximumTile = Math.ceil(axisSize / CAD_SCENE_TILE_SIZE) - 1;
  const clampedMinimum = Math.max(0, Math.min(axisSize - GEOMETRY_EPSILON, minimum));
  const clampedMaximum = Math.max(
    clampedMinimum,
    Math.min(axisSize - GEOMETRY_EPSILON, maximum - (maximum > minimum ? GEOMETRY_EPSILON : 0))
  );
  return [
    Math.max(0, Math.min(maximumTile, Math.floor(clampedMinimum / CAD_SCENE_TILE_SIZE))),
    Math.max(0, Math.min(maximumTile, Math.floor(clampedMaximum / CAD_SCENE_TILE_SIZE)))
  ];
}

interface TilePrimitiveAccumulator {
  tileX: number;
  tileY: number;
  lod: 0 | 1 | 2;
  nextPart: number;
  primitives: Array<CadScenePrimitive | null>;
}

interface OccupiedTileCell {
  tileX: number;
  tileY: number;
}

interface SegmentFragment extends OccupiedTileCell {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

function tileCellKey(cell: OccupiedTileCell): string {
  return `${cell.tileY}:${cell.tileX}`;
}

function clipSegmentToBounds(
  start: { x: number; y: number },
  end: { x: number; y: number },
  bounds: SceneBounds
): { start: { x: number; y: number }; end: { x: number; y: number } } | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let minimumRatio = 0;
  let maximumRatio = 1;
  const clip = (direction: number, distanceToBoundary: number): boolean => {
    if (Math.abs(direction) <= GEOMETRY_EPSILON) return distanceToBoundary >= 0;
    const ratio = distanceToBoundary / direction;
    if (direction < 0) minimumRatio = Math.max(minimumRatio, ratio);
    else maximumRatio = Math.min(maximumRatio, ratio);
    return minimumRatio <= maximumRatio;
  };
  if (!clip(-dx, start.x - bounds.minX) || !clip(dx, bounds.maxX - start.x) ||
      !clip(-dy, start.y - bounds.minY) || !clip(dy, bounds.maxY - start.y)) return null;
  const clippedStart = {
    x: round(start.x + dx * minimumRatio),
    y: round(start.y + dy * minimumRatio)
  };
  const clippedEnd = {
    x: round(start.x + dx * maximumRatio),
    y: round(start.y + dy * maximumRatio)
  };
  return samePoint(clippedStart, clippedEnd) ? null : { start: clippedStart, end: clippedEnd };
}

function segmentBounds(
  start: { x: number; y: number },
  end: { x: number; y: number }
): SceneBounds {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y)
  };
}

function segmentTileCells(
  start: { x: number; y: number },
  end: { x: number; y: number },
  width: number,
  height: number
): OccupiedTileCell[] {
  const mapBounds = { minX: 0, minY: 0, maxX: width, maxY: height };
  const clipped = clipSegmentToBounds(start, end, mapBounds);
  if (!clipped) return [];
  const maximumTileX = Math.ceil(width / CAD_SCENE_TILE_SIZE) - 1;
  const maximumTileY = Math.ceil(height / CAD_SCENE_TILE_SIZE) - 1;
  const tileCoordinate = (value: number, maximum: number, axisSize: number) => Math.max(
    0,
    Math.min(maximum, Math.floor(Math.min(axisSize - GEOMETRY_EPSILON, Math.max(0, value)) / CAD_SCENE_TILE_SIZE))
  );
  let tileX = tileCoordinate(clipped.start.x, maximumTileX, width);
  let tileY = tileCoordinate(clipped.start.y, maximumTileY, height);
  const endTileX = tileCoordinate(clipped.end.x, maximumTileX, width);
  const endTileY = tileCoordinate(clipped.end.y, maximumTileY, height);
  const dx = clipped.end.x - clipped.start.x;
  const dy = clipped.end.y - clipped.start.y;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const nextBoundaryX = stepX > 0 ? (tileX + 1) * CAD_SCENE_TILE_SIZE : tileX * CAD_SCENE_TILE_SIZE;
  const nextBoundaryY = stepY > 0 ? (tileY + 1) * CAD_SCENE_TILE_SIZE : tileY * CAD_SCENE_TILE_SIZE;
  let nextXRatio = stepX === 0 ? Number.POSITIVE_INFINITY : (nextBoundaryX - clipped.start.x) / dx;
  let nextYRatio = stepY === 0 ? Number.POSITIVE_INFINITY : (nextBoundaryY - clipped.start.y) / dy;
  const xRatioStep = stepX === 0 ? Number.POSITIVE_INFINITY : CAD_SCENE_TILE_SIZE / Math.abs(dx);
  const yRatioStep = stepY === 0 ? Number.POSITIVE_INFINITY : CAD_SCENE_TILE_SIZE / Math.abs(dy);
  const cells: OccupiedTileCell[] = [];
  const maximumSteps = maximumTileX + maximumTileY + 3;

  for (let step = 0; step < maximumSteps; step++) {
    cells.push({ tileX, tileY });
    if (tileX === endTileX && tileY === endTileY) break;
    if (Math.abs(nextXRatio - nextYRatio) <= Number.EPSILON * 16) {
      tileX += stepX;
      tileY += stepY;
      nextXRatio += xRatioStep;
      nextYRatio += yRatioStep;
    } else if (nextXRatio < nextYRatio) {
      tileX += stepX;
      nextXRatio += xRatioStep;
    } else {
      tileY += stepY;
      nextYRatio += yRatioStep;
    }
  }
  return cells;
}

function segmentFragments(
  start: { x: number; y: number },
  end: { x: number; y: number },
  width: number,
  height: number
): SegmentFragment[] {
  return segmentTileCells(start, end, width, height).flatMap(cell => {
    const clipped = clipSegmentToBounds(start, end, tileCellBounds(cell.tileX, cell.tileY, width, height));
    return clipped ? [{ ...cell, ...clipped }] : [];
  });
}

function addOccupiedSegment(
  cells: Map<string, OccupiedTileCell>,
  start: { x: number; y: number },
  end: { x: number; y: number },
  width: number,
  height: number
): void {
  for (const cell of segmentTileCells(start, end, width, height)) cells.set(tileCellKey(cell), cell);
}

function addPolygonInteriorCells(
  cells: Map<string, OccupiedTileCell>,
  points: readonly { x: number; y: number }[],
  width: number,
  height: number
): void {
  const bounds = boundsOfPoints(points);
  const [minimumTileX, maximumTileX] = tileRange(bounds.minX, bounds.maxX, width);
  const [minimumTileY, maximumTileY] = tileRange(bounds.minY, bounds.maxY, height);
  for (let tileY = minimumTileY; tileY <= maximumTileY; tileY++) {
    for (let tileX = minimumTileX; tileX <= maximumTileX; tileX++) {
      const cellBounds = tileCellBounds(tileX, tileY, width, height);
      const point = {
        x: (cellBounds.minX + cellBounds.maxX) / 2,
        y: (cellBounds.minY + cellBounds.maxY) / 2
      };
      let inside = false;
      for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
        const currentPoint = points[index];
        const previousPoint = points[previous];
        if ((currentPoint.y > point.y) !== (previousPoint.y > point.y) &&
            point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y) /
              (previousPoint.y - currentPoint.y) + currentPoint.x) inside = !inside;
      }
      if (inside) cells.set(tileCellKey({ tileX, tileY }), { tileX, tileY });
    }
  }
}

function rectanglePoints(primitive: Extract<CadScenePrimitive, { type: "rectangle" }>) {
  const radians = primitive.geometry.rotation * Math.PI / 180;
  const width = { x: Math.cos(radians) * primitive.geometry.width, y: Math.sin(radians) * primitive.geometry.width };
  const height = { x: -Math.sin(radians) * primitive.geometry.height, y: Math.cos(radians) * primitive.geometry.height };
  const origin = primitive.geometry.origin;
  return [
    origin,
    { x: origin.x + width.x, y: origin.y + width.y },
    { x: origin.x + width.x + height.x, y: origin.y + width.y + height.y },
    { x: origin.x + height.x, y: origin.y + height.y }
  ];
}

function curvePoints(primitive: Extract<CadScenePrimitive, { type: "arc" | "ellipse" }>) {
  if (primitive.type === "ellipse") {
    const rotation = primitive.geometry.rotation * Math.PI / 180;
    return parametricCurvePoints(
      primitive.geometry.center,
      primitive.geometry.radiusX * Math.cos(rotation),
      -primitive.geometry.radiusY * Math.sin(rotation),
      primitive.geometry.radiusX * Math.sin(rotation),
      primitive.geometry.radiusY * Math.cos(rotation),
      0,
      Math.PI * 2,
      primitive.bounds
    );
  }
  const start = primitive.geometry.startAngle * Math.PI / 180;
  const end = primitive.geometry.endAngle * Math.PI / 180;
  const positiveSweep = ((end - start) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
  const negativeSweep = -(((start - end) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2);
  const sweep = primitive.geometry.counterClockwise ? positiveSweep : negativeSweep;
  return parametricCurvePoints(
    primitive.geometry.center,
    primitive.geometry.radius,
    0,
    0,
    primitive.geometry.radius,
    start,
    sweep,
    primitive.bounds
  );
}

function appendTileOccurrence(
  primitive: CadScenePrimitive,
  cell: OccupiedTileCell,
  width: number,
  height: number,
  tiles: Map<string, TilePrimitiveAccumulator>,
  onOccurrencesAdded?: (count: number) => void
): number {
  const cellBounds = tileCellBounds(cell.tileX, cell.tileY, width, height);
  const bounds = clippedBounds(primitive.bounds, cellBounds);
  if (!bounds) return 0;
  const lod = lodFor(primitive);
  const key = `${lod}:${cell.tileY}:${cell.tileX}`;
  const tile = tiles.get(key) ?? { tileX: cell.tileX, tileY: cell.tileY, lod, nextPart: 0, primitives: [] };
  tile.primitives.push({ ...primitive, bounds, clipBounds: cellBounds });
  tiles.set(key, tile);
  onOccurrencesAdded?.(1);
  return 1;
}

function appendPrimitiveToTiles(
  primitive: CadScenePrimitive,
  width: number,
  height: number,
  tiles: Map<string, TilePrimitiveAccumulator>,
  onOccurrencesAdded?: (count: number) => void
): number {
  let appended = 0;
  if (primitive.type === "line") {
    for (const fragment of segmentFragments(primitive.geometry.start, primitive.geometry.end, width, height)) {
      const cellBounds = tileCellBounds(fragment.tileX, fragment.tileY, width, height);
      const lod = lodFor(primitive);
      const key = `${lod}:${fragment.tileY}:${fragment.tileX}`;
      const tile = tiles.get(key) ?? {
        tileX: fragment.tileX, tileY: fragment.tileY, lod, nextPart: 0, primitives: []
      };
      tile.primitives.push({
        ...primitive,
        bounds: segmentBounds(fragment.start, fragment.end),
        clipBounds: cellBounds,
        geometry: { start: fragment.start, end: fragment.end }
      });
      tiles.set(key, tile);
      appended++;
      onOccurrencesAdded?.(1);
    }
    return appended;
  }
  if (primitive.type === "polyline") {
    const segmentCount = primitive.geometry.closed
      ? primitive.geometry.points.length
      : primitive.geometry.points.length - 1;
    for (let index = 0; index < segmentCount; index++) {
      const start = primitive.geometry.points[index];
      const end = primitive.geometry.points[(index + 1) % primitive.geometry.points.length];
      for (const fragment of segmentFragments(start, end, width, height)) {
        const cellBounds = tileCellBounds(fragment.tileX, fragment.tileY, width, height);
        const lod = lodFor(primitive);
        const key = `${lod}:${fragment.tileY}:${fragment.tileX}`;
        const tile = tiles.get(key) ?? {
          tileX: fragment.tileX, tileY: fragment.tileY, lod, nextPart: 0, primitives: []
        };
        tile.primitives.push({
          ...primitive,
          bounds: segmentBounds(fragment.start, fragment.end),
          clipBounds: cellBounds,
          geometry: { points: [fragment.start, fragment.end], closed: false }
        });
        tiles.set(key, tile);
        appended++;
        onOccurrencesAdded?.(1);
      }
    }
    return appended;
  }
  const cells = new Map<string, OccupiedTileCell>();
  let fillPolygon: readonly { x: number; y: number }[] | null = null;
  if (primitive.type === "rectangle" || primitive.type === "triangle") {
    const points = primitive.type === "rectangle" ? rectanglePoints(primitive) : primitive.geometry.points;
    for (let index = 0; index < points.length; index++) {
      addOccupiedSegment(cells, points[index], points[(index + 1) % points.length], width, height);
    }
    fillPolygon = points;
  } else if (primitive.type === "arc" || primitive.type === "ellipse") {
    const points = curvePoints(primitive);
    for (let index = 0; index < points.length - 1; index++) {
      addOccupiedSegment(cells, points[index], points[index + 1], width, height);
    }
    fillPolygon = primitive.type === "ellipse" ? points : [primitive.geometry.center, ...points];
  } else {
    const [minimumTileX, maximumTileX] = tileRange(primitive.bounds.minX, primitive.bounds.maxX, width);
    const [minimumTileY, maximumTileY] = tileRange(primitive.bounds.minY, primitive.bounds.maxY, height);
    for (let tileY = minimumTileY; tileY <= maximumTileY; tileY++) {
      for (let tileX = minimumTileX; tileX <= maximumTileX; tileX++) {
        cells.set(tileCellKey({ tileX, tileY }), { tileX, tileY });
      }
    }
  }
  if (primitive.style.fillColor !== null && fillPolygon) {
    addPolygonInteriorCells(cells, fillPolygon, width, height);
  }
  for (const cell of [...cells.values()].sort((left, right) =>
    left.tileY - right.tileY || left.tileX - right.tileX)) {
    appended += appendTileOccurrence(primitive, cell, width, height, tiles, onOccurrencesAdded);
  }
  return appended;
}

interface TilePartLimits {
  maximumByteSize: number;
  maximumPartsPerCell: number;
  maximumPartCount: number;
  maximumTotalByteSize: number;
}

interface TileOutputState {
  totalByteSize: number;
  assetIds: Set<string>;
  manifestAssetId: string;
}

function encodeTileAccumulator(
  tile: TilePrimitiveAccumulator,
  width: number,
  height: number,
  sceneId: string,
  tileAssetId: BuildCadSceneOptions["tileAssetId"],
  limits: TilePartLimits,
  outputState: TileOutputState,
  output: BuiltCadSceneTile[]
): void {
  let part = tile.nextPart;
  let tracker = new CadSceneTileSizeTracker(limits.maximumByteSize);
  let partPrimitives: CadScenePrimitive[] = [];

  const encodePart = (): void => {
    if (partPrimitives.length === 0) return;
    if (part >= limits.maximumPartsPerCell) {
      throw new Error("CAD scene tile part limit exceeded");
    }
    if (output.length >= limits.maximumPartCount) {
      throw new Error("CAD scene tile descriptor limit exceeded");
    }
    const payload = encodeTrustedCadSceneTile(partPrimitives);
    if (payload.byteLength !== tracker.byteSize || payload.byteLength > limits.maximumByteSize) {
      throw new Error("CAD scene tile size estimate mismatch");
    }
    const integrity = getCadSceneTileIntegrity(payload);
    const tileIdentity = { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part };
    const descriptor: CadSceneTile = {
      version: CAD_SCENE_VERSION,
      sceneId,
      ...tileIdentity,
      assetId: tileAssetId?.(tileIdentity) ?? deterministicUuid(
        `${sceneId}:tile:${tile.lod}:${tile.tileX}:${tile.tileY}:${part}`
      ),
      primitiveCount: partPrimitives.length,
      ...integrity,
      bounds: tileCellBounds(tile.tileX, tile.tileY, width, height)
    };
    if (outputState.totalByteSize + payload.byteLength > limits.maximumTotalByteSize) {
      throw new Error("CAD scene tile output byte limit exceeded");
    }
    if (descriptor.assetId === outputState.manifestAssetId) {
      throw new Error("CAD scene assetId must be unique");
    }
    if (outputState.assetIds.has(descriptor.assetId)) {
      throw new Error("CAD scene tile assetId must be unique");
    }
    outputState.totalByteSize += payload.byteLength;
    outputState.assetIds.add(descriptor.assetId);
    output.push({ descriptor, payload });
    part++;
    tile.nextPart = part;
    partPrimitives = [];
    tracker = new CadSceneTileSizeTracker(limits.maximumByteSize);
  };

  for (let index = 0; index < tile.primitives.length; index++) {
    const primitive = tile.primitives[index]!;
    tile.primitives[index] = null;
    if (!tracker.tryAdd(primitive)) {
      if (partPrimitives.length === 0) {
        throw new Error("CAD scene primitive exceeds tile byte size limit");
      }
      encodePart();
      if (!tracker.tryAdd(primitive)) {
        throw new Error("CAD scene primitive exceeds tile byte size limit");
      }
    }
    partPrimitives.push(primitive);
  }
  tile.primitives.length = 0;
  encodePart();
}

function flushRetainedTileOccurrences(
  tileAccumulators: Map<string, TilePrimitiveAccumulator>,
  retainedOccurrenceCount: number,
  width: number,
  height: number,
  sceneId: string,
  tileAssetId: BuildCadSceneOptions["tileAssetId"],
  limits: TilePartLimits,
  outputState: TileOutputState,
  output: BuiltCadSceneTile[],
  maximumRetainedOccurrences: number
): number {
  if (retainedOccurrenceCount < maximumRetainedOccurrences) return retainedOccurrenceCount;
  const candidates = [...tileAccumulators.values()]
    .filter(tile => tile.primitives.length > 0)
    .sort((left, right) => right.primitives.length - left.primitives.length ||
      left.lod - right.lod || left.tileY - right.tileY || left.tileX - right.tileX);
  for (const tile of candidates) {
    const released = tile.primitives.length;
    encodeTileAccumulator(tile, width, height, sceneId, tileAssetId, limits, outputState, output);
    retainedOccurrenceCount -= released;
    if (retainedOccurrenceCount <= Math.floor(maximumRetainedOccurrences / 2)) break;
  }
  return retainedOccurrenceCount;
}

function canonicalManifestPayload(manifest: Omit<CadSceneManifest, "byteSize" | "sha256">): Buffer {
  return Buffer.from(JSON.stringify(manifest), "utf8");
}

function createProjection(regionBounds: SceneBounds, options: BuildCadSceneOptions) {
  const mapSize = normalizeCadMapSize(regionBounds);
  const sourceWidth = regionBounds.maxX - regionBounds.minX;
  const sourceHeight = regionBounds.maxY - regionBounds.minY;
  const scale = Math.min((mapSize.width - 2 * mapSize.padding) / sourceWidth,
    (mapSize.height - 2 * mapSize.padding) / sourceHeight);
  const projectedWidth = sourceWidth * scale;
  const projectedHeight = sourceHeight * scale;
  const offsetX = (mapSize.width - projectedWidth) / 2;
  const offsetY = (mapSize.height - projectedHeight) / 2;
  const transform: CadSceneTransform = {
    scaleX: scale, scaleY: -scale,
    translateX: offsetX - regionBounds.minX * scale,
    translateY: offsetY + regionBounds.maxY * scale
  };
  const context: ProjectionContext = {
    transform,
    contentBounds: { minX: round(offsetX), minY: round(offsetY), maxX: round(offsetX + projectedWidth), maxY: round(offsetY + projectedHeight) },
    simplifyTolerance: options.simplifyTolerance ?? 0.01,
    sampleSpline: createCadSplineSampler(options.maxSplineSamples ?? CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT)
  };
  return { mapSize, context, transform };
}

function* projectedEntities(document: NormalizedCadDocument, context: ProjectionContext, options: BuildCadSceneOptions): Generator<CadSemanticEntity> {
  const maximum = options.maxExpandedEntities ?? CAD_SCENE_MAX_EXPANDED_PRIMITIVES;
  const selectedMaximum = options.maxSelectedPrimitives ?? CAD_SCENE_MAX_SELECTED_PRIMITIVES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > CAD_SCENE_MAX_EXPANDED_PRIMITIVES ||
      !Number.isSafeInteger(selectedMaximum) || selectedMaximum < 1 || selectedMaximum > CAD_SCENE_MAX_SELECTED_PRIMITIVES) {
    throw new Error("Invalid CAD semantic entity limit");
  }
  let selected = 0;
  for (const source of iterateCadDocumentExpansion(document, {
    maxRenderedEntities: maximum, maxBlockDepth: options.maxBlockDepth ?? 32, checkBudget: options.checkBudget
  })) {
    options.checkBudget?.();
    if (!source) continue;
    const primitives = convertEntity(source, context);
    if (primitives.length && !primitives.some(primitive => intersects(primitive.bounds, context.contentBounds))) continue;
    selected += primitives.length;
    // The legacy display path applies its limit after deduplication below.
    // Canonical capture must count every distinct source before deduplication.
    if (context.preserveGeometry && selected > selectedMaximum) throw new Error("CAD selected primitive limit exceeded");
    yield { source, primitives, transform: context.transform };
  }
}

/** One expansion, one source at a time; no tile payloads or whole-scene arrays. */
export function* iterateCadSemanticEntities(document: NormalizedCadDocument, regionBounds: SceneBounds, options: BuildCadSceneOptions): Generator<CadSemanticEntity> {
  const { context } = createProjection(regionBounds, options);
  context.preserveGeometry = true;
  yield* projectedEntities(document, context, options);
}

function displayPrimitive(primitive: CadScenePrimitive, source: ExpandedCadEntity, tolerance: number): CadScenePrimitive {
  if (primitive.type !== "polyline") return primitive;
  const entity = source.entity;
  if (entity.type === "lwpolyline" || entity.type === "polyline") {
    const segments = entity.closed ? entity.vertices.length : entity.vertices.length - 1;
    for (let index = 0; index < segments; index++) {
      if (cadBulgeArc(entity.vertices[index], entity.vertices[(index + 1) % entity.vertices.length], entity.vertices[index].bulge)) return primitive;
    }
  } else if (entity.type !== "spline" && entity.type !== "wipeout") return primitive;
  const points = simplifyPoints(primitive.geometry.points, primitive.geometry.closed, tolerance);
  const bounds = entity.type === "spline" || entity.type === "wipeout" ? boundsOfPoints(points) : primitive.bounds;
  return classifyPolyline({ ...primitive, bounds }, points, primitive.geometry.closed);
}

export function buildCadScene(
  document: NormalizedCadDocument,
  region: CadDetectedRegion,
  options: BuildCadSceneOptions
): BuiltCadScene {
  const maxSelectedPrimitives = options.maxSelectedPrimitives ?? CAD_SCENE_MAX_SELECTED_PRIMITIVES;
  const simplifyTolerance = options.simplifyTolerance ?? 0.01;
  const maximumTileByteSize = options.maxTileByteSize ?? CAD_SCENE_MAX_TILE_BYTE_SIZE;
  const maximumPartsPerCell = options.maxTilePartsPerCell ?? CAD_SCENE_MAX_PARTS_PER_TILE;
  const maximumTilePartCount = options.maxTilePartCount ?? CAD_SCENE_MAX_TILE_PART_COUNT;
  const maximumTotalTileBytes = options.maxTotalTileBytes ?? CAD_SCENE_MAX_TOTAL_TILE_BYTES;
  const maximumRetainedTileOccurrences = options.maxRetainedTileOccurrences
    ?? MAX_RETAINED_TILE_OCCURRENCES;
  if (!Number.isSafeInteger(maxSelectedPrimitives) || maxSelectedPrimitives < 1 ||
      maxSelectedPrimitives > CAD_SCENE_MAX_SELECTED_PRIMITIVES) {
    throw new Error("Invalid CAD selected primitive limit");
  }
  if (!Number.isFinite(simplifyTolerance) || simplifyTolerance < 0) {
    throw new Error("Invalid CAD simplify tolerance");
  }
  if (!Number.isSafeInteger(maximumPartsPerCell) || maximumPartsPerCell < 1 ||
      maximumPartsPerCell > CAD_SCENE_MAX_PARTS_PER_TILE) {
    throw new Error("Invalid CAD scene tile part limit");
  }
  if (!Number.isSafeInteger(maximumTilePartCount) || maximumTilePartCount < 1 ||
      maximumTilePartCount > CAD_SCENE_MAX_TILE_PART_COUNT) {
    throw new Error("Invalid CAD scene tile descriptor limit");
  }
  if (!Number.isSafeInteger(maximumTotalTileBytes) || maximumTotalTileBytes < 1 ||
      maximumTotalTileBytes > CAD_SCENE_MAX_TOTAL_TILE_BYTES) {
    throw new Error("Invalid CAD scene tile output byte limit");
  }
  if (!Number.isSafeInteger(maximumRetainedTileOccurrences) || maximumRetainedTileOccurrences < 1 ||
      maximumRetainedTileOccurrences > MAX_RETAINED_TILE_OCCURRENCES) {
    throw new Error("Invalid CAD retained tile occurrence limit");
  }
  new CadSceneTileSizeTracker(maximumTileByteSize);

  const { mapSize, transform, context } = createProjection(region.bounds, options);
  context.preserveGeometry = Boolean(options.onSemanticEntity);

  const tilePrimitives = new Map<string, TilePrimitiveAccumulator>();
  const tiles: BuiltCadSceneTile[] = [];
  const manifestAssetId = options.manifestAssetId ?? deterministicUuid(`${options.sceneId}:manifest`);
  const partLimits: TilePartLimits = {
    maximumByteSize: maximumTileByteSize,
    maximumPartsPerCell,
    maximumPartCount: maximumTilePartCount,
    maximumTotalByteSize: maximumTotalTileBytes
  };
  const outputState: TileOutputState = {
    totalByteSize: 0,
    assetIds: new Set(),
    manifestAssetId
  };
  const deduplicationDigests = new Set<string>();
  let selectedPrimitiveCount = 0;
  let retainedOccurrenceCount = 0;
  const onOccurrencesAdded = (count: number): void => {
    retainedOccurrenceCount += count;
    retainedOccurrenceCount = flushRetainedTileOccurrences(
      tilePrimitives,
      retainedOccurrenceCount,
      mapSize.width,
      mapSize.height,
      options.sceneId,
      options.tileAssetId,
      partLimits,
      outputState,
      tiles,
      maximumRetainedTileOccurrences
    );
  };
  for (const semantic of projectedEntities(document, context, options)) {
    const result: unknown = options.onSemanticEntity?.(semantic);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      throw new Error("CAD semantic hook must be synchronous; use the async element iterator for backpressure");
    }
    for (const sourcePrimitive of semantic.primitives) {
      const converted = options.onSemanticEntity ? displayPrimitive(sourcePrimitive, semantic.source, simplifyTolerance) : sourcePrimitive;
      if (!intersects(converted.bounds, context.contentBounds)) continue;
      const digest = deduplicationDigest(converted);
      if (deduplicationDigests.has(digest)) continue;
      deduplicationDigests.add(digest);
      selectedPrimitiveCount++;
      if (selectedPrimitiveCount > maxSelectedPrimitives) {
        throw new Error("CAD selected primitive limit exceeded");
      }
      for (const primitive of splitOversizedPolyline(converted)) {
        appendPrimitiveToTiles(
          primitive,
          mapSize.width,
          mapSize.height,
          tilePrimitives,
          onOccurrencesAdded
        );
      }
    }
  }

  const sortedTileAccumulators = [...tilePrimitives.values()]
    .sort((left, right) => left.lod - right.lod || left.tileY - right.tileY || left.tileX - right.tileX);
  tilePrimitives.clear();
  for (const tile of sortedTileAccumulators) {
    encodeTileAccumulator(
      tile,
      mapSize.width,
      mapSize.height,
      options.sceneId,
      options.tileAssetId,
      partLimits,
      outputState,
      tiles
    );
  }
  tiles.sort((left, right) => left.descriptor.lod - right.descriptor.lod ||
    left.descriptor.tileY - right.descriptor.tileY ||
    left.descriptor.tileX - right.descriptor.tileX ||
    left.descriptor.part - right.descriptor.part);

  const manifestBody: Omit<CadSceneManifest, "byteSize" | "sha256"> = {
    version: CAD_SCENE_VERSION,
    sceneId: options.sceneId,
    regionId: region.regionId,
    manifestAssetId,
    width: mapSize.width,
    height: mapSize.height,
    padding: mapSize.padding,
    gridSize: mapSize.gridSize,
    tileSize: CAD_SCENE_TILE_SIZE,
    lodMode: "additive",
    primitiveCount: selectedPrimitiveCount,
    tileCount: tiles.length,
    sourceBounds: { ...region.bounds },
    transform,
    tiles: tiles.map(tile => tile.descriptor)
  };
  const manifestPayload = canonicalManifestPayload(manifestBody);
  const manifest: CadSceneManifest = {
    ...manifestBody,
    byteSize: manifestPayload.byteLength,
    sha256: createHash("sha256").update(manifestPayload).digest("hex")
  };
  cadSceneManifestSchema.parse(manifest);
  return { manifest, manifestPayload, tiles };
}
