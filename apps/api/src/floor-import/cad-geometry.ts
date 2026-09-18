import { Buffer } from "node:buffer";
import { measureCadText } from "./cad-text-layout";
import type {
  CadBounds,
  CadPoint,
  CadPolylineVertex,
  NormalizedCadDocument,
  NormalizedCadEntity
} from "./cad-types";

export interface CadMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface ExpandedCadEntity {
  entity: Exclude<NormalizedCadEntity, { type: "insert" }>;
  matrix: CadMatrix;
  sourceEntityId: string;
  blockName: string | null;
  insertLayer: string | null;
}

export interface ExpandedCadInsert {
  entity: Extract<NormalizedCadEntity, { type: "insert" }>;
  sourceEntityId: string;
  layer: string;
  blockName: string;
  position: CadPoint;
  rotation: number;
  scale: { x: number; y: number; z: number };
}

export type CadExpansionWork<T> = T | null;

const IDENTITY: CadMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const MAX_EXPANDED_SOURCE_ID_BYTES = 512;

function expandedSourceId(path: readonly string[]): string {
  const id = path.length === 1
    ? path[0]
    : path.map(segment => `${Buffer.byteLength(segment, "utf8")}:${segment}`).join("");
  if (!id || Buffer.byteLength(id, "utf8") > MAX_EXPANDED_SOURCE_ID_BYTES) throw new Error("CAD expanded source identity limit exceeded");
  return id;
}

function registerExpandedSourceId(ids: Set<string>, id: string): void {
  const key = id.normalize("NFKC").toLocaleUpperCase();
  if (ids.has(key)) throw new Error(`Duplicate CAD expanded source identity: ${id}`);
  ids.add(key);
}

export function multiplyCadMatrices(left: CadMatrix, right: CadMatrix): CadMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

export function transformPoint(matrix: CadMatrix, point: CadPoint): CadPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
    z: point.z
  };
}

function insertMatrix(entity: Extract<NormalizedCadEntity, { type: "insert" }>, basePoint: CadPoint): CadMatrix {
  const radians = entity.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const scaledRotation: CadMatrix = {
    a: cosine * entity.scale.x,
    b: sine * entity.scale.x,
    c: -sine * entity.scale.y,
    d: cosine * entity.scale.y,
    e: 0,
    f: 0
  };
  scaledRotation.e = entity.position.x - scaledRotation.a * basePoint.x - scaledRotation.c * basePoint.y;
  scaledRotation.f = entity.position.y - scaledRotation.b * basePoint.x - scaledRotation.d * basePoint.y;
  return scaledRotation;
}

export function* iterateCadDocumentExpansion(
  document: Pick<NormalizedCadDocument, "blocks" | "entities">,
  options: { maxRenderedEntities: number; maxBlockDepth?: number; checkBudget?: () => void }
): Generator<CadExpansionWork<ExpandedCadEntity>> {
  const blocks = new Map(document.blocks.map(block => [block.name, block]));
  if (blocks.size !== document.blocks.length) throw new Error("Duplicate CAD block name");
  let expandedCount = 0;
  const maxDepth = options.maxBlockDepth ?? 16;
  const sourceIds = new Set<string>();

  function* visit(
    entities: NormalizedCadEntity[], matrix: CadMatrix, path: readonly string[],
    parentBlockName: string | null, insertLayer: string | null, stack: readonly string[]
  ): Generator<CadExpansionWork<ExpandedCadEntity>> {
    for (const entity of entities) {
      options.checkBudget?.();
      if (entity.type !== "insert") {
        const sourceEntityId = expandedSourceId([...path, entity.sourceEntityId]);
        registerExpandedSourceId(sourceIds, sourceEntityId);
        expandedCount++;
        if (expandedCount > options.maxRenderedEntities) throw new Error("CAD rendered entity limit exceeded");
        yield { entity, matrix, sourceEntityId, blockName: parentBlockName, insertLayer };
        continue;
      }
      yield null;
      const block = blocks.get(entity.blockName);
      if (!block) throw new Error(`CAD INSERT references missing block: ${entity.blockName}`);
      if (stack.includes(block.name)) throw new Error(`Cyclic CAD block reference: ${block.name}`);
      if (stack.length >= maxDepth) throw new Error("CAD block depth limit exceeded");
      const childMatrix = multiplyCadMatrices(matrix, insertMatrix(entity, block.basePoint));
      yield* visit(block.entities, childMatrix, [...path, entity.sourceEntityId], block.name, entity.layer, [...stack, block.name]);
    }
  }

  yield* visit(document.entities, IDENTITY, [], null, null, []);
}

export function expandCadDocument(
  document: Pick<NormalizedCadDocument, "blocks" | "entities">,
  options: { maxRenderedEntities: number; maxBlockDepth?: number; checkBudget?: () => void }
): ExpandedCadEntity[] {
  const expanded: ExpandedCadEntity[] = [];
  for (const item of iterateCadDocumentExpansion(document, options)) if (item) expanded.push(item);
  return expanded;
}

export function* iterateCadInsertExpansion(
  document: Pick<NormalizedCadDocument, "blocks" | "entities">,
  options: { maxExpandedInserts: number; maxBlockDepth?: number; checkBudget?: () => void }
): Generator<CadExpansionWork<ExpandedCadInsert>> {
  const blocks = new Map(document.blocks.map(block => [block.name, block]));
  if (blocks.size !== document.blocks.length) throw new Error("Duplicate CAD block name");
  let expandedCount = 0;
  const maxDepth = options.maxBlockDepth ?? 16;
  const sourceIds = new Set<string>();
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

  function* visit(
    entities: NormalizedCadEntity[], parentMatrix: CadMatrix, path: readonly string[],
    inheritedLayer: string | null, parentZScale: number, stack: readonly string[]
  ): Generator<CadExpansionWork<ExpandedCadInsert>> {
    for (const entity of entities) {
      options.checkBudget?.();
      if (entity.type !== "insert") {
        yield null;
        continue;
      }
      const block = blocks.get(entity.blockName);
      if (!block) throw new Error(`CAD INSERT references missing block: ${entity.blockName}`);
      if (stack.includes(block.name)) throw new Error(`Cyclic CAD block reference: ${block.name}`);
      if (stack.length >= maxDepth) throw new Error("CAD block depth limit exceeded");
      const entityPath = [...path, entity.sourceEntityId];
      const sourceEntityId = expandedSourceId(entityPath);
      registerExpandedSourceId(sourceIds, sourceEntityId);
      const layer = entity.layer === "0" ? inheritedLayer ?? "0" : entity.layer;
      const matrix = multiplyCadMatrices(parentMatrix, insertMatrix(entity, block.basePoint));
      const position = transformPoint(parentMatrix, entity.position);
      const scaleX = Math.hypot(matrix.a, matrix.b);
      const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
      const expanded: ExpandedCadInsert = {
        entity,
        sourceEntityId,
        layer,
        blockName: entity.blockName,
        position: { x: round(position.x), y: round(position.y), z: round(position.z) },
        rotation: round(((Math.atan2(matrix.b, matrix.a) * 180 / Math.PI) % 360 + 360) % 360),
        scale: { x: round(scaleX), y: round(determinant / scaleX), z: round(parentZScale * entity.scale.z) }
      };
      expandedCount++;
      if (expandedCount > options.maxExpandedInserts) throw new Error("CAD expanded INSERT limit exceeded");
      yield expanded;
      yield* visit(block.entities, matrix, entityPath, layer, parentZScale * entity.scale.z, [...stack, block.name]);
    }
  }

  yield* visit(document.entities, IDENTITY, [], null, 1, []);
}

export function expandCadInserts(
  document: Pick<NormalizedCadDocument, "blocks" | "entities">,
  options: { maxExpandedInserts: number; maxBlockDepth?: number; checkBudget?: () => void }
): ExpandedCadInsert[] {
  const expanded: ExpandedCadInsert[] = [];
  for (const item of iterateCadInsertExpansion(document, options)) if (item) expanded.push(item);
  return expanded;
}

function normalizeAngle(value: number): number {
  return ((value % 360) + 360) % 360;
}

function angleIsOnSweep(angle: number, start: number, sweep: number): boolean {
  if (sweep >= 0) return (normalizeAngle(angle) - normalizeAngle(start) + 360) % 360 <= sweep + 1e-10;
  return (normalizeAngle(start) - normalizeAngle(angle) + 360) % 360 <= -sweep + 1e-10;
}

export interface CadBulgeArc {
  center: CadPoint;
  radius: number;
  startAngle: number;
  sweepAngle: number;
}

export function cadBulgeArc(start: CadPoint, end: CadPoint, bulge: number): CadBulgeArc | null {
  if (!Number.isFinite(bulge)) throw new Error("Non-finite CAD polyline bulge");
  if (bulge === 0) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  // Exporters can preserve a bulge on a zero-length cleanup segment. It has no
  // drawable arc, so treating it as a point keeps bounds finite and reproducible.
  if (chord === 0) return null;
  const centerOffset = chord * (1 - bulge * bulge) / (4 * bulge);
  const center = {
    x: (start.x + end.x) / 2 - dy / chord * centerOffset,
    y: (start.y + end.y) / 2 + dx / chord * centerOffset,
    z: (start.z + end.z) / 2
  };
  return {
    center,
    radius: chord * (1 + bulge * bulge) / (4 * Math.abs(bulge)),
    startAngle: Math.atan2(start.y - center.y, start.x - center.x) * 180 / Math.PI,
    sweepAngle: 4 * Math.atan(bulge) * 180 / Math.PI
  };
}

function includeArcBounds(
  center: CadPoint, radius: number, startAngle: number, sweepAngle: number,
  matrix: CadMatrix, include: (point: CadPoint) => void
): void {
  const candidateAngles = [
    startAngle,
    startAngle + sweepAngle,
    Math.atan2(matrix.c, matrix.a) * 180 / Math.PI,
    Math.atan2(matrix.c, matrix.a) * 180 / Math.PI + 180,
    Math.atan2(matrix.d, matrix.b) * 180 / Math.PI,
    Math.atan2(matrix.d, matrix.b) * 180 / Math.PI + 180
  ];
  for (const angle of candidateAngles) {
    if (!angleIsOnSweep(angle, startAngle, sweepAngle)) continue;
    const radians = angle * Math.PI / 180;
    include(transformPoint(matrix, {
      x: center.x + radius * Math.cos(radians),
      y: center.y + radius * Math.sin(radians),
      z: center.z
    }));
  }
}

function includePolylineBounds(
  vertices: readonly CadPolylineVertex[], closed: boolean, matrix: CadMatrix,
  include: (point: CadPoint) => void
): void {
  vertices.forEach(vertex => include(transformPoint(matrix, vertex)));
  const segmentCount = closed ? vertices.length : Math.max(0, vertices.length - 1);
  for (let index = 0; index < segmentCount; index++) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const arc = cadBulgeArc(start, end, start.bulge);
    if (arc) includeArcBounds(arc.center, arc.radius, arc.startAngle, arc.sweepAngle, matrix, include);
  }
}

export function computeCadBounds(
  expanded: Iterable<ExpandedCadEntity | null>,
  checkBudget?: () => void,
  consumeTextGlyph?: () => void
): CadBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (point: CadPoint) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Non-finite CAD geometry");
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };

  for (const item of expanded) {
    checkBudget?.();
    if (!item) continue;
    const { entity, matrix } = item;
    if (entity.type === "line") {
      include(transformPoint(matrix, entity.start));
      include(transformPoint(matrix, entity.end));
    } else if ("vertices" in entity) {
      includePolylineBounds(entity.vertices, entity.closed, matrix, include);
    } else if (entity.type === "circle") {
      const center = transformPoint(matrix, entity.center);
      const extentX = entity.radius * Math.hypot(matrix.a, matrix.c);
      const extentY = entity.radius * Math.hypot(matrix.b, matrix.d);
      include({ x: center.x - extentX, y: center.y - extentY, z: center.z });
      include({ x: center.x + extentX, y: center.y + extentY, z: center.z });
    } else if (entity.type === "arc") {
      const sweep = (normalizeAngle(entity.endAngle) - normalizeAngle(entity.startAngle) + 360) % 360;
      includeArcBounds(entity.center, entity.radius, entity.startAngle, sweep, matrix, include);
    } else {
      const radians = entity.rotation * Math.PI / 180;
      const textBounds = measureCadText(entity.text, entity.height, { consumeGlyph: consumeTextGlyph }).bounds;
      const corners = [
        { x: textBounds.minX, y: textBounds.minY }, { x: textBounds.maxX, y: textBounds.minY },
        { x: textBounds.minX, y: textBounds.maxY }, { x: textBounds.maxX, y: textBounds.maxY }
      ];
      for (const corner of corners) {
        include(transformPoint(matrix, {
          x: entity.position.x + corner.x * Math.cos(radians) - corner.y * Math.sin(radians),
          y: entity.position.y + corner.x * Math.sin(radians) + corner.y * Math.cos(radians),
          z: entity.position.z
        }));
      }
    }
  }

  return minX === Number.POSITIVE_INFINITY
    ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    : { minX, minY, maxX, maxY };
}
