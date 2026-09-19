import type {
  CadBounds,
  CadElementOverride,
  CadElementTransform,
  CadSceneElementLocator,
  CadScenePrimitive,
  CadSceneTile
} from "@led-control/shared";
import type { CadSceneCamera } from "../cad-scene/cad-scene-camera";
import { buildCadGeometryBatches } from "../cad-scene/cad-scene-worker";
import type {
  CadGeometryBatch,
  CadPickEntry,
  CadSceneWorkerClient,
  CadSpatialIndex,
  CadTextBatch,
  DecodedCadSceneTile
} from "../cad-scene/cad-scene-worker";
import type { Point } from "./geometry";

export interface CadEditableElement {
  elementId: string;
  groupId: string | null;
  layerName: string;
  locator: CadSceneElementLocator;
  bounds: CadBounds;
  points: Point[];
  fragments: Array<{ points: Point[]; closed: boolean }>;
  closed: boolean;
  text: string | null;
  fontSize: number | null;
  textGeometry: {
    position: Point;
    width: number;
    height: number;
    rotation: number;
    bounds: CadBounds;
  } | null;
  strokeColor: string | null;
  fillColor: string | null;
  strokeWidth: number;
  zOrder: number;
  override: CadElementOverride | null;
}

export function editorTransformToCadCamera(
  pan: Point,
  zoom: number,
  viewport: { width: number; height: number }
): CadSceneCamera {
  return {
    centerX: (viewport.width / 2 - pan.x) / zoom,
    centerY: (viewport.height / 2 - pan.y) / zoom,
    zoom,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height
  };
}

export function resolveCadTileContentPath(template: string, tile: CadSceneTile): string {
  return template
    .replace("{lod}", String(tile.lod))
    .replace("{tileX}", String(tile.tileX))
    .replace("{tileY}", String(tile.tileY))
    .replace("{part}", String(tile.part));
}

export function createCadOverrideWorker(
  worker: CadSceneWorkerClient,
  getOverrides: () => ReadonlyMap<string, CadElementOverride>,
  onDecoded: (tile: DecodedCadSceneTile) => void
): CadSceneWorkerClient {
  return {
    async decode(payload, descriptor, quality) {
      // Display meshes have no exact spans/picks. The worker must apply source
      // overrides before simplification, and they must not enter the edit cache.
      if (quality) return worker.decode(payload, descriptor, { ...quality, overrides: [...getOverrides().values()] });
      const decoded = await worker.decode(payload, descriptor);
      onDecoded(decoded);
      return applyCadElementOverrides(decoded, getOverrides());
    },
    async decodeSource(payload, descriptor) {
      const decoded = await (worker.decodeSource ? worker.decodeSource(payload, descriptor) : worker.decode(payload, descriptor));
      onDecoded(decoded);
      return decoded;
    },
    destroy() {
      worker.destroy();
    }
  };
}

export function findCadEditableElement(
  tiles: Iterable<DecodedCadSceneTile>,
  elementId: string,
  overrides: ReadonlyMap<string, CadElementOverride>,
  preferredLocator?: CadSceneElementLocator
): CadEditableElement | null {
  const occurrences = [...tiles].flatMap((tile) => tile.pickEntries
    .filter((entry) => entry.elementId === elementId)
    .map((entry) => ({ tile, entry, locator: locatorForTile(tile.descriptor) })));
  if (occurrences.length === 0) return null;
  const preferred = preferredLocator
    ? occurrences.find((item) => sameLocator(item.locator, preferredLocator))
    : undefined;
  const representative = preferred ?? occurrences[0];
  const sameLod = occurrences.filter((item) => item.tile.descriptor.lod === representative.tile.descriptor.lod);
  const fragments = sameLod
    .filter(({ entry }) => entry.pointCount > 0)
    .map(({ tile, entry }) => ({
      points: Array.from({ length: entry.pointCount }, (_, index) => ({
        x: tile.pickPoints[(entry.pointStart + index) * 2],
        y: tile.pickPoints[(entry.pointStart + index) * 2 + 1]
      })),
      closed: entry.closed
    }));
  const textEntry = sameLod.flatMap(({ tile }) => tile.textBatches.flatMap((batch) => batch.entries))
    .find((candidate) => candidate.elementId === elementId);
  const styles = sameLod.reduce((current, { tile }) => {
    const next = stylesForElement(tile.batches, elementId);
    return {
      strokeColor: current.strokeColor ?? next.strokeColor,
      fillColor: current.fillColor ?? next.fillColor
    };
  }, { strokeColor: null as string | null, fillColor: null as string | null });
  const bounds = unionBounds(sameLod.map(({ entry }) => entry.bounds));
  const points = fragments.flatMap((fragment) => fragment.points);
  return {
    elementId,
    groupId: representative.entry.groupId,
    layerName: representative.entry.layerName,
    locator: representative.locator,
    bounds,
    points,
    fragments,
    closed: fragments.length > 0 && fragments.every(fragment => fragment.closed),
    text: textEntry?.text ?? null,
    fontSize: textEntry?.fontSize ?? null,
    textGeometry: textEntry ? {
      position: textEntry.position,
      width: textEntry.width,
      height: textEntry.height,
      rotation: textEntry.rotation,
      bounds: textEntry.bounds
    } : null,
    strokeColor: styles.strokeColor ?? (textEntry ? textBatchColor(
      sameLod.flatMap(({ tile }) => tile.textBatches), elementId
    ) : null),
    fillColor: styles.fillColor,
    strokeWidth: representative.entry.strokeWidth,
    zOrder: Math.max(...sameLod.map(({ entry }) => entry.zOrder)),
    override: overrides.get(elementId) ?? null
  };
}

export function applyCadElementOverrides(
  tile: DecodedCadSceneTile,
  overrides: ReadonlyMap<string, CadElementOverride>
): DecodedCadSceneTile {
  if (overrides.size === 0) return tile;
  const affected = tile.pickEntries.some((entry) => overrides.has(entry.elementId));
  if (!affected) return tile;

  const batches = rebatchedGeometry(rebuildOverriddenGeometry(tile, overrides), overrides);
  const textBatches = rebatchedText(tile.textBatches, overrides);
  const pickEntries: CadPickEntry[] = [];
  const pickPoints: number[] = [];

  for (const entry of tile.pickEntries) {
    const override = overrides.get(entry.elementId);
    if (override?.hidden) continue;
    const transform = override?.transform;
    const pointStart = pickPoints.length / 2;
    for (let index = 0; index < entry.pointCount; index++) {
      const point = {
        x: tile.pickPoints[(entry.pointStart + index) * 2],
        y: tile.pickPoints[(entry.pointStart + index) * 2 + 1]
      };
      const next = transform ? transformPoint(point, transform) : point;
      pickPoints.push(next.x, next.y);
    }
    pickEntries.push({
      ...entry,
      pointStart,
      bounds: transform ? transformBounds(entry.bounds, transform) : entry.bounds,
      filled: entry.filled || (entry.closed && override?.fillColor != null),
      strokeWidth: override?.strokeWidth ?? entry.strokeWidth
    });
  }

  const packedPickPoints = Float32Array.from(pickPoints);
  return {
    ...tile,
    batches,
    textBatches,
    pickEntries,
    pickPoints: packedPickPoints,
    spatialIndex: buildSpatialIndex(pickEntries),
    memory: {
      ...tile.memory,
      cpuBytes: Math.max(tile.memory.cpuBytes, byteLengthOfBatches(batches, packedPickPoints)),
      gpuBytes: Math.max(tile.memory.gpuBytes, byteLengthOfGeometry(batches))
    }
  };
}

function rebuildOverriddenGeometry(
  tile: DecodedCadSceneTile,
  overrides: ReadonlyMap<string, CadElementOverride>
): CadGeometryBatch[] {
  const styles = new Map<string, { stroke?: CadGeometryBatch; fill?: CadGeometryBatch }>();
  for (const batch of tile.batches) {
    const kind = parseStyleKey(batch.styleKey).kind;
    for (const span of batch.spans) {
      if (!overrides.has(span.elementId)) continue;
      const current = styles.get(span.elementId) ?? {};
      current[kind] = batch;
      styles.set(span.elementId, current);
    }
  }
  const rebuiltStrokeIds = new Set<string>();
  const primitives: CadScenePrimitive[] = [];
  for (const entry of tile.pickEntries) {
    const override = overrides.get(entry.elementId);
    if (!override || override.hidden || entry.pointCount < 2) continue;
    const style = styles.get(entry.elementId);
    const rebuildStroke = override.strokeWidth !== null || (!style?.stroke && override.strokeColor !== null);
    const addFill = entry.closed && !style?.fill && override.fillColor !== null;
    if (!rebuildStroke && !addFill) continue;
    if (rebuildStroke) rebuiltStrokeIds.add(entry.elementId);

    // One source element may produce several same-ID occurrences in a tile.
    // Their source style is shared, but their point ranges must never be
    // collapsed by ID or zipped to spans (empty/clipped spans may be absent).
    // These temporary polylines rebuild only the mesh, not the typed source
    // primitive. Validated tile clips equal descriptor.bounds; clipping before
    // the affine preserves tile seams and avoids adding artificial border edges.
    primitives.push({
      elementId: entry.elementId,
      groupId: entry.groupId,
      layerName: entry.layerName,
      sourceType: "override-mesh",
      type: "polyline",
      bounds: entry.bounds,
      clipBounds: tile.descriptor.bounds,
      geometry: {
        points: Array.from({ length: entry.pointCount }, (_, index) => ({
          x: tile.pickPoints[(entry.pointStart + index) * 2],
          y: tile.pickPoints[(entry.pointStart + index) * 2 + 1]
        })),
        closed: entry.closed
      },
      style: {
        strokeColor: rebuildStroke ? override.strokeColor ?? style?.stroke?.color ?? null : null,
        fillColor: addFill ? override.fillColor : null,
        strokeWidth: override.strokeWidth ?? entry.strokeWidth,
        opacity: style?.stroke?.opacity ?? style?.fill?.opacity ?? 1
      }
    });
  }
  if (primitives.length === 0) return tile.batches;
  const retained = tile.batches.map(batch => parseStyleKey(batch.styleKey).kind === "stroke"
    ? { ...batch, spans: batch.spans.filter(span => !rebuiltStrokeIds.has(span.elementId)) }
    : batch);
  return [...retained, ...buildCadGeometryBatches(primitives).batches];
}

function rebatchedGeometry(
  source: readonly CadGeometryBatch[],
  overrides: ReadonlyMap<string, CadElementOverride>
): CadGeometryBatch[] {
  const groups = new Map<string, {
    layerName: string;
    color: string;
    opacity: number;
    positions: number[];
    indices: number[];
    spans: CadGeometryBatch["spans"][number][];
  }>();

  for (const batch of source) {
    const style = parseStyleKey(batch.styleKey);
    for (const span of batch.spans) {
      const override = overrides.get(span.elementId);
      if (override?.hidden) continue;
      const color = style.kind === "fill"
        ? override?.fillColor ?? batch.color
        : override?.strokeColor ?? batch.color;
      if (color === null) continue;
      const strokeWidth = style.kind === "stroke" ? override?.strokeWidth ?? style.strokeWidth : 0;
      const key = JSON.stringify([batch.layerName, style.kind, color, batch.opacity, strokeWidth]);
      const target = groups.get(key) ?? {
        layerName: batch.layerName,
        color,
        opacity: batch.opacity,
        positions: [],
        indices: [],
        spans: []
      };
      const sourceIndices = batch.indices.subarray(span.indexStart, span.indexStart + span.indexCount);
      const remap = new Map<number, number>();
      const indexStart = target.indices.length;
      for (const sourceIndex of sourceIndices) {
        let nextIndex = remap.get(sourceIndex);
        if (nextIndex === undefined) {
          const point = { x: batch.positions[sourceIndex * 2], y: batch.positions[sourceIndex * 2 + 1] };
          const next = override?.transform
            ? transformPoint(point, override.transform)
            : point;
          nextIndex = target.positions.length / 2;
          target.positions.push(next.x, next.y);
          remap.set(sourceIndex, nextIndex);
        }
        target.indices.push(nextIndex);
      }
      target.spans.push({ ...span, indexStart, indexCount: target.indices.length - indexStart });
      groups.set(key, target);
    }
  }

  return [...groups.entries()].map(([styleKey, batch]) => ({
    styleKey,
    layerName: batch.layerName,
    color: batch.color,
    opacity: batch.opacity,
    positions: Float32Array.from(batch.positions),
    indices: Uint32Array.from(batch.indices),
    spans: batch.spans
  }));
}

function rebatchedText(
  source: readonly CadTextBatch[],
  overrides: ReadonlyMap<string, CadElementOverride>
): CadTextBatch[] {
  const groups = new Map<string, CadTextBatch>();
  for (const batch of source) {
    for (const text of batch.entries) {
      const override = overrides.get(text.elementId);
      if (override?.hidden) continue;
      const color = override?.strokeColor ?? override?.fillColor ?? batch.color;
      if (color === null) continue;
      const key = JSON.stringify([batch.layerName, "text", color, batch.opacity]);
      const target = groups.get(key) ?? {
        styleKey: key,
        layerName: batch.layerName,
        color,
        opacity: batch.opacity,
        entries: []
      };
      const transform = override?.transform;
      const scaleX = transform?.scaleX ?? 1;
      const scaleY = transform?.scaleY ?? 1;
      target.entries.push({
        ...text,
        text: override?.text ?? text.text,
        position: transform ? transformPoint(text.position, transform) : text.position,
        width: text.width * Math.abs(scaleX),
        height: text.height * Math.abs(scaleY),
        fontSize: text.fontSize * Math.max(Math.abs(scaleX), Math.abs(scaleY)),
        rotation: text.rotation + (transform?.rotation ?? 0),
        bounds: transform ? transformBounds(text.bounds, transform) : text.bounds,
        // The renderer clips in display-world coordinates, not source-tile
        // coordinates. Preserve null clips and carry bounded clips through
        // the same affine; the existing contract stores their enclosing AABB.
        clipBounds: transform && text.clipBounds ? transformBounds(text.clipBounds, transform) : text.clipBounds
      });
      groups.set(key, target);
    }
  }
  return [...groups.values()];
}

function transformPoint(point: Point, transform: CadElementTransform): Point {
  // CAD elements can be split across tile boundaries. A global affine keeps
  // every occurrence continuous without requiring full-scene element bounds.
  const localX = point.x * transform.scaleX;
  const localY = point.y * transform.scaleY;
  const radians = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: cleanAffineNumber(transform.translateX + localX * cosine - localY * sine),
    y: cleanAffineNumber(transform.translateY + localX * sine + localY * cosine)
  };
}

function cleanAffineNumber(value: number) {
  return Math.abs(value) < 1e-10 ? 0 : value;
}

export function editableElementDisplayBounds(element: CadEditableElement): CadBounds {
  const transform = element.override?.transform;
  return transform ? transformBounds(element.bounds, transform) : element.bounds;
}

export function pickPersistedCadElement(
  elements: Iterable<CadEditableElement>,
  point: Point,
  radius: number,
  isLayerVisible: (layerName: string) => boolean = () => true
): CadEditableElement | null {
  let best: { element: CadEditableElement; distance: number } | null = null;
  for (const element of elements) {
    if (element.override?.hidden || !element.override?.transform || !isLayerVisible(element.layerName)) continue;
    const bounds = editableElementDisplayBounds(element);
    const transform = element.override.transform;
    const strokeScale = Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY));
    const strokeRadius = Math.max(0, element.override.strokeWidth ?? element.strokeWidth) * strokeScale / 2;
    const coarseRadius = radius + strokeRadius;
    if (point.x < bounds.minX - coarseRadius || point.x > bounds.maxX + coarseRadius ||
        point.y < bounds.minY - coarseRadius || point.y > bounds.maxY + coarseRadius) continue;
    const distance = distanceToEditableElement(element, point);
    if (distance > radius + strokeRadius) continue;
    if (!best || element.zOrder > best.element.zOrder ||
        (element.zOrder === best.element.zOrder && distance < best.distance)) {
      best = { element, distance };
    }
  }
  return best?.element ?? null;
}

export function mergeCadEditableElements(
  current: CadEditableElement | undefined,
  next: CadEditableElement
): CadEditableElement {
  if (!current) return next;
  const fragments = [...current.fragments];
  const signatures = new Set(fragments.map(fragmentSignature));
  for (const fragment of next.fragments) {
    const signature = fragmentSignature(fragment);
    if (!signatures.has(signature)) {
      fragments.push(fragment);
      signatures.add(signature);
    }
  }
  return {
    ...next,
    locator: current.locator,
    bounds: unionBounds([current.bounds, next.bounds]),
    points: fragments.flatMap((fragment) => fragment.points),
    fragments,
    closed: fragments.length > 0 && fragments.every(fragment => fragment.closed),
    text: current.text ?? next.text,
    fontSize: current.fontSize ?? next.fontSize,
    textGeometry: current.textGeometry ?? next.textGeometry,
    zOrder: Math.max(current.zOrder, next.zOrder)
  };
}

export function estimateCadEditableElementBytes(element: CadEditableElement): number {
  const pointCount = element.fragments.reduce((count, fragment) => count + fragment.points.length, 0);
  const textBytes = (element.text?.length ?? 0) * 2 + (element.override?.text?.length ?? 0) * 2;
  return Math.max(1, 512 + pointCount * 32 + element.fragments.length * 64 + textBytes);
}

function transformBounds(bounds: CadBounds, transform: CadElementTransform): CadBounds {
  const points = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY }
  ].map((point) => transformPoint(point, transform));
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

export function transformCadBounds(bounds: CadBounds, transform: CadElementTransform): CadBounds {
  return transformBounds(bounds, transform);
}

function distanceToEditableElement(element: CadEditableElement, point: Point): number {
  const transform = element.override?.transform;
  if (!transform) return Number.POSITIVE_INFINITY;
  if (element.textGeometry) {
    return distanceToBounds(point, transformBounds(element.textGeometry.bounds, transform));
  }
  let distance = Number.POSITIVE_INFINITY;
  for (const fragment of element.fragments) {
    const points = fragment.points.map(candidate => transformPoint(candidate, transform));
    if (fragment.closed && (element.override?.fillColor ?? element.fillColor) && pointInPolygon(points, point)) {
      return 0;
    }
    const segmentCount = fragment.closed ? points.length : points.length - 1;
    for (let index = 0; index < segmentCount; index++) {
      distance = Math.min(distance, distanceToSegment(point, points[index], points[(index + 1) % points.length]));
    }
  }
  return distance;
}

function distanceToBounds(point: Point, bounds: CadBounds): number {
  const dx = point.x < bounds.minX ? bounds.minX - point.x : point.x > bounds.maxX ? point.x - bounds.maxX : 0;
  const dy = point.y < bounds.minY ? bounds.minY - point.y : point.y > bounds.maxY ? point.y - bounds.maxY : 0;
  return Math.hypot(dx, dy);
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function pointInPolygon(points: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const left = points[current];
    const right = points[previous];
    if ((left.y > point.y) !== (right.y > point.y) &&
        point.x < ((right.x - left.x) * (point.y - left.y)) / (right.y - left.y) + left.x) inside = !inside;
  }
  return inside;
}

function parseStyleKey(styleKey: string): { kind: "fill" | "stroke"; strokeWidth: number } {
  try {
    const [, kind, , , strokeWidth] = JSON.parse(styleKey) as [string, "fill" | "stroke", string, number, number];
    return { kind, strokeWidth };
  } catch {
    return { kind: "stroke", strokeWidth: 1 };
  }
}

function stylesForElement(batches: readonly CadGeometryBatch[], elementId: string) {
  let strokeColor: string | null | undefined;
  let fillColor: string | null | undefined;
  for (const batch of batches) {
    if (!batch.spans.some((span) => span.elementId === elementId)) continue;
    if (parseStyleKey(batch.styleKey).kind === "fill") fillColor = batch.color;
    else strokeColor = batch.color;
  }
  return { strokeColor: strokeColor ?? null, fillColor: fillColor ?? null };
}

function textBatchColor(batches: readonly CadTextBatch[], elementId: string) {
  return batches.find((batch) => batch.entries.some((entry) => entry.elementId === elementId))?.color ?? null;
}

function locatorForTile(tile: CadSceneTile): CadSceneElementLocator {
  return { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part };
}

function sameLocator(left: CadSceneElementLocator, right: CadSceneElementLocator) {
  return left.tileX === right.tileX && left.tileY === right.tileY && left.lod === right.lod && left.part === right.part;
}

function unionBounds(bounds: readonly CadBounds[]): CadBounds {
  return {
    minX: Math.min(...bounds.map((item) => item.minX)),
    minY: Math.min(...bounds.map((item) => item.minY)),
    maxX: Math.max(...bounds.map((item) => item.maxX)),
    maxY: Math.max(...bounds.map((item) => item.maxY))
  };
}

function fragmentSignature(fragment: { points: Point[]; closed: boolean }) {
  return `${fragment.closed ? 1 : 0}:${fragment.points.map((point) => `${point.x},${point.y}`).join(";")}`;
}

function buildSpatialIndex(entries: readonly CadPickEntry[], cellSize = 64): CadSpatialIndex {
  const mutable = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    for (let y = Math.floor(entry.bounds.minY / cellSize); y <= Math.floor(entry.bounds.maxY / cellSize); y++) {
      for (let x = Math.floor(entry.bounds.minX / cellSize); x <= Math.floor(entry.bounds.maxX / cellSize); x++) {
        const key = `${x}:${y}`;
        const bucket = mutable.get(key) ?? [];
        bucket.push(index);
        mutable.set(key, bucket);
      }
    }
  });
  return {
    cellSize,
    buckets: Object.fromEntries([...mutable].map(([key, values]) => [key, Uint32Array.from(values)]))
  };
}

function byteLengthOfGeometry(batches: readonly CadGeometryBatch[]) {
  return batches.reduce((total, batch) => total + batch.positions.byteLength * 2 + batch.indices.byteLength, 0);
}

function byteLengthOfBatches(batches: readonly CadGeometryBatch[], pickPoints: Float32Array) {
  return batches.reduce((total, batch) => total + batch.positions.byteLength + batch.indices.byteLength, pickPoints.byteLength);
}
