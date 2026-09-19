import { z } from "zod";
import { POSTGRES_INT_MAX, POSTGRES_INT_MIN } from "./postgres-contracts.js";
import { getMapElementBounds, getMapPolygonValidationError } from "./map-document-geometry.js";

export const MAP_DOCUMENT_FORMAT_VERSION = 1;
export const MAP_ELEMENT_MAX_ID_LENGTH = 512;
export const MAP_ELEMENT_MAX_POINTS = 65_536;
export const MAP_ELEMENT_MAX_TEXT_LENGTH = 65_536;
export const MAP_ELEMENT_MAX_BYTES = 8 * 1_024 * 1_024;
export const MAP_MUTATION_MAX_OPERATIONS = 2_000;
export const MAP_MUTATION_MAX_BYTES = 1_024 * 1_024;
export const MAP_DOCUMENT_MAX_ELEMENTS = 1_000_000;
export const MAP_DOCUMENT_MAX_SELECTED_ELEMENTS = 500_000;
export const MAP_DOCUMENT_DEFAULT_LONG_SIDE = 16_384;
export const MAP_DOCUMENT_MAX_LONG_SIDE = 32_768;
export const MAP_DOCUMENT_MIN_SHORT_SIDE = 1_024;
export const MAP_DOCUMENT_EXTREME_MIN_SHORT_SIDE = 512;
export const MAP_DOCUMENT_TILE_SIZE = 512;

const finite = z.number().finite();
const integer = finite.int().min(POSTGRES_INT_MIN).max(POSTGRES_INT_MAX);
const nonnegativeInteger = integer.nonnegative();
const positive = finite.positive();
function wellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
const idSchema = z.string().trim().min(1).max(MAP_ELEMENT_MAX_ID_LENGTH)
  .refine(wellFormedUnicode, "올바른 유니코드 식별자가 필요합니다.");
const nameSchema = z.string().trim().min(1).max(200)
  .refine(wellFormedUnicode, "올바른 유니코드 이름이 필요합니다.");
const colorSchema = z.string().regex(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i);
const encoder = new TextEncoder();
function serializedBudget(maximum: number) {
  return z.unknown().superRefine((value, context) => {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined || serialized.length > maximum || encoder.encode(serialized).byteLength > maximum) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `직렬화 본문은 ${maximum}바이트 이하여야 합니다.` });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON으로 직렬화할 수 없는 입력입니다." });
    }
  });
}

export const mapPointSchema = z.object({ x: finite, y: finite }).strict();
export const mapBoundsSchema = z.object({ minX: finite, minY: finite, maxX: finite, maxY: finite }).strict()
  .refine((value) => value.maxX >= value.minX && value.maxY >= value.minY &&
    Number.isFinite(value.maxX - value.minX) && Number.isFinite(value.maxY - value.minY),
  "도형 경계의 순서와 길이가 올바르지 않습니다.");
export type Point = z.infer<typeof mapPointSchema>;
export type Bounds = z.infer<typeof mapBoundsSchema>;

export const mapTransformSchema = z.object({
  x: finite, y: finite, scaleX: positive.max(100), scaleY: positive.max(100),
  rotation: finite.min(-360).max(360)
}).strict();
export const mapStyleSchema = z.object({
  strokeColor: colorSchema.nullable(), fillColor: colorSchema.nullable(),
  strokeWidth: finite.nonnegative(), opacity: finite.min(0).max(1)
}).strict();
const base = {
  id: idSchema, groupId: idSchema.nullable(), layerId: idSchema, zIndex: integer,
  visible: z.boolean(), locked: z.boolean(), transform: mapTransformSchema, style: mapStyleSchema,
  provenance: z.object({ importJobId: idSchema, sourceId: idSchema }).strict().nullable()
};
const pointArray = z.array(mapPointSchema).max(MAP_ELEMENT_MAX_POINTS);
const rawMapElementSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("line"), geometry: z.object({ start: mapPointSchema, end: mapPointSchema }).strict() }).strict(),
  z.object({ ...base, type: z.literal("rectangle"), geometry: z.object({ origin: mapPointSchema, width: positive, height: positive }).strict() }).strict(),
  z.object({ ...base, type: z.literal("triangle"), geometry: z.object({ points: z.tuple([mapPointSchema, mapPointSchema, mapPointSchema]) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("ellipse"), geometry: z.object({ center: mapPointSchema, radiusX: positive, radiusY: positive }).strict() }).strict(),
  z.object({ ...base, type: z.literal("arc"), geometry: z.object({
    center: mapPointSchema, radius: positive, startAngle: finite, endAngle: finite, counterClockwise: z.boolean()
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal("polyline"), geometry: z.object({ points: pointArray.min(2) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("polygon"), geometry: z.object({
    outer: pointArray.min(3), holes: z.array(pointArray.min(3)).max(Math.floor(MAP_ELEMENT_MAX_POINTS / 3))
  }).strict() }).strict(),
  z.object({ ...base, type: z.literal("text"), geometry: z.object({
    position: mapPointSchema,
    text: z.string().max(MAP_ELEMENT_MAX_TEXT_LENGTH).refine(wellFormedUnicode, "올바른 유니코드 문자열이 필요합니다."),
    // Empty text keeps a zero-size layout box, matching the existing text contract.
    width: finite.nonnegative(), height: finite.nonnegative(), fontSize: positive
  }).strict() }).strict()
]);
export type MapElement = z.infer<typeof rawMapElementSchema>;
type ShapeOnly<T> = T extends MapElement ? Pick<T, "type" | "geometry"> : never;
export type MapShape = ShapeOnly<MapElement>;

export const mapElementSchema = serializedBudget(MAP_ELEMENT_MAX_BYTES).pipe(rawMapElementSchema.superRefine((element, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: ["geometry"], message });
  if (element.type === "line") {
    const { start, end } = element.geometry;
    if (start.x === end.x && start.y === end.y) issue("선의 두 끝점은 달라야 합니다.");
  }
  if (element.type === "polyline") {
    const points = element.geometry.points;
    if (points.every((p) => p.x === points[0].x && p.y === points[0].y)) issue("연속선은 길이가 있어야 합니다.");
  }
  if (element.type === "triangle" || element.type === "polygon") {
    const outer = element.type === "triangle" ? element.geometry.points : element.geometry.outer;
    const holes = element.type === "triangle" ? [] : element.geometry.holes;
    if (outer.length + holes.reduce((count, ring) => count + ring.length, 0) > MAP_ELEMENT_MAX_POINTS) {
      issue("요소의 전체 꼭짓점 수가 한도를 초과했습니다.");
      return;
    }
    const error = getMapPolygonValidationError(outer, holes);
    if (error) issue(error);
  }
  try { getMapElementBounds(element); }
  catch { issue("변환된 도형 경계와 길이는 유한값이어야 합니다."); }
}));

export const mapGroupSchema = z.object({
  id: idSchema, parentId: idSchema.nullable(), name: nameSchema, locked: z.boolean(), visible: z.boolean()
}).strict();
export const mapLayerSchema = z.object({
  id: idSchema, name: nameSchema, order: integer, locked: z.boolean(), visible: z.boolean()
}).strict();
export type MapGroup = z.infer<typeof mapGroupSchema>;
export type MapLayer = z.infer<typeof mapLayerSchema>;
const elementOps = [
  z.object({ kind: z.literal("add"), element: mapElementSchema }).strict(),
  z.object({ kind: z.literal("update"), element: mapElementSchema }).strict(),
  z.object({ kind: z.literal("delete"), id: idSchema }).strict()
] as const;
const structureOps = [
  z.object({ kind: z.literal("group.put"), group: mapGroupSchema }).strict(),
  z.object({ kind: z.literal("group.delete"), id: idSchema }).strict(),
  z.object({ kind: z.literal("layer.put"), layer: mapLayerSchema }).strict(),
  z.object({ kind: z.literal("layer.delete"), id: idSchema }).strict()
] as const;
export const mapElementOpSchema = z.discriminatedUnion("kind", elementOps);
export const mapStructureOpSchema = z.discriminatedUnion("kind", structureOps);
export const mapOpSchema = z.discriminatedUnion("kind", [...elementOps, ...structureOps]);
export type MapElementOp = z.infer<typeof mapElementOpSchema>;
export type MapStructureOp = z.infer<typeof mapStructureOpSchema>;
export type MapOp = z.infer<typeof mapOpSchema>;
export const mapOperationsSchema = z.array(mapOpSchema).min(1).max(MAP_MUTATION_MAX_OPERATIONS).superRefine((operations, context) => {
  const seen = new Set<string>();
  operations.forEach((operation, index) => {
    const key = operation.kind === "group.put" ? `group:${operation.group.id}`
      : operation.kind === "layer.put" ? `layer:${operation.layer.id}`
      : operation.kind === "group.delete" ? `group:${operation.id}`
      : operation.kind === "layer.delete" ? `layer:${operation.id}`
      : `element:${operation.kind === "delete" ? operation.id : operation.element.id}`;
    if (seen.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "같은 대상을 한 요청에서 두 번 변경할 수 없습니다." });
    seen.add(key);
  });
});

export const mapAssetRefSchema = z.object({
  assetId: idSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: positive.int().max(Number.MAX_SAFE_INTEGER), decodedByteSize: positive.int().max(Number.MAX_SAFE_INTEGER)
}).strict();
export const mapDocumentRefSchema = z.object({
  formatVersion: z.literal(MAP_DOCUMENT_FORMAT_VERSION), generationId: idSchema, revision: nonnegativeInteger,
  width: positive.int().min(MAP_DOCUMENT_EXTREME_MIN_SHORT_SIDE).max(MAP_DOCUMENT_MAX_LONG_SIDE),
  height: positive.int().min(MAP_DOCUMENT_EXTREME_MIN_SHORT_SIDE).max(MAP_DOCUMENT_MAX_LONG_SIDE),
  // Keep existing editor custom grids; 10..100 in steps of 5 is a creation default,
  // not a restriction on a saved user's grid (existing editor allows 5..200).
  gridSize: positive.int().min(5).max(200), elementCount: nonnegativeInteger.max(MAP_DOCUMENT_MAX_ELEMENTS),
  manifest: mapAssetRefSchema
}).strict();
export const mapMutationSchema = serializedBudget(MAP_MUTATION_MAX_BYTES).pipe(z.object({
  requestId: idSchema, generationId: idSchema, baseRevision: nonnegativeInteger.max(POSTGRES_INT_MAX - 1),
  leaseToken: idSchema, operations: mapOperationsSchema
}).strict());
export const mapMutationResultSchema = z.object({
  document: mapDocumentRefSchema, changedBounds: z.array(mapBoundsSchema).max(MAP_MUTATION_MAX_OPERATIONS * 2)
}).strict();
export type MapAssetRef = z.infer<typeof mapAssetRefSchema>;
export type MapDocumentRef = z.infer<typeof mapDocumentRefSchema>;
export type MapMutation = z.infer<typeof mapMutationSchema>;
export type MapMutationResult = z.infer<typeof mapMutationResultSchema>;

export type MapDocumentState = { elements: MapElement[]; groups: MapGroup[]; layers: MapLayer[] };
function structureError(state: MapDocumentState): string | null {
  const elements = new Set(state.elements.map((element) => element.id));
  const layers = new Set(state.layers.map((layer) => layer.id));
  const groups = new Map(state.groups.map((group) => [group.id, group]));
  if (elements.size !== state.elements.length || layers.size !== state.layers.length || groups.size !== state.groups.length) {
    return "문서 안에서 같은 종류의 식별자가 중복됩니다.";
  }
  for (const element of state.elements) {
    if (!layers.has(element.layerId) || (element.groupId !== null && !groups.has(element.groupId))) {
      return "요소가 존재하지 않는 레이어 또는 그룹을 참조합니다.";
    }
  }
  // Iterative marking avoids recursion overflow and repeated ancestor walks for
  // deep imported groups. Each group is visited at most once across all roots.
  const complete = new Set<string>();
  for (const group of state.groups) {
    const path = new Set<string>();
    let current: string | null = group.id;
    while (current !== null && !complete.has(current)) {
      if (path.has(current)) return "그룹에 순환 참조가 있습니다.";
      const parent = groups.get(current);
      if (!parent) return "존재하지 않는 상위 그룹을 참조합니다.";
      path.add(current);
      current = parent.parentId;
    }
    for (const id of path) complete.add(id);
  }
  return null;
}
export const mapDocumentStateSchema = z.object({
  elements: z.array(mapElementSchema).max(MAP_DOCUMENT_MAX_ELEMENTS),
  groups: z.array(mapGroupSchema).max(MAP_DOCUMENT_MAX_ELEMENTS),
  layers: z.array(mapLayerSchema).max(MAP_DOCUMENT_MAX_ELEMENTS)
}).strict().superRefine((state, context) => {
  const error = structureError(state);
  if (error) context.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

/** Pure structural validation. The caller separately enforces authorization,
 * lease, generation/revision and effective group/layer/element lock policy.
 * State must already be parsed; no whole-document geometry reparse per edit.
 */
export function validateMapOperations(state: MapDocumentState, input: unknown): void {
  const beforeError = structureError(state);
  if (beforeError) throw new Error(beforeError);
  const operations = mapOperationsSchema.parse(input);
  const elements = new Map(state.elements.map((element) => [element.id, element]));
  const groups = new Map(state.groups.map((group) => [group.id, group]));
  const layers = new Map(state.layers.map((layer) => [layer.id, layer]));
  for (const operation of operations) {
    switch (operation.kind) {
      case "add":
        if (elements.has(operation.element.id)) throw new Error("추가할 요소가 이미 존재합니다.");
        elements.set(operation.element.id, operation.element); break;
      case "update":
        if (!elements.has(operation.element.id)) throw new Error("수정할 요소가 존재하지 않습니다.");
        elements.set(operation.element.id, operation.element); break;
      case "delete":
        if (!elements.delete(operation.id)) throw new Error("삭제할 요소가 존재하지 않습니다.");
        break;
      case "group.put": groups.set(operation.group.id, operation.group); break;
      case "layer.put": layers.set(operation.layer.id, operation.layer); break;
      case "group.delete":
        if (!groups.delete(operation.id)) throw new Error("삭제할 그룹이 존재하지 않습니다.");
        break;
      case "layer.delete":
        if (!layers.delete(operation.id)) throw new Error("삭제할 레이어가 존재하지 않습니다.");
        break;
    }
  }
  const after = { elements: [...elements.values()], groups: [...groups.values()], layers: [...layers.values()] };
  if (after.elements.length > MAP_DOCUMENT_MAX_ELEMENTS || after.groups.length > MAP_DOCUMENT_MAX_ELEMENTS || after.layers.length > MAP_DOCUMENT_MAX_ELEMENTS) {
    throw new Error("문서의 요소 또는 구성 개수가 한도를 초과했습니다.");
  }
  const error = structureError(after);
  if (error) throw new Error(error);
}
