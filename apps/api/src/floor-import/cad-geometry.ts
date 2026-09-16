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

const IDENTITY: CadMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

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

export function expandCadDocument(
  document: Pick<NormalizedCadDocument, "blocks" | "entities">,
  options: { maxRenderedEntities: number; maxBlockDepth?: number }
): ExpandedCadEntity[] {
  const blocks = new Map(document.blocks.map(block => [block.name, block]));
  if (blocks.size !== document.blocks.length) throw new Error("Duplicate CAD block name");
  const expanded: ExpandedCadEntity[] = [];
  const maxDepth = options.maxBlockDepth ?? 16;

  const visit = (
    entities: NormalizedCadEntity[], matrix: CadMatrix, prefix: string,
    parentBlockName: string | null, insertLayer: string | null, stack: readonly string[]
  ) => {
    for (const entity of entities) {
      if (entity.type !== "insert") {
        expanded.push({ entity, matrix, sourceEntityId: `${prefix}${entity.sourceEntityId}`, blockName: parentBlockName, insertLayer });
        if (expanded.length > options.maxRenderedEntities) throw new Error("CAD rendered entity limit exceeded");
        continue;
      }
      const block = blocks.get(entity.blockName);
      if (!block) throw new Error(`CAD INSERT references missing block: ${entity.blockName}`);
      if (stack.includes(block.name)) throw new Error(`Cyclic CAD block reference: ${block.name}`);
      if (stack.length >= maxDepth) throw new Error("CAD block depth limit exceeded");
      const childMatrix = multiplyCadMatrices(matrix, insertMatrix(entity, block.basePoint));
      visit(block.entities, childMatrix, `${prefix}${entity.sourceEntityId}:`, block.name, entity.layer, [...stack, block.name]);
    }
  };

  visit(document.entities, IDENTITY, "", null, null, []);
  return expanded;
}

export function expandCadInserts(
  document: Pick<NormalizedCadDocument, "blocks" | "entities">,
  options: { maxExpandedInserts: number; maxBlockDepth?: number }
): ExpandedCadInsert[] {
  const blocks = new Map(document.blocks.map(block => [block.name, block]));
  if (blocks.size !== document.blocks.length) throw new Error("Duplicate CAD block name");
  const expanded: ExpandedCadInsert[] = [];
  const maxDepth = options.maxBlockDepth ?? 16;
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

  const visit = (
    entities: NormalizedCadEntity[], parentMatrix: CadMatrix, prefix: string,
    inheritedLayer: string | null, stack: readonly string[]
  ) => {
    for (const entity of entities) {
      if (entity.type !== "insert") continue;
      const block = blocks.get(entity.blockName);
      if (!block) throw new Error(`CAD INSERT references missing block: ${entity.blockName}`);
      if (stack.includes(block.name)) throw new Error(`Cyclic CAD block reference: ${block.name}`);
      if (stack.length >= maxDepth) throw new Error("CAD block depth limit exceeded");
      const sourceEntityId = prefix ? `${prefix}/${entity.sourceEntityId}` : entity.sourceEntityId;
      const layer = entity.layer === "0" ? inheritedLayer ?? "0" : entity.layer;
      const matrix = multiplyCadMatrices(parentMatrix, insertMatrix(entity, block.basePoint));
      const position = transformPoint(parentMatrix, entity.position);
      expanded.push({
        entity,
        sourceEntityId,
        layer,
        blockName: entity.blockName,
        position: { x: round(position.x), y: round(position.y), z: round(position.z) },
        rotation: round(((Math.atan2(matrix.b, matrix.a) * 180 / Math.PI) % 360 + 360) % 360),
        scale: { x: round(Math.hypot(matrix.a, matrix.b)), y: round(Math.hypot(matrix.c, matrix.d)), z: round(entity.scale.z) }
      });
      if (expanded.length > options.maxExpandedInserts) throw new Error("CAD expanded INSERT limit exceeded");
      visit(block.entities, matrix, sourceEntityId, layer, [...stack, block.name]);
    }
  };

  visit(document.entities, IDENTITY, "", null, []);
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
  if (chord === 0) throw new Error("CAD bulge segment has coincident vertices");
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

export function computeCadBounds(expanded: readonly ExpandedCadEntity[]): CadBounds {
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
      const width = Math.max(entity.height * 0.6, entity.text.length * entity.height * 0.6);
      const corners = [
        { x: 0, y: 0 }, { x: width, y: 0 }, { x: 0, y: entity.height }, { x: width, y: entity.height }
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
