import { computeCadBounds, expandCadDocument } from "./cad-geometry";
import { CAD_MAX_PARSED_ENTITIES } from "./cad-runtime-contract";
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

interface SpatialEntity {
  bounds: CadBounds;
  centerX: number;
  centerY: number;
  extent: number;
}

function unionBounds(items: readonly SpatialEntity[]): CadBounds {
  return items.reduce<CadBounds>((bounds, item) => ({
    minX: Math.min(bounds.minX, item.bounds.minX),
    minY: Math.min(bounds.minY, item.bounds.minY),
    maxX: Math.max(bounds.maxX, item.bounds.maxX),
    maxY: Math.max(bounds.maxY, item.bounds.maxY)
  }), { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY });
}

function boundsGap(left: CadBounds, right: CadBounds): number {
  const x = Math.max(0, left.minX - right.maxX, right.minX - left.maxX);
  const y = Math.max(0, left.minY - right.maxY, right.minY - left.maxY);
  return Math.hypot(x, y);
}

export function selectPrimaryCadBounds(document: NormalizedCadDocument): PrimaryCadBoundsSelection {
  const expanded = expandCadDocument(document, { maxRenderedEntities: CAD_MAX_PARSED_ENTITIES, maxBlockDepth: 32 });
  const spatial: SpatialEntity[] = expanded.map(item => {
    const bounds = computeCadBounds([item]);
    const width = Math.max(0, bounds.maxX - bounds.minX);
    const height = Math.max(0, bounds.maxY - bounds.minY);
    return {
      bounds,
      centerX: (bounds.minX + bounds.maxX) / 2,
      centerY: (bounds.minY + bounds.maxY) / 2,
      extent: Math.hypot(width, height)
    };
  });
  const totalEntityCount = spatial.length;
  const completeBounds = totalEntityCount > 0 ? unionBounds(spatial) : document.bounds;
  if (totalEntityCount < 3) return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };

  const nonZeroExtents = spatial.map(item => item.extent).filter(value => value > 0).sort((left, right) => left - right);
  if (nonZeroExtents.length === 0) return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };
  const medianExtent = nonZeroExtents[Math.floor(nonZeroExtents.length / 2)];
  const cellSize = Math.max(Number.EPSILON, medianExtent * 4);
  const buckets = new Map<string, SpatialEntity[]>();
  const bucketCoordinate = (value: number) => Math.floor(value / cellSize);
  for (const item of spatial) {
    const key = `${bucketCoordinate(item.centerX)},${bucketCoordinate(item.centerY)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const visited = new Set<string>();
  const clusters: Array<{ items: SpatialEntity[]; bounds: CadBounds; score: number; key: string }> = [];
  const orderedKeys = [...buckets.keys()].sort((left, right) => {
    const [leftX, leftY] = left.split(",").map(Number);
    const [rightX, rightY] = right.split(",").map(Number);
    return leftX - rightX || leftY - rightY;
  });
  for (const startKey of orderedKeys) {
    if (visited.has(startKey)) continue;
    const queue = [startKey];
    const items: SpatialEntity[] = [];
    visited.add(startKey);
    while (queue.length > 0) {
      const key = queue.shift()!;
      items.push(...(buckets.get(key) ?? []));
      const [x, y] = key.split(",").map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const neighbor = `${x + dx},${y + dy}`;
        if (buckets.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    const bounds = unionBounds(items);
    const extentCap = medianExtent * 16;
    const drawableScore = items.reduce((sum, item) => sum + Math.min(item.extent, extentCap), 0);
    clusters.push({ items, bounds, score: items.length * medianExtent + drawableScore, key: startKey });
  }
  clusters.sort((left, right) =>
    right.score - left.score || right.items.length - left.items.length ||
    left.bounds.minX - right.bounds.minX || left.bounds.minY - right.bounds.minY || left.key.localeCompare(right.key)
  );
  const primary = clusters[0];
  const remainder = clusters.slice(1);
  if (!primary || remainder.length === 0 || primary.items.length < 2) {
    return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };
  }

  const primaryDiagonal = Math.max(cellSize, Math.hypot(primary.bounds.maxX - primary.bounds.minX, primary.bounds.maxY - primary.bounds.minY));
  const isolatedCountLimit = Math.max(1, Math.floor(totalEntityCount * 0.005));
  const isolatedRemainder = remainder.every(cluster =>
    cluster.items.length <= isolatedCountLimit &&
    cluster.score < primary.score * 0.25 &&
    boundsGap(primary.bounds, cluster.bounds) > primaryDiagonal * 4
  );
  if (!isolatedRemainder) {
    return { bounds: completeBounds, excludedEntityCount: 0, totalEntityCount };
  }
  const excludedEntityCount = remainder.reduce((sum, cluster) => sum + cluster.items.length, 0);
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
