import { create } from "zustand";
import type { EDITOR_MAX_NAME_LENGTH } from "@led-control/shared";
import { buildEditorChanges, hasEditorChanges } from "./editor-diff";
import type { EditorFixture, EditorTool, FloorEditorState, FloorMapObject, FloorMapObjectDraft, FloorPlanDraft } from "./editor-types";
import { clampObjectToMap, snapPointToGridWithinBounds, snapRectToGrid, trianglePointsForSize, type Point } from "./geometry";

type Selection = { kind: "fixture" | "object"; id: string } | null;
export type FixturePatch = Partial<Pick<EditorFixture, "name" | "ratedWatt" | "x" | "y" | "size" | "placementStatus" | "positionVerified">>;
export type PlacementPoint = Point & { id: string };
type LayerName = "background" | "objects" | "fixtures";
type LayerSettings = Record<LayerName, { visible: boolean; locked: boolean }>;
type MapSettings = { width: number; height: number; gridSize: number };
// The shared root is CommonJS, so enforce its literal limit through a type-only
// import without pulling that runtime entry into the browser editor bundle.
const maxFixtureNameLength: typeof EDITOR_MAX_NAME_LENGTH = 200;
interface HistoryEntry { state: FloorEditorState; selection: Selection; selectedFixtureIds: string[] }
const defaultLayers = (): LayerSettings => ({ background: { visible: true, locked: true }, objects: { visible: true, locked: false }, fixtures: { visible: true, locked: false } });

interface EditorStore {
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
  selectedFixtureIds: string[];
  lockedFixtureIds: string[];
  layers: LayerSettings;
  snap: boolean;
  preview: PlacementPoint[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  initialize: (state: FloorEditorState) => void;
  reset: () => void;
  adoptBaseline: (state: FloorEditorState, preserveHistory?: boolean) => void;
  recoverDraft: (state: FloorEditorState) => void;
  discardChanges: () => void;
  undo: () => void;
  redo: () => void;
  setActiveTool: (tool: EditorTool) => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: Point) => void;
  setViewport: (viewport: { width: number; height: number }) => void;
  fit: (selected?: boolean) => void;
  resetZoom: () => void;
  selectFixture: (fixtureId: string, additive?: boolean) => void;
  selectFixtures: (ids: string[], additive?: boolean) => void;
  selectObject: (objectId: string) => void;
  clearSelection: () => void;
  updateFixture: (fixtureId: string, patch: FixturePatch) => void;
  updateFixtureProperties: (ids: string[], patch: FixturePatch | ((fixture: EditorFixture, index: number) => FixturePatch)) => void;
  placeFixtures: (placements: PlacementPoint[]) => void;
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
  const dirty = (state: FloorEditorState) => {
    const baseline = get().initialState;
    if (!baseline) return { isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [] };
    const changes = buildEditorChanges(baseline, state);
    return { isDirty: hasEditorChanges(changes), dirtyFixtureIds: changes.fixtureUpdates.map((f) => f.id), dirtyObjectIds: [...changes.objectUpdates.map((o) => o.id), ...changes.objectDeletes, ...state.objects.filter((o) => o.id.startsWith("draft-")).map((o) => o.id)] };
  };
  const snapshot = (): HistoryEntry => ({ state: get().state!, selection: get().selection, selectedFixtureIds: get().selectedFixtureIds });
  const commit = (state: FloorEditorState, extra: Partial<EditorStore> = {}) => {
    if (state === get().state) return;
    set({ ...dirty(state), state, past: [...get().past.slice(-99), snapshot()], future: [], preview: [], ...extra });
  };
  const applyFixtures = (patches: Map<string, FixturePatch>, snapPositions = true) => {
    const { state, layers, lockedFixtureIds } = get();
    if (!state || layers.fixtures.locked || !layers.fixtures.visible) return;
    const locked = new Set(lockedFixtureIds);
    let changed = false;
    const fixtures = state.fixtures.map((fixture) => {
      const patch = patches.get(fixture.id);
      if (!patch || locked.has(fixture.id)) return fixture;
      const next = { ...fixture, ...patch };
      if (snapPositions && get().snap && ("x" in patch || "y" in patch)) {
        const gridSize = state.floor.floorPlan?.gridSize ?? 10;
        const point = snapPointToGridWithinBounds({ x: next.x, y: next.y }, gridSize, {
          width: state.floor.floorPlan?.width ?? 1200,
          height: state.floor.floorPlan?.height ?? 800
        });
        if ("x" in patch) next.x = point.x;
        if ("y" in patch) next.y = point.y;
      }
      // Partial edits must not normalize unrelated legacy geometry or reject
      // unchanged fields. The server validates the same narrow patch on save.
      if (("x" in patch && !Number.isFinite(next.x)) || ("y" in patch && !Number.isFinite(next.y))
        || ("ratedWatt" in patch && (!Number.isFinite(next.ratedWatt) || next.ratedWatt < 0 || next.ratedWatt > 10000))
        || ("size" in patch && (!Number.isFinite(next.size ?? 20) || (next.size ?? 20) < 4 || (next.size ?? 20) > 200))
        || ("name" in patch && (typeof next.name !== "string" || next.name.length > maxFixtureNameLength))) return fixture;
      if ("x" in patch) next.x = Math.max(0, Math.min(state.floor.floorPlan?.width ?? 1200, next.x));
      if ("y" in patch) next.y = Math.max(0, Math.min(state.floor.floorPlan?.height ?? 800, next.y));
      if (next.x !== fixture.x || next.y !== fixture.y || next.placementStatus === "unplaced") {
        next.positionVerifiedAt = null;
        if (fixture.positionVerifiedAt || fixture.positionVerified) next.positionVerified = false;
      }
      if (next.placementStatus === "unplaced") next.positionVerified = false;
      if (!Object.keys(next).some((key) => !Object.is(next[key as keyof EditorFixture], fixture[key as keyof EditorFixture]))) return fixture;
      changed = true;
      return next;
    });
    if (changed) commit({ ...state, fixtures });
  };
  return {
    initialState: null, state: null, isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [], activeTool: "select", zoom: 1,
    pan: { x: 0, y: 0 }, viewport: { width: 800, height: 600 }, selection: null, selectedFixtureIds: [],
    lockedFixtureIds: [], layers: defaultLayers(), snap: true, preview: [], past: [], future: [],
    initialize: (state) => set({ initialState: state, state, isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [], activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null, selectedFixtureIds: [], lockedFixtureIds: [], layers: defaultLayers(), preview: [], past: [], future: [], snap: true }),
    reset: () => set({ initialState: null, state: null, isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [], activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null, selectedFixtureIds: [], lockedFixtureIds: [], layers: defaultLayers(), preview: [], past: [], future: [], snap: true }),
    adoptBaseline: (state, preserveHistory = false) => set({ initialState: state, state, isDirty: false, dirtyFixtureIds: [], dirtyObjectIds: [], ...(preserveHistory ? {} : { past: [], future: [], preview: [] }) }),
    recoverDraft: (state) => { if (state.floor.id === get().initialState?.floor.id && state.floor.mapRevision === get().initialState?.floor.mapRevision) commit(state); },
    discardChanges: () => { const state = get().initialState; if (state) get().initialize(state); else set({ isDirty: false, selection: null, selectedFixtureIds: [], past: [], future: [] }); },
    undo: () => { const entry = get().past.at(-1); if (entry) set({ ...entry, ...dirty(entry.state), past: get().past.slice(0, -1), future: [...get().future, snapshot()], preview: [] }); },
    redo: () => { const entry = get().future.at(-1); if (entry) set({ ...entry, ...dirty(entry.state), past: [...get().past, snapshot()], future: get().future.slice(0, -1), preview: [] }); },
    setActiveTool: (activeTool) => set({ activeTool, ...(activeTool !== "select" ? { selection: null, selectedFixtureIds: [] } : {}) }),
    setZoom: (zoom) => set({ zoom: Math.min(Math.max(zoom, 0.1), 4) }),
    setPan: (pan) => set({ pan }),
    setViewport: (viewport) => set({ viewport }),
    resetZoom: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),
    fit: (selected = false) => {
      const { state, selectedFixtureIds, viewport } = get();
      if (!state) return;
      const ids = new Set(selectedFixtureIds);
      const fixtures = selected ? state.fixtures.filter((f) => ids.has(f.id) && f.placementStatus !== "unplaced") : [];
      if (selected && !fixtures.length) return;
      const x = fixtures.length ? Math.min(...fixtures.map((f) => f.x)) - 40 : 0;
      const y = fixtures.length ? Math.min(...fixtures.map((f) => f.y)) - 40 : 0;
      const width = fixtures.length ? Math.max(...fixtures.map((f) => f.x)) - x + 40 : state.floor.floorPlan?.width ?? 1200;
      const height = fixtures.length ? Math.max(...fixtures.map((f) => f.y)) - y + 40 : state.floor.floorPlan?.height ?? 800;
      const zoom = Math.min(2, Math.max(0.1, Math.min((viewport.width - 48) / width, (viewport.height - 48) / height)));
      set({ zoom, pan: { x: (viewport.width - width * zoom) / 2 - x * zoom, y: (viewport.height - height * zoom) / 2 - y * zoom } });
    },
    selectFixture: (id, additive = false) => {
      const ids = additive ? get().selectedFixtureIds.includes(id) ? get().selectedFixtureIds.filter((value) => value !== id) : [...get().selectedFixtureIds, id] : [id];
      get().selectFixtures(ids);
    },
    selectFixtures: (ids, additive = false) => {
      const available = new Set(get().state?.fixtures.map((f) => f.id));
      const selectedFixtureIds = [...new Set([...(additive ? get().selectedFixtureIds : []), ...ids])].filter((id) => available.has(id));
      set({ selectedFixtureIds, selection: selectedFixtureIds.length === 1 ? { kind: "fixture", id: selectedFixtureIds[0] } : null, activeTool: "select" });
    },
    selectObject: (id) => set({ selection: { kind: "object", id }, selectedFixtureIds: [], activeTool: "select" }),
    clearSelection: () => set({ selection: null, selectedFixtureIds: [] }),
    updateFixture: (id, patch) => applyFixtures(new Map([[id, patch]])),
    updateFixtureProperties: (ids, patch) => {
      const wanted = new Set(ids);
      const fixtures = get().state?.fixtures.filter((f) => wanted.has(f.id)) ?? [];
      applyFixtures(new Map(fixtures.map((f, i) => [f.id, typeof patch === "function" ? patch(f, i) : patch])));
    },
    placeFixtures: (placements) => applyFixtures(new Map(placements.map(({ id, ...point }) => [id, { ...point, placementStatus: "placed" }]))),
    unplaceFixture: (id) => { applyFixtures(new Map([[id, { placementStatus: "unplaced" }]])); if (get().state?.fixtures.find((f) => f.id === id)?.placementStatus === "unplaced") get().clearSelection(); },
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
      const width = state.floor.floorPlan?.width ?? 1200;
      const height = state.floor.floorPlan?.height ?? 800;
      let x = Math.max(-minimumX, Math.min(delta.x, width - maximumX));
      let y = Math.max(-minimumY, Math.min(delta.y, height - maximumY));
      if (get().snap) {
        const snappedAnchor = snapPointToGridWithinBounds(
          { x: minimumX + x, y: minimumY + y },
          state.floor.floorPlan?.gridSize ?? 10,
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
      if (state) commit({ ...state, floor: { ...state.floor, floorPlan: floorPlan ? { ...floorPlan, gridSize: floorPlan.gridSize ?? state.floor.floorPlan?.gridSize ?? 10 } : null } });
    },
    updateMapSettings: ({ width, height, gridSize }) => {
      const state = get().state;
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
      const { state, layers } = get(); if (!state || layers.objects.locked || !state.objects.some((o) => o.id === id && !o.locked)) return;
      commit({ ...state, objects: state.objects.filter((o) => o.id !== id) }, { selection: null });
    }
  };
});
