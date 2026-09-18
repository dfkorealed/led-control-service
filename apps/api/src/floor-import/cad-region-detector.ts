import { createHash } from "node:crypto";
import {
  cadBulgeArc,
  computeCadBounds,
  createCadSplineSampler,
  cadExpandedSourceId,
  iterateCadDocumentExpansion,
  transformPoint
} from "./cad-geometry";
import type { CadMatrix, ExpandedCadEntity } from "./cad-geometry";
import { CAD_MAX_PARSED_ENTITIES, CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT } from "./cad-runtime-contract";
import type { CadBounds, CadPoint, CadPolylineVertex, NormalizedCadDocument, NormalizedCadEntity } from "./cad-types";

const DEFAULT_MAX_SPATIAL_BUCKETS = 200_000;
const MAX_FILLED_BUCKETS_PER_ENTITY = 1_024;
const MAX_BUCKETS_PER_SEGMENT = 4_096;
const MAX_SPARSE_PROXIMITY_STEPS = 200_000;
export const CAD_MAX_DETECTED_REGIONS = 16_384;

export interface CadDetectedRegion {
  regionId: string;
  bounds: CadBounds;
  primitiveCount: number;
  textCount: number;
  lightCandidateCount: number;
  area: number;
}

export interface CadRegionDetectionResult {
  regions: CadDetectedRegion[];
  excludedPrimitiveCount: number;
}

export interface CadRegionDetectionOptions {
  maxExpandedEntities?: number;
  maxBlockDepth?: number;
  maxSplineSamples?: number;
  maxSpatialBuckets?: number;
  lightCandidates?: readonly CadRegionLightCandidate[];
  checkBudget?: () => void;
}

export interface CadRegionLightCandidate {
  sourceEntityId: string;
  position: CadPoint;
}

export class CadRegionDetectionError extends Error {
  readonly code = "CAD_LIGHT_CANDIDATE_REGION_ASSIGNMENT";

  constructor() {
    super("CAD light candidate must map to exactly one detected region");
    this.name = "CadRegionDetectionError";
  }
}

interface GeometryRecord {
  expanded: ExpandedCadEntity;
  sourceEntityId: string;
  associationIds: string[];
  bounds: CadBounds;
  text: boolean;
  singletonPointNoise: boolean;
}

interface RegionAccumulator {
  sourceEntityIds: string[];
  associationIds: Set<string>;
  bounds: CadBounds;
  primitiveCount: number;
  textCount: number;
  singletonPointNoise: boolean;
}

interface SparseSegment {
  recordIndex: number;
  start: CadPoint;
  end: CadPoint;
}

interface ArcSpanner {
  center: CadPoint;
  cosine: CadPoint;
  sine: CadPoint;
  startAngle: number;
  sweepAngle: number;
}

interface SparseArc extends ArcSpanner {
  recordIndex: number;
}

type AnalyticPrimitive = ArcSpanner | { start: CadPoint; end: CadPoint };

class DisjointSet {
  private readonly parents: number[];
  private readonly ranks: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
    this.ranks = new Array(size).fill(0);
  }

  find(index: number): number {
    let root = index;
    while (this.parents[root] !== root) root = this.parents[root];
    while (this.parents[index] !== index) {
      const parent = this.parents[index];
      this.parents[index] = root;
      index = parent;
    }
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.ranks[leftRoot] < this.ranks[rightRoot]) this.parents[leftRoot] = rightRoot;
    else {
      this.parents[rightRoot] = leftRoot;
      if (this.ranks[leftRoot] === this.ranks[rightRoot]) this.ranks[leftRoot]++;
    }
  }
}

export function detectCadRegions(
  document: NormalizedCadDocument,
  options: CadRegionDetectionOptions = {}
): CadRegionDetectionResult {
  const maxExpandedEntities = options.maxExpandedEntities ?? CAD_MAX_PARSED_ENTITIES;
  const maxBlockDepth = options.maxBlockDepth ?? 32;
  const maxSpatialBuckets = options.maxSpatialBuckets ?? DEFAULT_MAX_SPATIAL_BUCKETS;
  if (!Number.isSafeInteger(maxSpatialBuckets) || maxSpatialBuckets < 1) {
    throw new Error("Invalid CAD region spatial bucket limit");
  }

  const sampleSpline = createCadSplineSampler(options.maxSplineSamples ?? CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT);
  const records: GeometryRecord[] = [];
  for (const item of iterateCadDocumentExpansion(document, {
    maxRenderedEntities: maxExpandedEntities,
    maxBlockDepth,
    checkBudget: options.checkBudget
  })) {
    if (!item) continue;
    const bounds = computeCadBounds([item], options.checkBudget, undefined, sampleSpline);
    records.push({
      expanded: item,
      sourceEntityId: item.sourceEntityId,
      associationIds: [
        item.sourceEntityId,
        ...(item.occurrencePath ?? []).map((_, index, path) => cadExpandedSourceId(path.slice(0, index + 1)))
      ],
      bounds,
      text: item.entity.type === "text" || item.entity.type === "mtext",
      singletonPointNoise: item.entity.type === "point"
    });
  }
  if (records.length === 0) return { regions: [], excludedPrimitiveCount: 0 };

  const positiveExtents = records
    .map(record => Math.hypot(
      record.bounds.maxX - record.bounds.minX,
      record.bounds.maxY - record.bounds.minY
    ))
    .filter(extent => extent > 0)
    .sort((left, right) => left - right);
  const documentDiagonal = Math.hypot(
    Math.max(0, document.bounds.maxX - document.bounds.minX),
    Math.max(0, document.bounds.maxY - document.bounds.minY)
  );
  const medianExtent = positiveExtents.length > 0
    ? positiveExtents[Math.floor(positiveExtents.length / 2)]
    : Math.max(1, documentDiagonal / 100);
  const cellSize = Math.max(1e-9, medianExtent * 4);
  const buckets = new Map<string, number>();
  const sparseSegments: SparseSegment[] = [];
  const sparseArcs: SparseArc[] = [];
  const sparseGeometry = new Map<number, AnalyticPrimitive[]>();
  const sets = new DisjointSet(records.length);
  const bucketCoordinate = (value: number) => Math.floor(value / cellSize);
  const addBucket = (x: number, y: number, recordIndex: number) => {
    const key = `${x},${y}`;
    const owner = buckets.get(key);
    if (owner === undefined) {
      if (buckets.size >= maxSpatialBuckets) throw new Error("CAD region spatial bucket limit exceeded");
      buckets.set(key, recordIndex);
    } else {
      sets.union(owner, recordIndex);
    }
  };

  records.forEach((record, recordIndex) => {
    const minX = bucketCoordinate(record.bounds.minX);
    const minY = bucketCoordinate(record.bounds.minY);
    const maxX = bucketCoordinate(record.bounds.maxX);
    const maxY = bucketCoordinate(record.bounds.maxY);
    const bucketCount = (maxX - minX + 1) * (maxY - minY + 1);
    if (bucketCount <= MAX_FILLED_BUCKETS_PER_ENTITY) {
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) addBucket(x, y, recordIndex);
      }
      return;
    }

    const geometry: AnalyticPrimitive[] = [];
    const sparseCount = sparseSegments.length + sparseArcs.length;
    indexExpandedGeometry(
      record.expanded,
      cellSize,
      sampleSpline,
      options.checkBudget,
      (x, y) => addBucket(x, y, recordIndex),
      (start, end) => sparseSegments.push({ recordIndex, start, end }),
      arc => sparseArcs.push({ recordIndex, ...arc }),
      primitive => geometry.push(primitive)
    );
    if (sparseSegments.length + sparseArcs.length > sparseCount) sparseGeometry.set(recordIndex, geometry);
  });

  for (const [key, owner] of buckets) {
    const separator = key.indexOf(",");
    const x = Number(key.slice(0, separator));
    const y = Number(key.slice(separator + 1));
    for (let deltaX = -1; deltaX <= 1; deltaX++) {
      for (let deltaY = -1; deltaY <= 1; deltaY++) {
        if (deltaX === 0 && deltaY === 0) continue;
        const neighbor = buckets.get(`${x + deltaX},${y + deltaY}`);
        if (neighbor !== undefined) sets.union(owner, neighbor);
      }
    }
  }

  if (sparseSegments.length > 0 || sparseArcs.length > 0) {
    const boundsIndex = new BoundsRangeIndex(records.map(record => record.bounds));
    let proximitySteps = 0;
    const checkProximityBudget = () => {
      options.checkBudget?.();
      if (++proximitySteps > MAX_SPARSE_PROXIMITY_STEPS) throw new Error("CAD sparse proximity work limit exceeded");
    };
    // Bounds only select candidate pairs. If both records contain sparse
    // geometry, all of their actual primitives (including short hatch edges)
    // participate in the narrow phase; neither direction may use box containment.
    for (const [leftIndex, leftGeometry] of sparseGeometry) {
      for (const rightIndex of boundsIndex.query(expandBounds(records[leftIndex].bounds, cellSize))) {
        const rightGeometry = sparseGeometry.get(rightIndex);
        if (rightIndex <= leftIndex || !rightGeometry) continue;
        checkProximityBudget();
        if (sets.find(leftIndex) === sets.find(rightIndex)) continue;
        if (leftGeometry.some(left => rightGeometry.some(right =>
          primitivesAreNear(left, right, cellSize, checkProximityBudget)))) {
          sets.union(leftIndex, rightIndex);
        }
      }
    }
    for (const sparse of sparseSegments) {
      const queryBounds = expandBounds(segmentBounds(sparse.start, sparse.end), cellSize);
      for (const recordIndex of boundsIndex.query(queryBounds)) {
        if (recordIndex === sparse.recordIndex || sparseGeometry.has(recordIndex)) continue;
        if (segmentIntersectsBounds(sparse.start, sparse.end, expandBounds(records[recordIndex].bounds, cellSize))) {
          sets.union(sparse.recordIndex, recordIndex);
        }
      }
    }
    for (const sparse of sparseArcs) {
      options.checkBudget?.();
      // The full transformed ellipse is a conservative broad phase only. The
      // signed arc/box intersection below rejects interior and omitted-sweep details.
      const extentX = Math.hypot(sparse.cosine.x, sparse.sine.x);
      const extentY = Math.hypot(sparse.cosine.y, sparse.sine.y);
      const queryBounds = expandBounds({
        minX: sparse.center.x - extentX, minY: sparse.center.y - extentY,
        maxX: sparse.center.x + extentX, maxY: sparse.center.y + extentY
      }, cellSize);
      for (const recordIndex of boundsIndex.query(queryBounds)) {
        options.checkBudget?.();
        if (recordIndex === sparse.recordIndex || sparseGeometry.has(recordIndex)) continue;
        if (arcIntersectsBounds(sparse, expandBounds(records[recordIndex].bounds, cellSize))) {
          sets.union(sparse.recordIndex, recordIndex);
        }
      }
    }
  }

  const components = new Map<number, RegionAccumulator>();
  records.forEach((record, index) => {
    const root = sets.find(index);
    const component = components.get(root);
    if (component) {
      component.sourceEntityIds.push(record.sourceEntityId);
      record.associationIds.forEach(associationId => component.associationIds.add(normalizeAssociationId(associationId)));
      component.primitiveCount++;
      if (record.text) component.textCount++;
      component.singletonPointNoise = false;
      includeBounds(component.bounds, record.bounds);
    } else {
      components.set(root, {
        sourceEntityIds: [record.sourceEntityId],
        associationIds: new Set(record.associationIds.map(normalizeAssociationId)),
        bounds: { ...record.bounds },
        primitiveCount: 1,
        textCount: record.text ? 1 : 0,
        singletonPointNoise: record.singletonPointNoise
      });
    }
  });

  const candidateAssociationIds = new Set(
    (options.lightCandidates ?? []).map(candidate => normalizeAssociationId(candidate.sourceEntityId))
  );
  const candidates: RegionAccumulator[] = [];
  const singletonNoise: RegionAccumulator[] = [];
  for (const component of components.values()) {
    const candidateRelated = [...component.associationIds].some(id => candidateAssociationIds.has(id));
    if (component.singletonPointNoise && regionArea(component.bounds) === 0 && !candidateRelated) {
      singletonNoise.push(component);
    } else {
      candidates.push(component);
    }
  }
  const excludedPrimitiveCount = singletonNoise.reduce(
    (sum, component) => sum + component.primitiveCount,
    0
  );
  if (candidates.length > CAD_MAX_DETECTED_REGIONS) throw new Error("CAD region count limit exceeded");
  let largestArea = 0;
  for (const component of candidates) {
    largestArea = Math.max(largestArea, regionArea(component.bounds));
  }
  const minimumExtent = Math.max(1e-9, cellSize * 1e-9, Math.sqrt(largestArea) * 1e-9);
  const detected = candidates.map(component => {
    const bounds = positiveRegionBounds(component.bounds, minimumExtent);
    return {
      region: {
        regionId: stableRegionId(component.sourceEntityIds),
        bounds,
        primitiveCount: component.primitiveCount,
        textCount: component.textCount,
        lightCandidateCount: 0,
        area: regionArea(bounds)
      },
      associationIds: component.associationIds
    };
  });
  detected.sort((left, right) => compareRegions(left.region, right.region));
  const regions = detected.map(item => item.region);

  const lightCandidates = options.lightCandidates ?? [];
  if (lightCandidates.length > maxExpandedEntities) throw new CadRegionDetectionError();
  if (lightCandidates.length > 0) {
    const regionsByAssociation = new Map<string, number[]>();
    detected.forEach((item, regionIndex) => {
      for (const associationId of item.associationIds) {
        const indexes = regionsByAssociation.get(associationId);
        if (indexes) indexes.push(regionIndex);
        else regionsByAssociation.set(associationId, [regionIndex]);
      }
    });
    const spatialIndex = new RegionBoundsIndex(regions);
    for (const candidate of lightCandidates) {
      if (!candidate.sourceEntityId || !Number.isFinite(candidate.position.x) || !Number.isFinite(candidate.position.y)) {
        throw new CadRegionDetectionError();
      }
      const related = regionsByAssociation.get(normalizeAssociationId(candidate.sourceEntityId)) ?? [];
      const matches = related.length === 1
        ? related
        : related.length > 1
          ? related.filter(regionIndex => contains(regions[regionIndex].bounds, candidate.position))
          : spatialIndex.query(candidate.position);
      if (matches.length !== 1) throw new CadRegionDetectionError();
      regions[matches[0]].lightCandidateCount++;
    }
  }
  return { regions, excludedPrimitiveCount };
}

function includeBounds(target: CadBounds, item: CadBounds): void {
  target.minX = Math.min(target.minX, item.minX);
  target.minY = Math.min(target.minY, item.minY);
  target.maxX = Math.max(target.maxX, item.maxX);
  target.maxY = Math.max(target.maxY, item.maxY);
}

function regionArea(bounds: CadBounds): number {
  return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
}

function positiveRegionBounds(bounds: CadBounds, minimumExtent: number): CadBounds {
  const result = { ...bounds };
  if (result.maxX <= result.minX) {
    const extent = Math.max(minimumExtent, Math.abs(result.minX) * Number.EPSILON * 4);
    result.minX -= extent / 2;
    result.maxX += extent / 2;
  }
  if (result.maxY <= result.minY) {
    const extent = Math.max(minimumExtent, Math.abs(result.minY) * Number.EPSILON * 4);
    result.minY -= extent / 2;
    result.maxY += extent / 2;
  }
  return result;
}

function stableRegionId(sourceEntityIds: readonly string[]): string {
  const canonicalIds = [...sourceEntityIds]
    .map(sourceEntityId => sourceEntityId.normalize("NFKC"))
    .sort(compareText);
  const hash = createHash("sha256");
  for (const sourceEntityId of canonicalIds) hash.update(sourceEntityId, "utf8").update("\0", "utf8");
  return `region-${hash.digest("hex").slice(0, 24)}`;
}

function contains(bounds: CadBounds, point: CadPoint): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

function compareRegions(left: CadDetectedRegion, right: CadDetectedRegion): number {
  return left.bounds.minX - right.bounds.minX ||
    left.bounds.minY - right.bounds.minY ||
    left.bounds.maxX - right.bounds.maxX ||
    left.bounds.maxY - right.bounds.maxY ||
    compareText(left.regionId, right.regionId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeAssociationId(value: string): string {
  return value.normalize("NFKC").toUpperCase();
}

interface RegionBoundsNode {
  center: number;
  overlaps: number[];
  left: RegionBoundsNode | null;
  right: RegionBoundsNode | null;
}

class RegionBoundsIndex {
  private readonly root: RegionBoundsNode | null;

  constructor(private readonly regions: readonly CadDetectedRegion[]) {
    this.root = this.build(regions.map((_, index) => index));
  }

  query(point: CadPoint): number[] {
    const matches: number[] = [];
    let node = this.root;
    while (node) {
      for (const regionIndex of node.overlaps) {
        if (contains(this.regions[regionIndex].bounds, point)) matches.push(regionIndex);
      }
      node = point.x < node.center ? node.left : point.x > node.center ? node.right : null;
    }
    return matches;
  }

  private build(regionIndexes: number[]): RegionBoundsNode | null {
    if (regionIndexes.length === 0) return null;
    const centers = regionIndexes
      .map(index => (this.regions[index].bounds.minX + this.regions[index].bounds.maxX) / 2)
      .sort((left, right) => left - right);
    const center = centers[Math.floor(centers.length / 2)];
    const left: number[] = [];
    const right: number[] = [];
    const overlaps: number[] = [];
    for (const regionIndex of regionIndexes) {
      const bounds = this.regions[regionIndex].bounds;
      if (bounds.maxX < center) left.push(regionIndex);
      else if (bounds.minX > center) right.push(regionIndex);
      else overlaps.push(regionIndex);
    }
    return { center, overlaps, left: this.build(left), right: this.build(right) };
  }
}

interface BoundsRangeNode {
  center: number;
  overlaps: number[];
  left: BoundsRangeNode | null;
  right: BoundsRangeNode | null;
}

class BoundsRangeIndex {
  private readonly root: BoundsRangeNode | null;

  constructor(private readonly bounds: readonly CadBounds[]) {
    this.root = this.build(bounds.map((_, index) => index));
  }

  query(target: CadBounds): number[] {
    const matches: number[] = [];
    const visit = (node: BoundsRangeNode | null) => {
      if (!node) return;
      for (const index of node.overlaps) {
        if (boundsOverlap(this.bounds[index], target)) matches.push(index);
      }
      if (target.minX <= node.center) visit(node.left);
      if (target.maxX >= node.center) visit(node.right);
    };
    visit(this.root);
    return matches;
  }

  private build(indexes: number[]): BoundsRangeNode | null {
    if (indexes.length === 0) return null;
    const centers = indexes
      .map(index => (this.bounds[index].minX + this.bounds[index].maxX) / 2)
      .sort((left, right) => left - right);
    const center = centers[Math.floor(centers.length / 2)];
    const left: number[] = [];
    const right: number[] = [];
    const overlaps: number[] = [];
    for (const index of indexes) {
      if (this.bounds[index].maxX < center) left.push(index);
      else if (this.bounds[index].minX > center) right.push(index);
      else overlaps.push(index);
    }
    return { center, overlaps, left: this.build(left), right: this.build(right) };
  }
}

function boundsOverlap(left: CadBounds, right: CadBounds): boolean {
  return left.minX <= right.maxX && left.maxX >= right.minX &&
    left.minY <= right.maxY && left.maxY >= right.minY;
}

function expandBounds(bounds: CadBounds, amount: number): CadBounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount
  };
}

function segmentBounds(start: CadPoint, end: CadPoint): CadBounds {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y)
  };
}

function segmentIntersectsBounds(start: CadPoint, end: CadPoint, bounds: CadBounds): boolean {
  let minimum = 0;
  let maximum = 1;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const clips: Array<[number, number]> = [
    [-deltaX, start.x - bounds.minX],
    [deltaX, bounds.maxX - start.x],
    [-deltaY, start.y - bounds.minY],
    [deltaY, bounds.maxY - start.y]
  ];
  for (const [direction, distance] of clips) {
    if (direction === 0) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function arcPointAt(arc: ArcSpanner, angle: number): CadPoint {
  return {
    x: arc.center.x + arc.cosine.x * Math.cos(angle) + arc.sine.x * Math.sin(angle),
    y: arc.center.y + arc.cosine.y * Math.cos(angle) + arc.sine.y * Math.sin(angle),
    z: 0
  };
}

interface PrimitiveChord {
  primitive: AnalyticPrimitive;
  start: CadPoint;
  end: CadPoint;
  error: number;
}

function primitiveChord(primitive: AnalyticPrimitive): PrimitiveChord {
  if (!("center" in primitive)) return { primitive, ...primitive, error: 0 };
  return {
    primitive,
    start: arcPointAt(primitive, primitive.startAngle),
    end: arcPointAt(primitive, primitive.startAngle + primitive.sweepAngle),
    // Linear interpolation error <= max|p''(t)| * sweep^2 / 8. The
    // Frobenius norm bounds p'' for any affine ellipse, not just circles.
    error: Math.hypot(primitive.cosine.x, primitive.cosine.y, primitive.sine.x, primitive.sine.y) *
      primitive.sweepAngle ** 2 / 8
  };
}

function chordDistance(left: PrimitiveChord, right: PrimitiveChord): number {
  const dx = left.end.x - left.start.x;
  const dy = left.end.y - left.start.y;
  const ex = right.end.x - right.start.x;
  const ey = right.end.y - right.start.y;
  const qx = right.start.x - left.start.x;
  const qy = right.start.y - left.start.y;
  const cross = dx * ey - dy * ex;
  if (cross !== 0) {
    const t = (qx * ey - qy * ex) / cross;
    const u = (qx * dy - qy * dx) / cross;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  const pointDistance = (point: CadPoint, chord: PrimitiveChord) => {
    const x = chord.end.x - chord.start.x;
    const y = chord.end.y - chord.start.y;
    const lengthSquared = x * x + y * y;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
      ((point.x - chord.start.x) * x + (point.y - chord.start.y) * y) / lengthSquared));
    return Math.hypot(point.x - chord.start.x - t * x, point.y - chord.start.y - t * y);
  };
  return Math.min(pointDistance(left.start, right), pointDistance(left.end, right),
    pointDistance(right.start, left), pointDistance(right.end, left));
}

function primitivesAreNear(
  left: AnalyticPrimitive, right: AnalyticPrimitive, proximity: number, checkBudget: () => void
): boolean {
  const pending: Array<[PrimitiveChord, PrimitiveChord]> = [[primitiveChord(left), primitiveChord(right)]];
  while (pending.length > 0) {
    checkBudget();
    const [a, b] = pending.pop()!;
    const error = a.error + b.error;
    const distance = chordDistance(a, b);
    const epsilon = Math.max(proximity * 1e-6, Number.EPSILON * 64 * Math.max(
      1, Math.abs(a.start.x), Math.abs(a.start.y), Math.abs(a.end.x), Math.abs(a.end.y),
      Math.abs(b.start.x), Math.abs(b.start.y), Math.abs(b.end.x), Math.abs(b.end.y)
    ));
    if (distance - error > proximity + epsilon) continue;
    if (distance + error <= proximity || error <= epsilon) return true;
    const split = a.error >= b.error ? a : b;
    if (!("center" in split.primitive)) continue;
    const arc = split.primitive;
    const sweepAngle = arc.sweepAngle / 2;
    const first = primitiveChord({ ...arc, sweepAngle });
    const second = primitiveChord({ ...arc, startAngle: arc.startAngle + sweepAngle, sweepAngle });
    // Depth-first refinement keeps only a logarithmic stack. The global work
    // cap fails closed instead of guessing a merge on adversarial near-coincidence.
    if (split === a) pending.push([second, b], [first, b]);
    else pending.push([a, second], [a, first]);
  }
  return false;
}

function arcIntersectsBounds(arc: ArcSpanner, bounds: CadBounds): boolean {
  const pointAt = (angle: number) => arcPointAt(arc, angle);
  // Root evaluation at tangencies can land a few ULPs outside the box. This
  // roundoff allowance scales with coordinates, not the spatial proximity radius.
  const tolerance = Number.EPSILON * 16 * Math.max(
    1, Math.abs(arc.center.x), Math.abs(arc.center.y),
    Math.hypot(arc.cosine.x, arc.sine.x), Math.hypot(arc.cosine.y, arc.sine.y)
  );
  const paddedBounds = expandBounds(bounds, tolerance);
  if (contains(paddedBounds, pointAt(arc.startAngle)) ||
      contains(paddedBounds, pointAt(arc.startAngle + arc.sweepAngle))) return true;

  const onSweep = (angle: number) => {
    const turn = 2 * Math.PI;
    const distance = arc.sweepAngle >= 0 ? angle - arc.startAngle : arc.startAngle - angle;
    const normalized = ((distance % turn) + turn) % turn;
    return normalized <= Math.abs(arc.sweepAngle) + 1e-12 || turn - normalized <= 1e-12;
  };
  // Each box edge has at most two roots of a*cos(t) + b*sin(t) = offset.
  // Endpoints plus these roots suffice for continuous arc/box intersection,
  // including reflections, sheared ellipses and collapsed affine transforms.
  for (const axis of ["x", "y"] as const) {
    const amplitude = Math.hypot(arc.cosine[axis], arc.sine[axis]);
    if (amplitude === 0) continue;
    const phase = Math.atan2(arc.sine[axis], arc.cosine[axis]);
    const edges = axis === "x" ? [bounds.minX, bounds.maxX] : [bounds.minY, bounds.maxY];
    for (const edge of edges) {
      const offset = edge - arc.center[axis];
      if (Math.abs(offset) > amplitude + tolerance) continue;
      const delta = Math.acos(Math.max(-1, Math.min(1, offset / amplitude)));
      for (const angle of [phase - delta, phase + delta]) {
        if (onSweep(angle) && contains(paddedBounds, pointAt(angle))) return true;
      }
    }
  }
  return false;
}

type SplineSampler = (entity: Extract<NormalizedCadEntity, { type: "spline" }>) => readonly CadPoint[];

function indexExpandedGeometry(
  expanded: ExpandedCadEntity,
  cellSize: number,
  sampleSpline: SplineSampler,
  checkBudget: (() => void) | undefined,
  addBucket: (x: number, y: number) => void,
  addSparseSegment: (start: CadPoint, end: CadPoint) => void,
  addSparseArc: (arc: ArcSpanner) => void,
  addPrimitive: (primitive: AnalyticPrimitive) => void
): void {
  const { entity, matrix } = expanded;
  let emitted = false;
  const segment = (start: CadPoint, end: CadPoint) => {
    emitted = true;
    const transformedStart = transformPoint(matrix, start);
    const transformedEnd = transformPoint(matrix, end);
    addPrimitive({ start: transformedStart, end: transformedEnd });
    traverseSegmentBuckets(
      transformedStart,
      transformedEnd,
      cellSize,
      checkBudget,
      addBucket,
      addSparseSegment
    );
  };
  const arc = (center: CadPoint, radius: number, startAngle: number, sweepAngle: number) => {
    emitted = true;
    checkBudget?.();
    // Decide before cell-sized tessellation: otherwise every tiny chord passes
    // the segment cutoff and a huge curve still enumerates millions of cells.
    // The Frobenius norm bounds affine stretch even for nested/sheared INSERTs.
    const arcLengthBound = Math.abs(radius * sweepAngle) * Math.PI / 180 *
      Math.hypot(matrix.a, matrix.b, matrix.c, matrix.d);
    const primitive: ArcSpanner = {
      center: transformPoint(matrix, center),
      cosine: { x: radius * matrix.a, y: radius * matrix.b, z: 0 },
      sine: { x: radius * matrix.c, y: radius * matrix.d, z: 0 },
      startAngle: startAngle * Math.PI / 180,
      sweepAngle: sweepAngle * Math.PI / 180
    };
    addPrimitive(primitive);
    if (arcLengthBound / cellSize > MAX_BUCKETS_PER_SEGMENT) {
      addSparseArc(primitive);
      return;
    }
    visitArcSegments(center, radius, startAngle, sweepAngle, matrix, cellSize, checkBudget, (start, end) => {
      traverseSegmentBuckets(start, end, cellSize, checkBudget, addBucket, addSparseSegment);
    });
  };
  const polyline = (vertices: readonly CadPolylineVertex[], closed: boolean) => {
    const count = closed ? vertices.length : Math.max(0, vertices.length - 1);
    for (let index = 0; index < count; index++) {
      const start = vertices[index];
      const end = vertices[(index + 1) % vertices.length];
      const bulge = cadBulgeArc(start, end, start.bulge);
      if (bulge) arc(bulge.center, bulge.radius, bulge.startAngle, bulge.sweepAngle);
      else segment(start, end);
    }
  };

  if (entity.type === "line") segment(entity.start, entity.end);
  else if (entity.type === "lwpolyline" || entity.type === "polyline") polyline(entity.vertices, entity.closed);
  else if (entity.type === "spline") {
    const points = sampleSpline(entity);
    for (let index = 1; index < points.length; index++) segment(points[index - 1], points[index]);
  } else if (entity.type === "wipeout") polyline(entity.vertices.map(point => ({ ...point, bulge: 0 })), true);
  else if (entity.type === "hatch") {
    for (const loop of entity.loops) {
      if (loop.type === "polyline") polyline(loop.vertices, loop.closed);
      else for (const edge of loop.edges) {
        if (edge.type === "line") segment(edge.start, edge.end);
        else {
          const counterClockwiseSweep = ((edge.endAngle - edge.startAngle) % 360 + 360) % 360 || 360;
          arc(edge.center, edge.radius, edge.startAngle, edge.counterClockwise
            ? counterClockwiseSweep
            : -(360 - counterClockwiseSweep || 360));
        }
      }
    }
  } else if (entity.type === "circle") arc(entity.center, entity.radius, 0, 360);
  else if (entity.type === "arc") {
    arc(entity.center, entity.radius, entity.startAngle, ((entity.endAngle - entity.startAngle) % 360 + 360) % 360);
  }

  if (emitted) return;
  const { minX, minY, maxX, maxY } = computeCadBounds([expanded], checkBudget, undefined, sampleSpline);
  if (minX === maxX && minY === maxY) {
    addBucket(Math.floor(minX / cellSize), Math.floor(minY / cellSize));
    return;
  }
  const corners = [
    { x: minX, y: minY, z: 0 }, { x: maxX, y: minY, z: 0 },
    { x: maxX, y: maxY, z: 0 }, { x: minX, y: maxY, z: 0 }
  ];
  for (let index = 0; index < corners.length; index++) {
    addPrimitive({ start: corners[index], end: corners[(index + 1) % corners.length] });
    traverseSegmentBuckets(
      corners[index],
      corners[(index + 1) % corners.length],
      cellSize,
      checkBudget,
      addBucket,
      addSparseSegment
    );
  }
}

function visitArcSegments(
  center: CadPoint,
  radius: number,
  startAngle: number,
  sweepAngle: number,
  matrix: CadMatrix,
  cellSize: number,
  checkBudget: (() => void) | undefined,
  visit: (start: CadPoint, end: CadPoint) => void
): void {
  const scale = Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
  const arcLength = radius * Math.abs(sweepAngle) * Math.PI / 180 * scale;
  const steps = Math.max(1, Math.ceil(arcLength / Math.max(cellSize / 2, 1e-9)));
  const pointAt = (step: number) => {
    const radians = (startAngle + sweepAngle * step / steps) * Math.PI / 180;
    return transformPoint(matrix, {
      x: center.x + radius * Math.cos(radians),
      y: center.y + radius * Math.sin(radians),
      z: center.z
    });
  };
  let previous = pointAt(0);
  for (let step = 1; step <= steps; step++) {
    checkBudget?.();
    const current = pointAt(step);
    visit(previous, current);
    previous = current;
  }
}

function traverseSegmentBuckets(
  start: CadPoint,
  end: CadPoint,
  cellSize: number,
  checkBudget: (() => void) | undefined,
  visit: (x: number, y: number) => void,
  addSparseSegment: (start: CadPoint, end: CadPoint) => void
): void {
  let x = Math.floor(start.x / cellSize);
  let y = Math.floor(start.y / cellSize);
  const endX = Math.floor(end.x / cellSize);
  const endY = Math.floor(end.y / cellSize);
  if (Math.abs(endX - x) + Math.abs(endY - y) + 1 > MAX_BUCKETS_PER_SEGMENT) {
    visit(x, y);
    visit(endX, endY);
    addSparseSegment(start, end);
    return;
  }
  visit(x, y);
  if (x === endX && y === endY) return;

  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const stepX = Math.sign(deltaX);
  const stepY = Math.sign(deltaY);
  const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : cellSize / Math.abs(deltaX);
  const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : cellSize / Math.abs(deltaY);
  let tMaxX = stepX === 0
    ? Number.POSITIVE_INFINITY
    : ((x + (stepX > 0 ? 1 : 0)) * cellSize - start.x) / deltaX;
  let tMaxY = stepY === 0
    ? Number.POSITIVE_INFINITY
    : ((y + (stepY > 0 ? 1 : 0)) * cellSize - start.y) / deltaY;

  while (x !== endX || y !== endY) {
    checkBudget?.();
    if (tMaxX < tMaxY) {
      x += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      y += stepY;
      tMaxY += tDeltaY;
    } else {
      const nextX = x + stepX;
      const nextY = y + stepY;
      visit(nextX, y);
      visit(x, nextY);
      x = nextX;
      y = nextY;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }
    visit(x, y);
  }
}
