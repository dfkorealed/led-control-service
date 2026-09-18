import { computeCadBounds, createCadSplineSampler, iterateCadGeometryExpansion } from "./cad-geometry";
import { CAD_MAX_PARSED_ENTITIES, CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT } from "./cad-runtime-contract";
import type { CadBounds, CadPoint, NormalizedCadDocument } from "./cad-types";

const MAX_MAP_WIDTH = 2_400;
const MAX_MAP_HEIGHT = 1_600;
const MIN_MAP_EDGE = 800;
const MAP_PADDING = 40;

interface CadViewportProjection {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface PrimaryCadBoundsSelection {
  bounds: CadBounds;
  excludedEntityCount: number;
  totalEntityCount: number;
}

interface SpatialBucket {
  x: number;
  y: number;
  key: string;
  count: number;
  bounds: CadBounds;
  lengthScore: number;
  areaScore: number;
  visit: number;
}

interface SpatialCluster {
  count: number;
  bounds: CadBounds;
  lengthScore: number;
  areaScore: number;
  score: number;
  anchorX: number;
  anchorY: number;
}

function emptyBounds(): CadBounds {
  return { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY };
}

function includeBounds(target: CadBounds, item: CadBounds): void {
  target.minX = Math.min(target.minX, item.minX);
  target.minY = Math.min(target.minY, item.minY);
  target.maxX = Math.max(target.maxX, item.maxX);
  target.maxY = Math.max(target.maxY, item.maxY);
}

function boundsGap(left: CadBounds, right: CadBounds): number {
  const x = Math.max(0, left.minX - right.maxX, right.minX - left.maxX);
  const y = Math.max(0, left.minY - right.maxY, right.minY - left.maxY);
  return Math.hypot(x, y);
}

export function selectPrimaryCadBounds(
  document: NormalizedCadDocument,
  options: {
    maxRenderedEntities?: number;
    maxBlockDepth?: number;
    maxSplineSamples?: number;
    maxSpatialBuckets?: number;
    maxCoordinateMagnitude?: number;
    checkBudget?: () => void;
  } = {}
): PrimaryCadBoundsSelection {
  const maxRenderedEntities = options.maxRenderedEntities ?? CAD_MAX_PARSED_ENTITIES;
  const maxBlockDepth = options.maxBlockDepth ?? 32;
  const maxSpatialBuckets = options.maxSpatialBuckets ?? 200_000;
  const sampleSpline = createCadSplineSampler(options.maxSplineSamples ?? CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT);
  const expansionOptions = { maxRenderedEntities, maxBlockDepth, checkBudget: options.checkBudget };
  const completeBounds = emptyBounds();
  const extentHistogram = new Map<number, number>();
  let nonZeroExtentCount = 0;
  let totalEntityCount = 0;
  for (const item of iterateCadGeometryExpansion(document, expansionOptions)) {
    const bounds = computeCadBounds([item], options.checkBudget, undefined, sampleSpline);
    if (options.maxCoordinateMagnitude !== undefined && Object.values(bounds).some(value => Math.abs(value) > options.maxCoordinateMagnitude!)) {
      throw new Error("DXF transformed coordinate limit exceeded");
    }
    includeBounds(completeBounds, bounds);
    totalEntityCount++;
    const extent = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    if (extent > 0) {
      const bin = Math.floor(Math.log2(extent));
      extentHistogram.set(bin, (extentHistogram.get(bin) ?? 0) + 1);
      nonZeroExtentCount++;
    }
  }
  if (totalEntityCount === 0) return { bounds: document.bounds, excludedEntityCount: 0, totalEntityCount };
  if (totalEntityCount < 3) return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };

  if (nonZeroExtentCount === 0) return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };
  const medianRank = Math.floor(nonZeroExtentCount / 2);
  let seen = 0;
  let medianBin = 0;
  for (const bin of [...extentHistogram.keys()].sort((left, right) => left - right)) {
    seen += extentHistogram.get(bin)!;
    if (seen > medianRank) { medianBin = bin; break; }
  }
  const medianExtent = 2 ** (medianBin + 0.5);
  const cellSize = Math.max(1e-9, medianExtent * 4);
  const buckets = new Map<string, SpatialBucket>();
  const bucketCoordinate = (value: number) => Math.floor(value / cellSize);
  for (const item of iterateCadGeometryExpansion(document, expansionOptions)) {
    const bounds = computeCadBounds([item], options.checkBudget, undefined, sampleSpline);
    const width = Math.max(0, bounds.maxX - bounds.minX);
    const height = Math.max(0, bounds.maxY - bounds.minY);
    const x = bucketCoordinate((bounds.minX + bounds.maxX) / 2);
    const y = bucketCoordinate((bounds.minY + bounds.maxY) / 2);
    const key = `${x},${y}`;
    const bucket = buckets.get(key);
    const lengthScore = Math.min(16, 2 * (width + height) / medianExtent);
    const areaScore = Math.min(64, width * height / (medianExtent * medianExtent));
    if (bucket) {
      bucket.count++;
      bucket.lengthScore += lengthScore;
      bucket.areaScore += areaScore;
      includeBounds(bucket.bounds, bounds);
    } else {
      if (buckets.size >= maxSpatialBuckets) return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };
      buckets.set(key, { x, y, key, count: 1, bounds: { ...bounds }, lengthScore, areaScore, visit: 0 });
    }
  }

  const walkCluster = (start: SpatialBucket, visit: number): SpatialCluster => {
    const queue = [start];
    start.visit = visit;
    let head = 0;
    let count = 0;
    let lengthScore = 0;
    let areaScore = 0;
    let anchorX = start.x;
    let anchorY = start.y;
    const bounds = emptyBounds();
    while (head < queue.length) {
      const bucket = queue[head++];
      count += bucket.count;
      lengthScore += bucket.lengthScore;
      areaScore += bucket.areaScore;
      includeBounds(bounds, bucket.bounds);
      if (bucket.x < anchorX || (bucket.x === anchorX && bucket.y < anchorY)) {
        anchorX = bucket.x;
        anchorY = bucket.y;
      }
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const neighbor = buckets.get(`${bucket.x + dx},${bucket.y + dy}`);
        if (neighbor && neighbor.visit !== visit) {
          neighbor.visit = visit;
          queue.push(neighbor);
        }
      }
    }
    return { count, bounds, lengthScore, areaScore, score: count + lengthScore + areaScore, anchorX, anchorY };
  };
  const isBetter = (candidate: SpatialCluster, current: SpatialCluster | null) => !current ||
    candidate.score > current.score || (candidate.score === current.score && (
      candidate.count > current.count || (candidate.count === current.count && (
        candidate.bounds.minX < current.bounds.minX || (candidate.bounds.minX === current.bounds.minX && (
          candidate.bounds.minY < current.bounds.minY || (candidate.bounds.minY === current.bounds.minY && (
            candidate.anchorX < current.anchorX || (candidate.anchorX === current.anchorX && candidate.anchorY < current.anchorY)
          ))
        ))
      ))
    ));
  let primary: SpatialCluster | null = null;
  for (const bucket of buckets.values()) {
    if (bucket.visit === 1) continue;
    const cluster = walkCluster(bucket, 1);
    if (isBetter(cluster, primary)) primary = cluster;
  }
  if (!primary || primary.count < 2 || primary.count === totalEntityCount) {
    return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };
  }

  const primaryDiagonal = Math.max(cellSize, Math.hypot(primary.bounds.maxX - primary.bounds.minX, primary.bounds.maxY - primary.bounds.minY));
  let excludedEntityCount = 0;
  for (const bucket of buckets.values()) {
    if (bucket.visit === 2) continue;
    const cluster = walkCluster(bucket, 2);
    if (cluster.anchorX === primary.anchorX && cluster.anchorY === primary.anchorY) continue;
    if (cluster.count !== 1 || cluster.score >= primary.score * 0.25 || boundsGap(primary.bounds, cluster.bounds) <= primaryDiagonal * 4) {
      return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };
    }
    excludedEntityCount++;
  }
  return { bounds: primary.bounds, excludedEntityCount, totalEntityCount };
}

function createProjection(bounds: CadBounds): CadViewportProjection {
  const sourceWidth = Math.max(0, bounds.maxX - bounds.minX);
  const sourceHeight = Math.max(0, bounds.maxY - bounds.minY);
  const layoutWidth = Math.max(1, sourceWidth);
  const layoutHeight = Math.max(1, sourceHeight);
  const scale = Math.min(
    (MAX_MAP_WIDTH - MAP_PADDING * 2) / layoutWidth,
    (MAX_MAP_HEIGHT - MAP_PADDING * 2) / layoutHeight
  );
  const contentWidth = sourceWidth * scale;
  const contentHeight = sourceHeight * scale;
  const width = Math.ceil(Math.max(MIN_MAP_EDGE, Math.min(MAX_MAP_WIDTH, contentWidth + MAP_PADDING * 2)));
  const height = Math.ceil(Math.max(MIN_MAP_EDGE, Math.min(MAX_MAP_HEIGHT, contentHeight + MAP_PADDING * 2)));
  return {
    width,
    height,
    scale,
    offsetX: (width - contentWidth) / 2,
    offsetY: (height - contentHeight) / 2
  };
}

export function createCadViewport(bounds: CadBounds): { width: number; height: number } {
  const { width, height } = createProjection(bounds);
  return { width, height };
}

export function cadViewportScale(bounds: CadBounds): number {
  return createProjection(bounds).scale;
}

export function projectCadPointToViewport(point: CadPoint, bounds: CadBounds): { x: number; y: number } {
  const projection = createProjection(bounds);
  return {
    x: (point.x - bounds.minX) * projection.scale + projection.offsetX,
    y: (bounds.maxY - point.y) * projection.scale + projection.offsetY
  };
}

export function cadViewportSvgTransform(bounds: CadBounds): string {
  const projection = createProjection(bounds);
  return `matrix(${format(projection.scale)} 0 0 -${format(projection.scale)} ${format(projection.offsetX - bounds.minX * projection.scale)} ${format(projection.offsetY + bounds.maxY * projection.scale)})`;
}

function format(value: number): string {
  return Number(value.toFixed(6)).toString();
}
