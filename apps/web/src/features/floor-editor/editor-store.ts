import { create } from "zustand";
import type { EditorFixture, EditorTool, FloorEditorState, FloorMapObject, FloorMapObjectDraft, FloorPlanDraft } from "./editor-types";

type Selection =
  | { kind: "fixture"; id: string }
  | { kind: "object"; id: string }
  | null;

interface EditorStore {
  state: FloorEditorState | null;
  activeTool: EditorTool;
  zoom: number;
  pan: { x: number; y: number };
  selection: Selection;
  initialize: (state: FloorEditorState) => void;
  setActiveTool: (tool: EditorTool) => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  resetZoom: () => void;
  selectFixture: (fixtureId: string) => void;
  selectObject: (objectId: string) => void;
  clearSelection: () => void;
  updateFixture: (fixtureId: string, patch: Partial<Pick<EditorFixture, "name" | "ratedWatt" | "x" | "y">>) => void;
  updateFloorPlan: (floorPlan: FloorPlanDraft | null) => void;
  addObject: (floorId: string, draft: FloorMapObjectDraft) => void;
  updateObject: (objectId: string, patch: Partial<FloorMapObject>) => void;
}

export const useFloorEditorStore = create<EditorStore>((set, get) => ({
  state: null,
  activeTool: "select",
  zoom: 1,
  pan: { x: 0, y: 0 },
  selection: null,
  initialize: (state) => set({ state, activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null }),
  setActiveTool: (tool) => set({ activeTool: tool, selection: tool === "select" ? get().selection : null }),
  setZoom: (zoom) => set({ zoom: Math.min(Math.max(zoom, 0.25), 3) }),
  setPan: (pan) => set({ pan }),
  resetZoom: () => set({ zoom: 1, pan: { x: 0, y: 0 } }),
  selectFixture: (fixtureId) => set({ selection: { kind: "fixture", id: fixtureId }, activeTool: "select" }),
  selectObject: (objectId) => set({ selection: { kind: "object", id: objectId }, activeTool: "select" }),
  clearSelection: () => set({ selection: null }),
  updateFixture: (fixtureId, patch) =>
    set(({ state }) => {
      if (!state) return {};
      return {
        state: {
          ...state,
          fixtures: state.fixtures.map((fixture) => (fixture.id === fixtureId ? { ...fixture, ...patch } : fixture))
        }
      };
    }),
  updateFloorPlan: (floorPlan) =>
    set(({ state }) => {
      if (!state) return {};
      return { state: { ...state, floor: { ...state.floor, floorPlan } } };
    }),
  addObject: (floorId, draft) =>
    set(({ state }) => {
      if (!state) return {};
      const object: FloorMapObject = {
        ...draft,
        id: `draft-${Date.now()}-${state.objects.length + 1}`,
        floorId,
        zIndex: draft.zIndex ?? state.objects.length + 1
      };
      return {
        state: { ...state, objects: [...state.objects, object] },
        selection: { kind: "object", id: object.id },
        activeTool: "select"
      };
    }),
  updateObject: (objectId, patch) =>
    set(({ state }) => {
      if (!state) return {};
      return {
        state: {
          ...state,
          objects: state.objects.map((object) => (object.id === objectId ? { ...object, ...patch } : object))
        }
      };
    })
}));
