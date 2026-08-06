import { create } from "zustand";
import { buildEditorChanges, hasEditorChanges } from "./editor-diff";
import type { EditorFixture, EditorTool, FloorEditorState, FloorMapObject, FloorMapObjectDraft, FloorPlanDraft } from "./editor-types";

type Selection =
  | { kind: "fixture"; id: string }
  | { kind: "object"; id: string }
  | null;

interface EditorStore {
  initialState: FloorEditorState | null;
  state: FloorEditorState | null;
  isDirty: boolean;
  activeTool: EditorTool;
  zoom: number;
  pan: { x: number; y: number };
  selection: Selection;
  initialize: (state: FloorEditorState) => void;
  adoptBaseline: (state: FloorEditorState) => void;
  setActiveTool: (tool: EditorTool) => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  resetZoom: () => void;
  selectFixture: (fixtureId: string) => void;
  selectObject: (objectId: string) => void;
  clearSelection: () => void;
  updateFixture: (fixtureId: string, patch: Partial<Pick<EditorFixture, "name" | "ratedWatt" | "x" | "y" | "size">>) => void;
  updateFloorPlan: (floorPlan: FloorPlanDraft | null) => void;
  addObject: (floorId: string, draft: FloorMapObjectDraft) => void;
  updateObject: (objectId: string, patch: Partial<FloorMapObject>) => void;
  removeObject: (objectId: string) => void;
}

export const useFloorEditorStore = create<EditorStore>((set, get) => ({
  initialState: null,
  state: null,
  isDirty: false,
  activeTool: "select",
  zoom: 1,
  pan: { x: 0, y: 0 },
  selection: null,
  initialize: (state) => set({ initialState: state, state, isDirty: false, activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null }),
  adoptBaseline: (state) => set({ initialState: state, state, isDirty: false, selection: null }),
  setActiveTool: (tool) => set({ activeTool: tool, selection: tool === "select" ? get().selection : null }),
  setZoom: (zoom) => set({ zoom: Math.min(Math.max(zoom, 0.25), 3) }),
  setPan: (pan) => set({ pan }),
  resetZoom: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),
  selectFixture: (fixtureId) => set({ selection: { kind: "fixture", id: fixtureId }, activeTool: "select" }),
  selectObject: (objectId) => set({ selection: { kind: "object", id: objectId }, activeTool: "select" }),
  clearSelection: () => set({ selection: null }),
  updateFixture: (fixtureId, patch) =>
    set(({ initialState, state }) => {
      if (!state) return {};
      const fixture = state.fixtures.find((candidate) => candidate.id === fixtureId);
      if (!fixture || !hasPatchChange(fixture, patch)) return {};
      const nextState = {
        ...state,
        fixtures: state.fixtures.map((candidate) => candidate.id === fixtureId ? { ...candidate, ...patch } : candidate)
      };
      return {
        state: nextState,
        isDirty: stateIsDirty(initialState, nextState)
      };
    }),
  updateFloorPlan: (floorPlan) =>
    set(({ initialState, state }) => {
      if (!state) return {};
      const nextState = { ...state, floor: { ...state.floor, floorPlan } };
      return { state: nextState, isDirty: stateIsDirty(initialState, nextState) };
    }),
  addObject: (floorId, draft) =>
    set(({ initialState, state }) => {
      if (!state) return {};
      const object: FloorMapObject = {
        ...draft,
        id: `draft-${crypto.randomUUID()}`,
        floorId,
        zIndex: draft.zIndex ?? state.objects.length + 1
      };
      return {
        state: { ...state, objects: [...state.objects, object] },
        isDirty: stateIsDirty(initialState, { ...state, objects: [...state.objects, object] }),
        selection: { kind: "object", id: object.id },
        activeTool: "select"
      };
    }),
  updateObject: (objectId, patch) =>
    set(({ initialState, state }) => {
      if (!state) return {};
      const object = state.objects.find((candidate) => candidate.id === objectId);
      if (!object || !hasPatchChange(object, patch)) return {};
      const nextState = {
        ...state,
        objects: state.objects.map((candidate) => candidate.id === objectId ? { ...candidate, ...patch } : candidate)
      };
      return {
        state: nextState,
        isDirty: stateIsDirty(initialState, nextState)
      };
    }),
  removeObject: (objectId) =>
    set(({ initialState, state, selection }) => {
      if (!state || !state.objects.some((object) => object.id === objectId)) return {};
      const nextState = { ...state, objects: state.objects.filter((object) => object.id !== objectId) };
      return {
        state: nextState,
        isDirty: stateIsDirty(initialState, nextState),
        selection: selection?.kind === "object" && selection.id === objectId ? null : selection
      };
    })
}));

function hasPatchChange<T extends object>(value: T, patch: Partial<T>) {
  return Object.entries(patch).some(([key, next]) => !Object.is(value[key as keyof T], next));
}

function stateIsDirty(initialState: FloorEditorState | null, state: FloorEditorState) {
  return initialState ? hasEditorChanges(buildEditorChanges(initialState, state)) : false;
}
