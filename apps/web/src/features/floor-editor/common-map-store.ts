import type { MapDocumentRef, MapElement, MapGroup, MapLayer, MapOp } from "@led-control/shared";
import type { EditorChangeSet } from "./editor-diff";
import { MAP_DOCUMENT_MAX_ELEMENTS, mapDocumentRefSchema, mapElementSchema, mapGroupSchema, mapLayerSchema, mapOpSchema } from "@led-control/shared/map-document-contracts";
import { applyMapOps } from "./map-element-commands";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { MapElementHistory } from "./map-element-history";

export interface MapEditorScope {
  authScope: string;
  siteId: string;
  floorId: string;
  generationId: string;
  baseRevision: number;
  epoch: number;
}
export interface CommonMapDraft {
  scope: Omit<MapEditorScope, "epoch">;
  operations: MapOp[];
  inverse: MapOp[];
  stage?: { stageId: string; preview: MapDocumentRef; kind: "stream" | "undo" | "redo";
    digest: { partCount: number; decodedBytes: number; sha256: string } | null; capturedChanges: EditorChangeSet };
}
export interface MapSelection {
  elementIds: string[];
  groupIds: string[];
}
export class MapEditorError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "MapEditorError"; }
}

export function parseCommonMapDraft(input: unknown): CommonMapDraft {
  const draft = input as CommonMapDraft;
  const scope = draft?.scope;
  if (!draft || Object.keys(draft).some((key) => !["scope", "operations", "inverse", "stage"].includes(key))
    || !scope || Object.keys(scope).length !== 5
    || ![scope.authScope, scope.siteId, scope.floorId, scope.generationId].every((id) => typeof id === "string" && id.length > 0)
    || !Number.isInteger(scope.baseRevision) || scope.baseRevision < 0
    || !Array.isArray(draft.operations) || !Array.isArray(draft.inverse)
    || draft.operations.length !== draft.inverse.length
    || new TextEncoder().encode(JSON.stringify(input)).byteLength > 32 * 1024 * 1024) {
    throw new MapEditorError("MAP_DRAFT_INVALID", "맵 초안을 복구할 수 없습니다.");
  }
  const operations = draft.operations.map((op) => mapOpSchema.parse(op));
  const inverse = draft.inverse.map((op) => mapOpSchema.parse(op));
  const keys = operations.map(mapOperationKey), inverseKeys = inverse.map(mapOperationKey).reverse();
  if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== inverseKeys[index])) throw new MapEditorError("MAP_DRAFT_INVALID", "맵 초안의 복원 명령이 올바르지 않습니다.");
  if (draft.stage) {
    const stage = draft.stage, digest = stage.digest;
    if (Object.keys(stage).some(key => !["stageId", "preview", "kind", "digest", "capturedChanges"].includes(key))
      || typeof stage.stageId !== "string" || !stage.stageId || stage.stageId.length > 256
      || !["stream", "undo", "redo"].includes(stage.kind) || !stage.capturedChanges
      || digest !== null && (!digest || Object.keys(digest).length !== 3 || !Number.isInteger(digest.partCount) || digest.partCount < 1 || digest.partCount > 1024
        || !Number.isInteger(digest.decodedBytes) || digest.decodedBytes < 1 || digest.decodedBytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(digest.sha256))) {
      throw new MapEditorError("MAP_DRAFT_INVALID", "대량 편집 초안 참조가 올바르지 않습니다.");
    }
    mapDocumentRefSchema.parse(stage.preview);
    if (stage.preview.revision !== scope.baseRevision + 1) throw new MapEditorError("MAP_DRAFT_INVALID", "대량 편집 초안 버전을 확인해주세요.");
  }
  return { scope: { ...scope }, operations, inverse, ...(draft.stage ? { stage: structuredClone(draft.stage) } : {}) };
}

type Value = MapElement | MapGroup | MapLayer;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const mapOperationKey = (op: MapOp) => op.kind === "group.put" ? `group:${op.group.id}`
  : op.kind === "layer.put" ? `layer:${op.layer.id}`
  : op.kind === "group.delete" ? `group:${op.id}` : op.kind === "layer.delete" ? `layer:${op.id}`
  : `element:${op.kind === "delete" ? op.id : op.element.id}`;
const valueOf = (op: MapOp): Value | null => op.kind === "add" || op.kind === "update" ? op.element
  : op.kind === "group.put" ? op.group : op.kind === "layer.put" ? op.layer : null;
function operationFor(key: string, value: Value | null, before: Value | null): MapOp {
  const colon = key.indexOf(":");
  const namespace = key.slice(0, colon), id = key.slice(colon + 1);
  if (namespace === "element") return value ? { kind: before ? "update" : "add", element: value as MapElement } : { kind: "delete", id };
  if (namespace === "group") return value ? { kind: "group.put", group: value as MapGroup } : { kind: "group.delete", id };
  return value ? { kind: "layer.put", layer: value as MapLayer } : { kind: "layer.delete", id };
}

/** Not another Zustand store: a sparse command adapter owned by the editor's
 * single transaction timeline. Clean canonical data is disposable; only touched
 * baselines, current changes and history-referenced originals are retained. */
export class CommonMapStore {
  private cache = new Map<string, { value: Value; bytes: number }>();
  private cacheBytes = 0;
  private structures = new Map<string, { value: MapGroup | MapLayer; bytes: number }>();
  private structureBytes = 0;
  private originals = new Map<string, Value | null>();
  private changes = new Map<string, Value | null>();

  get isDirty() { return this.changes.size > 0; }
  get operations(): MapOp[] {
    return [...this.changes].map(([key, value]) => operationFor(key, value, this.originals.get(key) ?? null));
  }
  view() {
    const values = new Map<string, Value | null>();
    for (const [key, entry] of this.cache) values.set(key, entry.value);
    for (const [key, entry] of this.structures) values.set(key, entry.value);
    for (const [key, value] of this.originals) values.set(key, value);
    for (const [key, value] of this.changes) values.set(key, value);
    const mapElements = new Map<string, MapElement>(), mapGroups = new Map<string, MapGroup>(), mapLayers = new Map<string, MapLayer>();
    for (const [key, value] of values) {
      if (!value) continue;
      if (key.startsWith("element:")) mapElements.set(value.id, value as MapElement);
      else if (key.startsWith("group:")) mapGroups.set(value.id, value as MapGroup);
      else mapLayers.set(value.id, value as MapLayer);
    }
    return { mapElements, mapGroups, mapLayers, mapOperations: this.operations };
  }
  private read(key: string): Value | null | undefined {
    return this.changes.has(key) ? this.changes.get(key) : this.originals.has(key) ? this.originals.get(key)
      : this.cache.get(key)?.value ?? this.structures.get(key)?.value;
  }
  private cacheValue(key: string, value: Value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const previous = this.cache.get(key);
    if (previous) this.cacheBytes -= previous.bytes;
    this.cache.delete(key);
    // A single huge canonical element is retained only once it is part of an
    // explicit transaction. The normal cache never grows past its byte budget.
    if (bytes > 8 * 1024 * 1024) return;
    this.cache.set(key, { value, bytes }); this.cacheBytes += bytes;
    while (this.cache.size > 256 || this.cacheBytes > 8 * 1024 * 1024) {
      const oldest = this.cache.entries().next().value!;
      this.cache.delete(oldest[0]); this.cacheBytes -= oldest[1].bytes;
    }
  }
  loadElements(elements: MapElement[]) {
    for (const input of elements) {
      const value = mapElementSchema.parse(input);
      this.cacheValue(`element:${value.id}`, value);
    }
  }
  loadStructures(input: { groups: MapGroup[]; layers: MapLayer[] }) {
    const next = new Map(this.structures);
    let bytes = this.structureBytes;
    const add = (key: string, value: MapGroup | MapLayer) => {
      const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      bytes += size - (next.get(key)?.bytes ?? 0);
      if (bytes > 32 * 1024 * 1024 || next.size > MAP_DOCUMENT_MAX_ELEMENTS * 2) {
        throw new MapEditorError("MAP_STRUCTURE_CAPACITY", "맵 구성 정보가 메모리 한도를 초과했습니다. 편집 내용을 유지합니다.");
      }
      next.set(key, { value, bytes: size });
    };
    if (input.groups.length > MAP_DOCUMENT_MAX_ELEMENTS || input.layers.length > MAP_DOCUMENT_MAX_ELEMENTS) {
      throw new MapEditorError("MAP_STRUCTURE_CAPACITY", "맵 구성 개수 한도를 초과했습니다.");
    }
    for (const inputGroup of input.groups) {
      const value = mapGroupSchema.parse(inputGroup); add(`group:${value.id}`, value);
    }
    for (const inputLayer of input.layers) {
      const value = mapLayerSchema.parse(inputLayer); add(`layer:${value.id}`, value);
    }
    // Manifest structure is complete metadata, not an element LRU entry. Reject
    // over-budget loads atomically instead of silently losing ancestor/lock data.
    this.structures = next; this.structureBytes = bytes;
  }
  prepare(input: MapOp[], options: { canonicalElements?: MapElement[]; bounds?: { width: number; height: number } } = {}) {
    const operations = input.map((op) => mapOpSchema.parse(op));
    const injected = new Map(options.canonicalElements?.map((element) => [element.id, element]));
    const baselines = new Map<string, Value | null>();
    const affected = new Map<string, Value | null>();
    const forward: MapOp[] = [], inverse: MapOp[] = [];
    const read = (key: string): Value | null | undefined => {
      if (affected.has(key)) return affected.get(key);
      const loaded = this.read(key);
      if (loaded !== undefined || !key.startsWith("element:")) return loaded;
      if (baselines.has(key)) return baselines.get(key);
      const original = injected.get(key.slice(8));
      if (!original) return undefined;
      const parsed = mapElementSchema.parse(original);
      baselines.set(key, parsed);
      return parsed;
    };
    const checkParents = (element: MapElement) => {
      const layer = read(`layer:${element.layerId}`) as MapLayer | null | undefined;
      if (!layer) throw new MapEditorError("MAP_STRUCTURE_UNLOADED", "선택한 도형의 레이어를 먼저 불러와주세요.");
      if (layer.locked) throw new MapEditorError("MAP_LOCKED", "잠긴 레이어의 도형은 편집할 수 없습니다.");
      let id = element.groupId;
      const seen = new Set<string>();
      while (id) {
        if (seen.has(id)) throw new MapEditorError("MAP_GROUP_CYCLE", "그룹의 참조 관계를 확인해주세요.");
        seen.add(id);
        const group = read(`group:${id}`) as MapGroup | null | undefined;
        if (!group) throw new MapEditorError("MAP_STRUCTURE_UNLOADED", "선택한 도형의 그룹을 먼저 불러와주세요.");
        if (group.locked) throw new MapEditorError("MAP_LOCKED", "잠긴 그룹의 도형은 편집할 수 없습니다.");
        id = group.parentId;
      }
    };
    for (const op of operations) {
      const key = mapOperationKey(op), before = read(key) ?? null, after = valueOf(op);
      if (before && same(before, after) && op.kind !== "add") continue;
      if (options.bounds) {
        const flagsOnly = before && after && same({ ...before, locked: after.locked, visible: after.visible }, after);
        if (before?.locked && !flagsOnly) throw new MapEditorError("MAP_LOCKED", "잠긴 도형은 잠금 해제 후 편집해주세요.");
        if (key.startsWith("element:")) {
          if (before) checkParents(before as MapElement);
          if (after) {
            checkParents(after as MapElement);
            const bounds = getMapElementBounds(after as MapElement);
            if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > options.bounds.width || bounds.maxY > options.bounds.height) {
              throw new MapEditorError("MAP_OUT_OF_BOUNDS", "도형이 맵 영역을 벗어났습니다.");
            }
          }
        }
      }
      if (op.kind === "add" || op.kind === "update" || op.kind === "delete") {
        const subset = new Map<string, MapElement>();
        if (before) subset.set(before.id, before as MapElement);
        const result = applyMapOps(subset, [op]);
        inverse.push(...result.inverse);
      } else {
        if (!before && after === null) throw new MapEditorError("MAP_STRUCTURE_MISSING", "편집할 그룹 또는 레이어를 먼저 불러와주세요.");
        inverse.push(operationFor(key, before, after));
      }
      affected.set(key, after); forward.push(op);
    }
    const history = new MapElementHistory();
    history.execute(forward, inverse.reverse());
    return { forward, history, keys: [...affected.keys()], baselines };
  }
  applyPrepared(prepared: ReturnType<CommonMapStore["prepare"]>) {
    for (const [key, value] of prepared.baselines) if (!this.originals.has(key)) this.originals.set(key, value);
    this.apply(prepared.forward);
  }
  apply(operations: MapOp[]) {
    for (const op of operations) {
      const key = mapOperationKey(op);
      if (!this.originals.has(key)) this.originals.set(key, this.read(key) ?? null);
      const value = valueOf(op);
      if (same(this.originals.get(key), value)) this.changes.delete(key);
      else this.changes.set(key, value);
    }
  }
  seedMissingHistory(operations: MapOp[]) {
    // A restored server checkpoint intentionally has no full canonical cache.
    // The opposite side of the retained command supplies only its touched IDs.
    for (const op of operations) {
      const key = mapOperationKey(op);
      if (this.read(key) === undefined) this.originals.set(key, valueOf(op));
    }
  }
  acknowledge(operations: MapOp[]) {
    const updates = operations.map((op) => {
      const key = mapOperationKey(op), current = this.read(key);
      // An unloaded canonical value is unknown, not a user deletion. Validate
      // every target before changing any acknowledged baseline.
      if (current === undefined) throw new MapEditorError("MAP_ACK_TARGET_UNLOADED", "저장 응답에 필요한 도형 원본이 없습니다. 편집 내용을 유지합니다.");
      return { key, current, saved: valueOf(op) };
    });
    for (const { key, current, saved } of updates) {
      this.originals.set(key, saved);
      if (same(current, saved)) this.changes.delete(key);
      else this.changes.set(key, current);
    }
  }
  retain(historyKeys: Set<string>) {
    for (const [key, value] of this.originals) {
      if (this.changes.has(key) || historyKeys.has(key)) continue;
      if (!key.startsWith("element:")) {
        const previous = this.structures.get(key);
        if (previous) { this.structureBytes -= previous.bytes; this.structures.delete(key); }
        if (value) {
          const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
          this.structures.set(key, { value: value as MapGroup | MapLayer, bytes }); this.structureBytes += bytes;
        }
      } else if (value) this.cacheValue(key, value);
      else {
        const old = this.cache.get(key);
        if (old) { this.cacheBytes -= old.bytes; this.cache.delete(key); }
      }
      this.originals.delete(key);
    }
  }
  draft(scope: MapEditorScope): CommonMapDraft {
    const { epoch: _epoch, ...identity } = scope;
    const operations = this.operations;
    return structuredClone({ scope: identity, operations,
      inverse: [...this.changes].reverse().map(([key, value]) => operationFor(key, this.originals.get(key) ?? null, value)) });
  }
  restore(draft: CommonMapDraft) {
    const parsed = parseCommonMapDraft(draft);
    const candidate = new CommonMapStore();
    // Validate both directions before publishing any recovered baseline. An
    // optional but malformed draft must not partially replace live canonical data.
    for (const op of parsed.inverse) {
      const key = mapOperationKey(op), original = valueOf(op), loaded = this.read(key);
      if (loaded !== undefined && !same(loaded, original)) throw new MapEditorError("MAP_DRAFT_STALE", "맵 원본과 초안이 일치하지 않습니다.");
      candidate.originals.set(key, original);
    }
    const prepared = candidate.prepare(parsed.operations);
    const inverse = prepared.history.undo();
    prepared.history.redo();
    if (!same(inverse ?? [], parsed.inverse)) throw new MapEditorError("MAP_DRAFT_INVALID", "맵 초안의 실행 취소 정보를 확인할 수 없습니다.");
    for (const [key, value] of candidate.originals) this.originals.set(key, value);
    return prepared;
  }
}
