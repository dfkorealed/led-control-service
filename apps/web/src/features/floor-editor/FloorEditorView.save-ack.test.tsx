import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FloorEditorView } from "./FloorEditorView";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";
import { saveFloorEditorState } from "../../api/floor-editor";
import type { FloorEditorState } from "./editor-types";
import { editorDraftGeneration, editorDraftKey, loadEditorDraft, saveEditorDraft } from "./editor-drafts";

vi.mock("../map-scene/MapSceneCanvas", () => ({ MapSceneCanvas: () => <canvas /> }));
vi.mock("./CadImportSceneCanvas", () => ({ CadImportSceneCanvas: () => null, useCadImportScene: () => ({ data: undefined, isError: false, refetch: vi.fn() }) }));
vi.mock("../../api/map-document", () => ({ createMapDocumentSource: () => ({ scopeKey: "fixture", getElements: async () => [],
  getSelection: async () => ({ generationId: "gen", revision: 1, ids: [], nextCursor: null }) }) }));
vi.mock("../../api/floor-editor", async original => ({ ...await original<typeof import("../../api/floor-editor")>(),
  saveFloorEditorState: vi.fn(), getActiveFloorImportJob: async () => ({ job: null }),
  getAppliedFloorImportOverlay: async () => ({ overlay: null }), listFloorEditorRevisions: async () => ({ items: [], nextCursor: null }) }));

const base: FloorEditorState = { floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 1, floorPlan: null,
  mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 0,
    manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } }, fixtures: [], objects: [], lightSlots: [] };
const store = useFloorEditorStore.getState;
const clients: QueryClient[] = [];
function mount(userId?: string, edit = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  if (userId) client.setQueryData(["auth", "me"], { user: { id: userId, role: "admin" } });
  const onSaved = vi.fn();
  const content = (state: FloorEditorState) => <QueryClientProvider client={client}><MemoryRouter>
    <FloorEditorView initialState={state} userRole="admin" leaseToken="lease" leaseFence={1} onSaved={onSaved} onCancel={() => undefined} onReload={() => undefined} />
  </MemoryRouter></QueryClientProvider>;
  const view = render(content(structuredClone(base)));
  if (edit) act(() => {
    store().loadMapStructures(store().mapScope!, { layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }], groups: [] });
    const element = createMapElementFromDrag("ellipse", { x: 100, y: 100 }, { x: 200, y: 200 }, "shape")!;
    store().applyMapTransaction({ operations: [{ kind: "add", element }] });
    store().selectMapElements([element.id]); store().setZoom(0.6); store().setPan({ x: 75, y: -30 }); store().setSnap(false);
  });
  return { client, onSaved, rerender: (state: FloorEditorState) => view.rerender(content(state)) };
}
beforeEach(() => { store().reset(); localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });

describe("normal common save response adoption", () => {
  const warning = "이 브라우저에 초안을 보관하지 못했습니다. 서버에 저장하세요.";
  it("persists authenticated common drafts in the initialization scope and removes them after ACK", async () => {
    const view = mount("draft-user");
    const scope = `draft-user:${editorDraftGeneration()}:admin`;
    expect(store().mapScope?.authScope).toBe(scope);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    expect(loadEditorDraft(scope, base)?.commonMapDraft?.operations).toEqual(store().mapOperations);
    const saved = { ...base, floor: { ...base.floor, mapRevision: 2, mapDocument: { ...base.floor.mapDocument!, revision: 2, elementCount: 1 } } };
    vi.mocked(saveFloorEditorState).mockResolvedValue(saved);
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledWith(saved));
    expect(localStorage.getItem(editorDraftKey(scope, base))).toBeNull();
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it("loads and discards a draft under the same composite scope", async () => {
    const scope = `draft-user:${editorDraftGeneration()}:admin`;
    store().initialize(structuredClone(base), scope);
    store().loadMapStructures(store().mapScope!, { layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }], groups: [] });
    const element = createMapElementFromDrag("rectangle", { x: 10, y: 10 }, { x: 100, y: 100 }, "recovered")!;
    store().applyMapTransaction({ operations: [{ kind: "add", element }] });
    expect(saveEditorDraft(scope, base, store().state!, store().exportMapDraft())).toBe(true);
    store().reset();
    mount("draft-user", false);
    fireEvent.click(await screen.findByRole("button", { name: "초안 삭제" }));
    expect(localStorage.getItem(editorDraftKey(scope, base))).toBeNull();
  });

  it("clears a real storage failure warning when a normal save is acknowledged clean", async () => {
    const view = mount("draft-user");
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(storage).toHaveBeenCalled();
    storage.mockRestore();
    const saved = { ...base, floor: { ...base.floor, mapRevision: 2, mapDocument: { ...base.floor.mapDocument!, revision: 2, elementCount: 1 } } };
    vi.mocked(saveFloorEditorState).mockResolvedValue(saved);
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledWith(saved));
    expect(store().isDirty).toBe(false);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it("preserves history, selection, snap and camera after ACK and structurally shared query props", async () => {
    const saved: FloorEditorState = { ...base, floor: { ...base.floor, mapRevision: 2,
      mapDocument: { ...base.floor.mapDocument!, revision: 2, elementCount: 1 } } };
    vi.mocked(saveFloorEditorState).mockResolvedValue(saved);
    const view = mount();
    view.client.setQueryData(["floor-editor", "site", "floor"], structuredClone(base));
    const history = store().past, selection = store().mapSelection, scope = store().mapScope;
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledWith(saved));
    const cached = view.client.getQueryData<FloorEditorState>(["floor-editor", "site", "floor"])!;
    expect(cached).toEqual(saved); expect(cached).not.toBe(saved);
    view.rerender(cached);
    expect(store().past).toBe(history);
    expect(store().mapSelection).toEqual(selection);
    expect(store()).toMatchObject({ zoom: 0.6, pan: { x: 75, y: -30 }, snap: false, isDirty: false,
      mapScope: { ...scope, baseRevision: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    expect(store().isDirty).toBe(true);
    expect(store().mapOperations).toEqual([{ kind: "delete", id: "shape" }]);
    fireEvent.click(screen.getByRole("button", { name: "다시 실행" }));
    expect(store().isDirty).toBe(false);
  });

  it("keeps clean redo history on equivalent common refetch", () => {
    const view = mount(); act(() => store().undo());
    const future = store().future;
    view.rerender(structuredClone(base));
    expect(store().future).toBe(future);
    expect(store().zoom).toBe(0.6);
  });

  it.each(["revision", "generation", "floor"] as const)("still adopts an external %s change", change => {
    const view = mount(); act(() => store().undo());
    const next = structuredClone(base);
    if (change === "revision") { next.floor.mapRevision = 2; next.floor.mapDocument!.revision = 2; }
    if (change === "generation") next.floor.mapDocument!.generationId = "new-generation";
    if (change === "floor") next.floor.id = "other-floor";
    view.rerender(next);
    expect(store().future).toHaveLength(0);
    expect(store().initialState).toEqual(next);
  });
});
