import { create } from "zustand";
import type { EDITOR_MAX_NAME_LENGTH, MapElement, MapGroup, MapLayer, MapOp, SaveEditorStateInput } from "@led-control/shared";
import { MAP_MUTATION_MAX_BYTES, MAP_MUTATION_MAX_OPERATIONS, mapDocumentRefSchema } from "@led-control/shared/map-document-contracts";
import { saveFloorEditorState } from "../../api/floor-editor";
import { CommonMapStore, MapEditorError, mapOperationKey, type CommonMapDraft, type MapEditorScope, type MapSelection } from "./common-map-store";
import type { MapElementHistory } from "./map-element-history";
import { buildEditorChanges, hasEditorChanges } from "./editor-diff";
import type { CadEditorSelection, EditorFixture, EditorTool, FloorEditorState, FloorMapObject, FloorMapObjectDraft, FloorPlanDraft } from "./editor-types";
import { clampEditorZoom, clampObjectToMap, snapPointToGridWithinBounds, snapRectToGrid, trianglePointsForSize, type Point } from "./geometry";

type Selection = { kind: "fixture" | "object"; id: string } | null;
export type FixturePatch = Partial<Pick<EditorFixture, "name" | "ratedWatt" | "x" | "y" | "size" | "placementStatus" | "positionVerified">>;
export type PlacementPoint = Point & { id: string };
type LayerName = "background" | "objects" | "fixtures";
type LayerSettings = Record<LayerName, { visible: boolean; locked: boolean }>;
type MapSettings = { width: number; height: number; gridSize: number };
function mapSettings(state: FloorEditorState): MapSettings {
  return {
    width: state.floor.mapDocument?.width ?? state.floor.floorPlan?.width ?? 1200,
    height: state.floor.mapDocument?.height ?? state.floor.floorPlan?.height ?? 800,
    gridSize: state.floor.floorPlan?.gridSize ?? state.floor.mapDocument?.gridSize ?? 10
  };
}
// The shared root is CommonJS, so enforce its literal limit through a type-only
// import without pulling that runtime entry into the browser editor bundle.
const maxFixtureNameLength: typeof EDITOR_MAX_NAME_LENGTH = 200;
interface MapCommand { history: MapElementHistory; keys: string[] }
interface HistoryEntry { state: FloorEditorState; selection: Selection; selectedFixtureIds: string[]; mapSelection: MapSelection; mapCommand?: MapCommand }
export interface MapEditorTransaction {
  operations: MapOp[];
  /** Capture before resolving canonical data; required with injected originals. */
  scope?: MapEditorScope;
  canonicalElements?: MapElement[];
  fixtureUpdates?: Array<FixturePatch & { id: string }>;
  slotAssignments?: SaveEditorStateInput["slotAssignments"];
  floorPlan?: FloorPlanDraft | null;
}
export interface PreparedEditorSave {
  kind: "normal" | "staging-required";
  reason?: "operations" | "bytes" | "checkpoint";
  payload: SaveEditorStateInput;
  byteSize: number;
}
type EditorLease = Pick<SaveEditorStateInput, "leaseToken" | "leaseFence">;
type SaveTransport = (floorId: string, payload: SaveEditorStateInput) => Promise<FloorEditorState>;
const defaultLayers = (): LayerSettings => ({ background: { visible: true, locked: true }, objects: { visible: true, locked: false }, fixtures: { visible: true, locked: false } });

interface EditorStore {
  mapScope: MapEditorScope | null;
  mapElements: ReadonlyMap<string, MapElement>;
  mapGroups: ReadonlyMap<string, MapGroup>;
  mapLayers: ReadonlyMap<string, MapLayer>;
  mapOperations: MapOp[];
  mapSelection: MapSelection;
  isSaving: boolean;
  loadMapElements: (scope: MapEditorScope, elements: MapElement[]) => boolean;
  loadMapStructures: (scope: MapEditorScope, structures: { groups: MapGroup[]; layers: MapLayer[] }) => boolean;
  applyMapTransaction: (transaction: MapEditorTransaction) => void;
  selectMapElements: (ids: string[], additive?: boolean) => void;
  selectMapGroups: (ids: string[], additive?: boolean) => void;
  exportMapDraft: () => CommonMapDraft | null;
  prepareSave: (lease: EditorLease) => PreparedEditorSave;
  saveChanges: (lease: EditorLease, transport?: SaveTransport) => Promise<"saved" | "stale">;
  initialState: FloorEditorState | null;
  state: FloorEditorState | null;
  isDirty: boolean;
  dirtyFixtureIds: string[];
  dirtyObjectIds: string[];
  activeTool: EditorTool;
  zoom: number;
  pan: Point;
  viewport: { width: number; height: number };
  selection: Selection;
  cadSelection: CadEditorSelection | null;
  selectedFixtureIds: string[];
  lockedFixtureIds: string[];
  layers: LayerSettings;
  snap: boolean;
  preview: PlacementPoint[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  initialize: (state: FloorEditorState, authScope?: string) => void;
  reset: () => void;
  adoptBaseline: (state: FloorEditorState, preserveHistory?: boolean) => void;
  recoverDraft: (state: FloorEditorState & { commonMapDraft?: CommonMapDraft }) => void;
  discardChanges: () => void;
  undo: () => void;
  redo: () => void;
  setActiveTool: (tool: EditorTool) => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: Point) => void;
  setViewport: (viewport: { width: number; height: number }) => void;
  fit: (selected?: boolean, bounds?: { width: number; height: number }) => void;
  resetZoom: () => void;
  selectFixture: (fixtureId: string, additive?: boolean) => void;
  selectFixtures: (ids: string[], additive?: boolean) => void;
  selectObject: (objectId: string) => void;
  selectCad: (selection: CadEditorSelection | null) => void;
  clearSelection: () => void;
  updateFixture: (fixtureId: string, patch: FixturePatch) => void;
  updateFixtureProperties: (ids: string[], patch: FixturePatch | ((fixture: EditorFixture, index: number) => FixturePatch)) => void;
  placeFixtures: (placements: PlacementPoint[]) => void;
  assignFixtureToSlot: (fixtureId: string, slotId: string) => void;
  unassignFixture: (fixtureId: string) => void;
  unplaceFixture: (id: string) => void;
  moveFixtures: (ids: string[], delta: Point) => void;
  setPreview: (preview: PlacementPoint[]) => void;
  setSnap: (snap: boolean) => void;
  setLayer: (layer: LayerName, patch: Partial<LayerSettings[LayerName]>) => void;
  toggleFixtureLock: (ids: string[]) => void;
  updateFloorPlan: (floorPlan: FloorPlanDraft | null) => void;
  updateMapSettings: (settings: MapSettings) => string | null;
  addObject: (floorId: string, draft: FloorMapObjectDraft) => void;
  updateObject: (objectId: string, patch: Partial<FloorMapObject>) => void;
  removeObject: (objectId: string) => void;
}

export const useFloorEditorStore = create<EditorStore>((set, get) => {
  let common = new CommonMapStore();
  let epoch = 0;
  let retry: { fingerprint: string; requestId: string } | null = null;
  let pendingSaveKeys = new Set<string>();
  let batch: { state: FloorEditorState; extra: Partial<EditorStore> } | null = null;
  const emptySelection = (): MapSelection => ({ elementIds: [], groupIds: [] });
  const matchesScope = (scope: MapEditorScope) => JSON.stringify(scope) === JSON.stringify(get().mapScope);
  const commonReset = (state: FloorEditorState | null, authScope = "") => {
    if (state?.floor.mapDocument) {
      mapDocumentRefSchema.parse(state.floor.mapDocument);
      if (state.floor.mapDocument.revision !== state.floor.mapRevision || state.objects.length) throw new MapEditorError("MAP_DOCUMENT_INVALID", "맵 문서를 다시 불러와주세요.");
    }
    common = new CommonMapStore(); retry = null; pendingSaveKeys = new Set(); epoch++;
    const document = state?.floor.mapDocument;
    return { ...common.view(), mapSelection: emptySelection(), isSaving: false,
      mapScope: document && state ? { authScope, siteId: state.floor.siteId, floorId: state.floor.id,
        generationId: document.generationId, baseRevision: state.floor.mapRevision, epoch } : null };
  };
  const retain = (entries: HistoryEntry[]) => common.retain(new Set([
    ...pendingSaveKeys, ...entries.flatMap((entry) => entry.mapCommand?.keys ?? [])
  ]));
  const dirty = (state: FloorEditorState) => {
    const baseline = get().initialState;
    if (!baseline) return { isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [] };
    const changes = buildEditorChanges(baseline, state);
    return { isDirty: hasEditorChanges(changes) || common.isDirty, dirtyFixtureIds: changes.fixtureUpdates.map((f) => f.id), dirtyObjectIds: [...changes.objectUpdates.map((o) => o.id), ...changes.objectDeletes, ...state.objects.filter((o) => o.id.startsWith("draft-")).map((o) => o.id)] };
  };
  const snapshot = (): HistoryEntry => ({ state: get().state!, selection: get().selection, selectedFixtureIds: get().selectedFixtureIds, mapSelection: get().mapSelection });
  const commit = (state: FloorEditorState, extra: Partial<EditorStore> = {}, mapCommand?: MapCommand) => {
    if (batch) { batch = { state, extra: { ...batch.extra, ...extra } }; return; }
    if (state === get().state) return;
    const past = [...get().past.slice(-99), { ...snapshot(), mapCommand }];
    let bytes = past.reduce((sum, entry) => sum + (entry.mapCommand?.history.byteSize ?? 0), 0);
    while (bytes > 32 * 1024 * 1024 && past.length > 1) bytes -= past.shift()!.mapCommand?.history.byteSize ?? 0;
    retain(past);
    set({ ...dirty(state), ...common.view(), state, past, future: [], preview: [], ...extra });
  };
  const applyFixtures = (patches: Map<string, FixturePatch>, snapPositions = true) => {
    const { state, layers, lockedFixtureIds } = get();
    if (batch && state && (layers.fixtures.locked || !layers.fixtures.visible
      || [...patches.keys()].some((id) => lockedFixtureIds.includes(id) || !state.fixtures.some((fixture) => fixture.id === id)))) {
      throw new MapEditorError("MAP_FIXTURE_INVALID", "편집할 조명의 상태와 잠금을 확인해주세요.");
    }
    if (!state || layers.fixtures.locked || !layers.fixtures.visible) return;
    const locked = new Set(lockedFixtureIds);
    let changed = false;
    const placementChangedIds = new Set<string>();
    const fixtures = state.fixtures.map((fixture) => {
      const patch = patches.get(fixture.id);
      if (!patch || locked.has(fixture.id)) return fixture;
      const next = { ...fixture, ...patch };
      if (snapPositions && get().snap && ("x" in patch || "y" in patch)) {
        const settings = mapSettings(state);
        const point = snapPointToGridWithinBounds({ x: next.x, y: next.y }, settings.gridSize, settings);
        if ("x" in patch) next.x = point.x;
        if ("y" in patch) next.y = point.y;
      }
      // Partial edits must not normalize unrelated legacy geometry or reject
      // unchanged fields. The server validates the same narrow patch on save.
      if (("x" in patch && !Number.isFinite(next.x)) || ("y" in patch && !Number.isFinite(next.y))
        || ("ratedWatt" in patch && (!Number.isFinite(next.ratedWatt) || next.ratedWatt < 0 || next.ratedWatt > 10000))
        || ("size" in patch && (!Number.isFinite(next.size ?? 20) || (next.size ?? 20) < 4 || (next.size ?? 20) > 200))
        || ("name" in patch && (typeof next.name !== "string" || next.name.length > maxFixtureNameLength))) {
        if (batch) throw new MapEditorError("MAP_FIXTURE_INVALID", "조명 속성의 입력값을 확인해주세요.");
        return fixture;
      }
      if ("x" in patch) next.x = Math.max(0, Math.min(mapSettings(state).width, next.x));
      if ("y" in patch) next.y = Math.max(0, Math.min(mapSettings(state).height, next.y));
      if (next.x !== fixture.x || next.y !== fixture.y || next.placementStatus === "unplaced") {
        next.positionVerifiedAt = null;
        if (fixture.positionVerifiedAt || fixture.positionVerified) next.positionVerified = false;
      }
      if (next.placementStatus === "unplaced") next.positionVerified = false;
      if (!Object.keys(next).some((key) => !Object.is(next[key as keyof EditorFixture], fixture[key as keyof EditorFixture]))) return fixture;
      changed = true;
      if ("x" in patch || "y" in patch || "placementStatus" in patch) placementChangedIds.add(fixture.id);
      return next;
    });
    if (changed) {
      const fixturesById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
      const lightSlots = state.lightSlots.map((slot) => {
        if (!slot.assignedFixtureId || !placementChangedIds.has(slot.assignedFixtureId)) return slot;
        const fixture = fixturesById.get(slot.assignedFixtureId);
        return fixture?.placementStatus !== "unplaced" && fixture?.x === slot.x && fixture?.y === slot.y
          ? slot
          : { ...slot, assignedFixtureId: null };
      });
      commit({ ...state, fixtures, lightSlots });
    }
  };
  return {
    mapScope: null, ...common.view(), mapSelection: emptySelection(), isSaving: false,
    loadMapElements: (scope, elements) => {
      if (!matchesScope(scope)) return false;
      common.loadElements(elements); set(common.view()); return true;
    },
    loadMapStructures: (scope, structures) => {
      if (!matchesScope(scope)) return false;
      common.loadStructures(structures); set(common.view()); return true;
    },
    selectMapElements: (ids, additive = false) => set({ mapSelection: {
      elementIds: [...new Set([...(additive ? get().mapSelection.elementIds : []), ...ids])],
      groupIds: additive ? get().mapSelection.groupIds : []
    }, selection: null, cadSelection: null, selectedFixtureIds: [], activeTool: "select" }),
    selectMapGroups: (ids, additive = false) => set({ mapSelection: {
      groupIds: [...new Set([...(additive ? get().mapSelection.groupIds : []), ...ids])],
      elementIds: additive ? get().mapSelection.elementIds : []
    }, selection: null, cadSelection: null, selectedFixtureIds: [], activeTool: "select" }),
    applyMapTransaction: ({ operations, scope, canonicalElements, fixtureUpdates, slotAssignments, floorPlan }) => {
      const { state, mapScope, layers } = get();
      if (!state || !mapScope) throw new MapEditorError("MAP_DOCUMENT_REQUIRED", "공통 맵을 먼저 불러와주세요.");
      if (scope && !matchesScope(scope) || canonicalElements && !scope) throw new MapEditorError("MAP_SCOPE_CHANGED", "선택한 맵이 변경되었습니다. 다시 선택해주세요.");
      if (layers.objects.locked && operations.length) throw new MapEditorError("MAP_LOCKED", "잠긴 도형은 편집할 수 없습니다.");
      if (floorPlan !== undefined && (floorPlan?.width !== mapSettings(state).width || floorPlan?.height !== mapSettings(state).height)) {
        throw new MapEditorError("MAP_CHECKPOINT_REQUIRED", "맵 크기 변경은 체크포인트 저장 연결 후 사용할 수 있습니다.");
      }
      const prepared = common.prepare(operations, { canonicalElements, bounds: state.floor.mapDocument! });
      batch = { state, extra: {} };
      try {
        if (fixtureUpdates) applyFixtures(new Map(fixtureUpdates.map(({ id, ...patch }) => [id, patch])));
        let next = batch.state;
        if (slotAssignments?.length) {
          const assignments = new Map(slotAssignments.map((item) => [item.slotId, item.assignedFixtureId]));
          if (assignments.size !== slotAssignments.length || slotAssignments.some((item) => !next.lightSlots.some((slot) => slot.id === item.slotId)
            || item.assignedFixtureId !== null && !next.fixtures.some((fixture) => fixture.id === item.assignedFixtureId))) {
            throw new MapEditorError("MAP_SLOT_INVALID", "조명 슬롯 배정을 확인해주세요.");
          }
          next = { ...next, lightSlots: next.lightSlots.map((slot) => assignments.has(slot.id)
            ? { ...slot, assignedFixtureId: assignments.get(slot.id)! } : slot) };
        }
        if (floorPlan !== undefined) next = { ...next, floor: { ...next.floor, floorPlan } };
        const extra = batch.extra;
        batch = null;
        if (!prepared.forward.length && !hasEditorChanges(buildEditorChanges(state, next))) return;
        common.applyPrepared(prepared);
        commit({ ...next }, extra, prepared.forward.length ? { history: prepared.history, keys: prepared.keys } : undefined);
      } finally { batch = null; }
    },
    exportMapDraft: () => get().mapScope ? common.draft(get().mapScope!) : null,
    prepareSave: (lease) => {
      const { initialState, state } = get();
      if (!initialState || !state) throw new MapEditorError("MAP_DOCUMENT_REQUIRED", "편집할 층을 먼저 불러와주세요.");
      const changes = buildEditorChanges(initialState, state);
      const document = initialState.floor.mapDocument;
      const operations = common.operations;
      const fingerprint = JSON.stringify({ ...changes, ...lease, generationId: document?.generationId, operations });
      if (!retry || retry.fingerprint !== fingerprint) retry = { fingerprint, requestId: crypto.randomUUID() };
      const payload: SaveEditorStateInput = { ...buildEditorChanges(initialState, state, document ? {
        requestId: retry.requestId, generationId: document.generationId, operations
      } : undefined), ...lease };
      const byteSize = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
      const reason = document && changes.floorPlan !== undefined && (!changes.floorPlan
        || changes.floorPlan.width !== document.width || changes.floorPlan.height !== document.height || changes.floorPlan.gridSize !== document.gridSize)
        ? "checkpoint" : operations.length > MAP_MUTATION_MAX_OPERATIONS ? "operations" : byteSize > MAP_MUTATION_MAX_BYTES ? "bytes" : undefined;
      return { kind: reason ? "staging-required" : "normal", ...(reason ? { reason } : {}), payload, byteSize };
    },
    saveChanges: async (lease, transport = saveFloorEditorState) => {
      if (get().isSaving) throw new MapEditorError("MAP_SAVE_IN_PROGRESS", "맵을 저장하고 있습니다.");
      const prepared = get().prepareSave(lease);
      if (prepared.kind !== "normal") throw new MapEditorError(prepared.reason === "checkpoint" ? "MAP_CHECKPOINT_REQUIRED" : "MAP_STAGING_REQUIRED",
        prepared.reason === "checkpoint" ? "맵 설정 변경은 체크포인트 저장 연결이 필요합니다. 편집 내용은 유지됩니다." : "대량 변경 저장 연결이 필요합니다. 편집 내용은 유지됩니다.");
      const scopeEpoch = epoch, captured = get().state!, scope = get().mapScope;
      // Undo can make a pending target clean, then a new branch can remove its
      // last history reference. Keep its explicit value/tombstone until rebase.
      pendingSaveKeys = new Set(prepared.payload.documentChanges?.operations.map(mapOperationKey) ?? []);
      set({ isSaving: true });
      try {
        const saved = await transport(captured.floor.id, structuredClone(prepared.payload));
        if (scopeEpoch !== epoch) return "stale";
        const document = saved.floor.mapDocument;
        if (saved.floor.id !== captured.floor.id || saved.floor.siteId !== captured.floor.siteId
          || saved.floor.mapRevision !== prepared.payload.expectedRevision + 1
          || scope && (!document || document.generationId !== scope.generationId || document.revision !== saved.floor.mapRevision || saved.objects.length)) {
          throw new MapEditorError("MAP_SAVE_RESPONSE_INVALID", "저장 응답을 확인할 수 없습니다. 편집 내용을 유지합니다.");
        }
        if (document) mapDocumentRefSchema.parse(document);
        const current = get().state!;
        const changesAfterRequest = buildEditorChanges(captured, current);
        const fixturePatches = new Map(changesAfterRequest.fixtureUpdates.map(({ id, ...patch }) => [id, patch]));
        const slotPatches = new Map(changesAfterRequest.slotAssignments.map((item) => [item.slotId, item.assignedFixtureId]));
        const next: FloorEditorState = { ...saved,
          floor: { ...saved.floor, floorPlan: changesAfterRequest.floorPlan === undefined ? saved.floor.floorPlan : current.floor.floorPlan },
          fixtures: saved.fixtures.map((fixture) => {
            const patch = fixturePatches.get(fixture.id);
            if (!patch) return fixture;
            const next = { ...fixture, ...patch };
            if (next.x !== fixture.x || next.y !== fixture.y || next.placementStatus === "unplaced" || patch.positionVerified === false) {
              next.positionVerifiedAt = null;
              next.positionVerified = false;
            }
            return next;
          }),
          lightSlots: saved.lightSlots.map((slot) => slotPatches.has(slot.id) ? { ...slot, assignedFixtureId: slotPatches.get(slot.id)! } : slot),
          objects: current.objects === captured.objects ? saved.objects : current.objects
        };
        common.acknowledge(prepared.payload.documentChanges?.operations ?? []);
        retry = null;
        set({ initialState: saved, state: next, mapScope: scope ? { ...scope, baseRevision: saved.floor.mapRevision } : null });
        set({ ...dirty(next), ...common.view() });
        return "saved";
      } catch (error) {
        if (scopeEpoch !== epoch) return "stale";
        throw error;
      } finally {
        if (scopeEpoch === epoch) {
          pendingSaveKeys.clear();
          retain([...get().past, ...get().future]);
          set({ ...common.view(), isSaving: false });
        }
      }
    },
    initialState: null, state: null, isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [], activeTool: "select", zoom: 1,
    pan: { x: 0, y: 0 }, viewport: { width: 800, height: 600 }, selection: null, cadSelection: null, selectedFixtureIds: [],
    lockedFixtureIds: [], layers: defaultLayers(), snap: true, preview: [], past: [], future: [],
    initialize: (state, authScope = "") => set({ ...commonReset(state, authScope), initialState: state, state, isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [], activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null, cadSelection: null, selectedFixtureIds: [], lockedFixtureIds: [], layers: defaultLayers(), preview: [], past: [], future: [], snap: true }),
    reset: () => set({ ...commonReset(null), initialState: null, state: null, isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [], activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null, cadSelection: null, selectedFixtureIds: [], lockedFixtureIds: [], layers: defaultLayers(), preview: [], past: [], future: [], snap: true }),
    adoptBaseline: (state, preserveHistory = false) => {
      if (state.floor.mapDocument || get().mapScope) { get().initialize(state, get().mapScope?.authScope); return; }
      set({ initialState: state, state, isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [], ...(preserveHistory ? {} : { past: [], future: [], preview: [] }) });
    },
    recoverDraft: (recovered) => {
      const { commonMapDraft, ...state } = recovered;
      const baseline = get().initialState, scope = get().mapScope;
      if (!baseline || state.floor.id !== baseline.floor.id || state.floor.siteId !== baseline.floor.siteId
        || state.floor.mapRevision !== baseline.floor.mapRevision || state.floor.mapDocument?.generationId !== baseline.floor.mapDocument?.generationId) return;
      if (commonMapDraft) {
        if (!scope || Object.entries(commonMapDraft.scope).some(([key, value]) => scope[key as keyof MapEditorScope] !== value)) return;
        const prepared = common.restore(commonMapDraft);
        common.apply(prepared.forward);
        commit(state, {}, prepared.forward.length ? { history: prepared.history, keys: prepared.keys } : undefined);
      } else commit(state);
    },
    discardChanges: () => { const state = get().initialState; if (state) get().initialize(state, get().mapScope?.authScope); else get().reset(); },
    undo: () => {
      const entry = get().past.at(-1); if (!entry) return;
      const future = [...get().future, { ...snapshot(), mapCommand: entry.mapCommand }];
      if (entry.mapCommand) common.apply(entry.mapCommand.history.undo()!);
      const state = { ...entry.state, floor: { ...entry.state.floor, mapRevision: get().state!.floor.mapRevision, mapDocument: get().state!.floor.mapDocument } };
      set({ ...entry, state, ...dirty(state), ...common.view(), past: get().past.slice(0, -1), future, preview: [] });
    },
    redo: () => {
      const entry = get().future.at(-1); if (!entry) return;
      const past = [...get().past, { ...snapshot(), mapCommand: entry.mapCommand }];
      if (entry.mapCommand) common.apply(entry.mapCommand.history.redo()!);
      const state = { ...entry.state, floor: { ...entry.state.floor, mapRevision: get().state!.floor.mapRevision, mapDocument: get().state!.floor.mapDocument } };
      set({ ...entry, state, ...dirty(state), ...common.view(), past, future: get().future.slice(0, -1), preview: [] });
    },
    setActiveTool: (activeTool) => set({ activeTool, ...(activeTool !== "select" ? { selection: null, cadSelection: null, selectedFixtureIds: [] } : {}) }),
    setZoom: (zoom) => set({ zoom: clampEditorZoom(zoom) }),
    setPan: (pan) => set({ pan }),
    setViewport: (viewport) => set({ viewport }),
    resetZoom: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),
    fit: (selected = false, bounds) => {
      const { state, selectedFixtureIds, viewport } = get();
      if (!state) return;
      const ids = new Set(selectedFixtureIds);
      const fixtures = selected ? state.fixtures.filter((f) => ids.has(f.id) && f.placementStatus !== "unplaced") : [];
      if (selected && !fixtures.length) return;
      const x = fixtures.length ? Math.min(...fixtures.map((f) => f.x)) - 40 : 0;
      const y = fixtures.length ? Math.min(...fixtures.map((f) => f.y)) - 40 : 0;
      const width = fixtures.length ? Math.max(...fixtures.map((f) => f.x)) - x + 40 : bounds?.width ?? mapSettings(state).width;
      const height = fixtures.length ? Math.max(...fixtures.map((f) => f.y)) - y + 40 : bounds?.height ?? mapSettings(state).height;
      const zoom = Math.min(2, clampEditorZoom(Math.min((viewport.width - 48) / width, (viewport.height - 48) / height)));
      set({ zoom, pan: { x: (viewport.width - width * zoom) / 2 - x * zoom, y: (viewport.height - height * zoom) / 2 - y * zoom } });
    },
    selectFixture: (id, additive = false) => {
      const ids = additive ? get().selectedFixtureIds.includes(id) ? get().selectedFixtureIds.filter((value) => value !== id) : [...get().selectedFixtureIds, id] : [id];
      get().selectFixtures(ids);
    },
    selectFixtures: (ids, additive = false) => {
      const available = new Set(get().state?.fixtures.map((f) => f.id));
      const selectedFixtureIds = [...new Set([...(additive ? get().selectedFixtureIds : []), ...ids])].filter((id) => available.has(id));
      set({ selectedFixtureIds, mapSelection: emptySelection(), selection: selectedFixtureIds.length === 1 ? { kind: "fixture", id: selectedFixtureIds[0] } : null, cadSelection: null, activeTool: "select" });
    },
    selectObject: (id) => set({ selection: { kind: "object", id }, mapSelection: emptySelection(), cadSelection: null, selectedFixtureIds: [], activeTool: "select" }),
    selectCad: (cadSelection) => set({ cadSelection, mapSelection: emptySelection(), selection: null, selectedFixtureIds: [], activeTool: "select" }),
    clearSelection: () => set({ selection: null, mapSelection: emptySelection(), cadSelection: null, selectedFixtureIds: [] }),
    updateFixture: (id, patch) => applyFixtures(new Map([[id, patch]])),
    updateFixtureProperties: (ids, patch) => {
      const wanted = new Set(ids);
      const fixtures = get().state?.fixtures.filter((f) => wanted.has(f.id)) ?? [];
      applyFixtures(new Map(fixtures.map((f, i) => [f.id, typeof patch === "function" ? patch(f, i) : patch])));
    },
    placeFixtures: (placements) => applyFixtures(new Map(placements.map(({ id, ...point }) => [id, { ...point, placementStatus: "placed" }]))),
    assignFixtureToSlot: (fixtureId, slotId) => {
      const { state, layers, lockedFixtureIds } = get();
      if (!state || layers.fixtures.locked || !layers.fixtures.visible || lockedFixtureIds.includes(fixtureId)) return;
      const fixture = state.fixtures.find((item) => item.id === fixtureId);
      const slot = state.lightSlots.find((item) => item.id === slotId);
      if (!fixture || fixture.placementStatus !== "unplaced" || !slot || slot.assignedFixtureId !== null
        || state.lightSlots.some((item) => item.assignedFixtureId === fixtureId)) return;
      commit({
        ...state,
        fixtures: state.fixtures.map((item) => item.id === fixtureId ? {
          ...item,
          x: slot.x,
          y: slot.y,
          placementStatus: "placed",
          positionVerifiedAt: null,
          positionVerified: false
        } : item),
        lightSlots: state.lightSlots.map((item) => item.id === slotId ? { ...item, assignedFixtureId: fixtureId } : item)
      });
    },
    unassignFixture: (fixtureId) => {
      const { state, layers, lockedFixtureIds } = get();
      if (!state || layers.fixtures.locked || !layers.fixtures.visible || lockedFixtureIds.includes(fixtureId)) return;
      const fixture = state.fixtures.find((item) => item.id === fixtureId);
      if (!fixture) return;
      const hasAssignedSlot = state.lightSlots.some((item) => item.assignedFixtureId === fixtureId);
      if (fixture.placementStatus === "unplaced" && fixture.x === 0 && fixture.y === 0 && !hasAssignedSlot) return;
      commit({
        ...state,
        fixtures: state.fixtures.map((item) => item.id === fixtureId ? {
          ...item,
          x: 0,
          y: 0,
          placementStatus: "unplaced",
          positionVerifiedAt: null,
          positionVerified: false
        } : item),
        lightSlots: state.lightSlots.map((item) => item.assignedFixtureId === fixtureId ? { ...item, assignedFixtureId: null } : item)
      }, get().selection?.kind === "fixture" && get().selection?.id === fixtureId
        ? { selection: null, selectedFixtureIds: [] }
        : {});
    },
    unplaceFixture: (id) => get().unassignFixture(id),
    moveFixtures: (ids, delta) => {
      const { state, lockedFixtureIds } = get();
      if (!state || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return;
      const wanted = new Set(ids); const locked = new Set(lockedFixtureIds);
      const fixtures = state.fixtures.filter((f) => wanted.has(f.id) && !locked.has(f.id) && f.placementStatus !== "unplaced");
      if (!fixtures.length) return;
      const minimumX = Math.min(...fixtures.map((f) => f.x));
      const minimumY = Math.min(...fixtures.map((f) => f.y));
      const maximumX = Math.max(...fixtures.map((f) => f.x));
      const maximumY = Math.max(...fixtures.map((f) => f.y));
      const { width, height, gridSize } = mapSettings(state);
      let x = Math.max(-minimumX, Math.min(delta.x, width - maximumX));
      let y = Math.max(-minimumY, Math.min(delta.y, height - maximumY));
      if (get().snap) {
        const snappedAnchor = snapPointToGridWithinBounds(
          { x: minimumX + x, y: minimumY + y },
          gridSize,
          { width: width - (maximumX - minimumX), height: height - (maximumY - minimumY) }
        );
        x = snappedAnchor.x - minimumX;
        y = snappedAnchor.y - minimumY;
      }
      // A multi-selection is a rigid group. Its anchor snaps once so relative spacing is preserved.
      applyFixtures(new Map(fixtures.map((f) => [f.id, { x: f.x + x, y: f.y + y }])), false);
    },
    setPreview: (preview) => set({ preview }), setSnap: (snap) => set({ snap }),
    setLayer: (layer, patch) => set({ layers: { ...get().layers, [layer]: { ...get().layers[layer], ...patch } }, ...(layer === "fixtures" && patch.visible === false ? { selectedFixtureIds: [], selection: null, preview: [] } : {}) }),
    toggleFixtureLock: (ids) => { const locked = new Set(get().lockedFixtureIds); const unlock = ids.every((id) => locked.has(id)); ids.forEach((id) => unlock ? locked.delete(id) : locked.add(id)); set({ lockedFixtureIds: [...locked] }); },
    updateFloorPlan: (floorPlan) => {
      const state = get().state;
      if (state?.floor.mapDocument && (floorPlan?.width !== state.floor.mapDocument.width || floorPlan?.height !== state.floor.mapDocument.height)) {
        throw new MapEditorError("MAP_CHECKPOINT_REQUIRED", "맵 크기 변경은 체크포인트 저장 연결 후 사용할 수 있습니다.");
      }
      if (state) commit({ ...state, floor: { ...state.floor, floorPlan: floorPlan ? { ...floorPlan, gridSize: floorPlan.gridSize ?? state.floor.floorPlan?.gridSize ?? 10 } : null } });
    },
    updateMapSettings: ({ width, height, gridSize }) => {
      const state = get().state;
      if (state?.floor.mapDocument && (width !== state.floor.mapDocument.width || height !== state.floor.mapDocument.height)) {
        return "맵 크기 변경은 체크포인트 저장 연결 후 사용할 수 있습니다.";
      }
      if (!state || ![width, height, gridSize].every(Number.isInteger) || width < 1 || height < 1 || gridSize < 5 || gridSize > 200) {
        return "맵 크기와 격자 간격을 확인해주세요.";
      }
      const contentOutside = state.fixtures.some((fixture) => fixture.placementStatus !== "unplaced" && (fixture.x < 0 || fixture.y < 0 || fixture.x > width || fixture.y > height))
        || state.objects.some((object) => object.x < 0 || object.y < 0 || object.x + object.width > width || object.y + object.height > height);
      if (contentOutside) return "기존 요소가 포함되도록 맵 크기를 늘려주세요.";
      const current = state.floor.floorPlan;
      const floorPlan: FloorPlanDraft = current ? { ...current, width, height, gridSize } : {
        imageUrl: "", sourceType: "none", originalFileUrl: null, renderedImageUrl: null,
        width, height, gridSize, version: 1
      };
      commit({ ...state, floor: { ...state.floor, floorPlan } });
      return null;
    },
    addObject: (floorId, draft) => {
      if (get().mapScope) throw new MapEditorError("MAP_LEGACY_WRITE_FORBIDDEN", "공통 도형 편집 명령을 사용해주세요.");
      const { state, layers } = get(); if (!state || state.floor.id !== floorId || layers.objects.locked) return;
      const bounds = { width: state.floor.floorPlan?.width ?? 1200, height: state.floor.floorPlan?.height ?? 800 };
      const gridSize = state.floor.floorPlan?.gridSize ?? 10;
      const sourceRect = { x: draft.x, y: draft.y, width: draft.width, height: draft.height };
      const snapped = get().snap
        ? draft.type === "line"
          ? { ...snapRectToGrid({ ...sourceRect, height: gridSize }, gridSize), height: 0 }
          : snapRectToGrid(sourceRect, gridSize)
        : sourceRect;
      const geometry = clampObjectToMap(snapped, bounds);
      const object: FloorMapObject = {
        ...draft,
        ...geometry,
        height: draft.type === "line" ? 0 : geometry.height,
        points: draft.type === "triangle" ? trianglePointsForSize(geometry.width, geometry.height) : draft.points,
        id: `draft-${crypto.randomUUID()}`,
        floorId,
        zIndex: draft.zIndex ?? state.objects.length + 1
      };
      commit({ ...state, objects: [...state.objects, object] }, { selection: { kind: "object", id: object.id }, selectedFixtureIds: [], activeTool: "select" });
    },
    updateObject: (id, patch) => {
      if (get().mapScope) throw new MapEditorError("MAP_LEGACY_WRITE_FORBIDDEN", "공통 도형 편집 명령을 사용해주세요.");
      const { state, layers } = get(); if (!state || layers.objects.locked) return;
      const object = state.objects.find((o) => o.id === id);
      // Locked shapes can only be unlocked/hidden explicitly from the layer panel.
      if (!object || object.locked && Object.keys(patch).some((key) => key !== "locked" && key !== "visible")) return;
      let normalizedPatch = patch;
      if (["x", "y", "width", "height"].some((key) => key in patch)) {
        const bounds = { width: state.floor.floorPlan?.width ?? 1200, height: state.floor.floorPlan?.height ?? 800 };
        const gridSize = state.floor.floorPlan?.gridSize ?? 10;
        const merged = { x: patch.x ?? object.x, y: patch.y ?? object.y, width: patch.width ?? object.width, height: object.type === "line" ? 0 : patch.height ?? object.height };
        const isResize = "width" in patch || "height" in patch;
        const snapped = get().snap
          ? isResize
            ? object.type === "line"
              ? { ...snapRectToGrid({ ...merged, height: gridSize }, gridSize), height: 0 }
              : snapRectToGrid(merged, gridSize)
            : { ...merged, ...snapPointToGridWithinBounds(merged, gridSize, {
                width: Math.max(0, bounds.width - merged.width),
                height: Math.max(0, bounds.height - merged.height)
              }) }
          : merged;
        const geometry = clampObjectToMap(snapped, bounds);
        normalizedPatch = {
          ...patch,
          ...geometry,
          height: object.type === "line" ? 0 : geometry.height,
          ...(object.type === "triangle" ? { points: trianglePointsForSize(geometry.width, geometry.height) } : {})
        };
      }
      if (!Object.entries(normalizedPatch).some(([key, value]) => !Object.is(object[key as keyof FloorMapObject], value))) return;
      commit({ ...state, objects: state.objects.map((o) => o.id === id ? { ...o, ...normalizedPatch } : o) });
    },
    removeObject: (id) => {
      if (get().mapScope) throw new MapEditorError("MAP_LEGACY_WRITE_FORBIDDEN", "공통 도형 편집 명령을 사용해주세요.");
      const { state, layers } = get(); if (!state || layers.objects.locked || !state.objects.some((o) => o.id === id && !o.locked)) return;
      commit({ ...state, objects: state.objects.filter((o) => o.id !== id) }, { selection: null });
    }
  };
});
