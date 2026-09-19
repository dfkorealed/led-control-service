import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { FloorEditorRoute } from "./FloorEditorRoute";
import { useFloorEditorStore } from "../../floor-editor/editor-store";
import { createMapElementFromDrag } from "../../floor-editor/map-element-tools";
import { mapStageClient } from "../../../api/map-stages";
import { ApiError } from "../../../api/client";
import { saveFloorEditorState } from "../../../api/floor-editor";
import type { FloorEditorState } from "../../floor-editor/editor-types";

vi.mock("../../map-scene/MapSceneCanvas", () => ({ MapSceneCanvas: () => <canvas /> }));
vi.mock("../../floor-editor/CadImportSceneCanvas", () => ({ useCadImportScene: () => ({ data: undefined, isError: false, refetch: vi.fn() }) }));
vi.mock("../../../api/queries", () => ({ useDashboard: () => ({ data: { floors: [{ id: "floor", name: "F" }] } }) }));
vi.mock("../../../api/map-document", () => ({ createMapDocumentSource: () => ({ scopeKey: "fixture", getElements: async () => [],
  getSelection: async () => ({ generationId: "gen", revision: 1, ids: [], nextCursor: null }) }) }));
vi.mock("../../../api/floor-editor", async original => ({ ...await original<typeof import("../../../api/floor-editor")>(),
  getFloorEditorState: async () => serverState, saveFloorEditorState: vi.fn(),
  acquireFloorEditorLease: async () => ({ editable: true, token: "lease", fence: 1 }), releaseFloorEditorLease: async () => ({ released: true }),
  getActiveFloorImportJob: async () => ({ job: null }), getAppliedFloorImportOverlay: async () => ({ overlay: null }),
  listFloorEditorRevisions: async () => ({ items: [], nextCursor: null }) }));
const store = useFloorEditorStore.getState;
const ref = { formatVersion: 1 as const, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 0,
  manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
const initial: FloorEditorState = { floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 1, floorPlan: null, mapDocument: ref },
  fixtures: [{ id: "fixture", name: "before", x: 400, y: 400, ratedWatt: 40, brightness: 100, status: "online" }], objects: [], lightSlots: [] };
let client: QueryClient, serverState: FloorEditorState;
beforeEach(() => { store().reset(); localStorage.clear(); serverState = structuredClone(initial); });
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });

it.each(["save", "cancel receipt"])("keeps leave/unload guards after stage %s while the post-preview draft remains", async mode => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["auth", "me"], { user: { id: "user", role: "admin" } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/settings/floor-plans/floor/edit?siteId=site"]}><Routes>
    <Route path="/settings/floor-plans/:floorId/edit" element={<FloorEditorRoute capabilities={{ read: true, control: true, manage: true, commission: true }} />} />
    <Route path="/settings/floor-plans" element={<h1>Left editor</h1>} />
  </Routes></MemoryRouter></QueryClientProvider>);
  await screen.findByRole("heading", { name: "F 맵 편집" });
  await waitFor(() => expect(store().mapScope).not.toBeNull());
  const preview = { ...ref, generationId: "preview", revision: 2, elementCount: 1 };
  const saved = { ...initial, floor: { ...initial.floor, mapRevision: 2, mapDocument: preview }, history: { undo: { revision: 1 }, redo: { revision: 2 } } };
  const ready = { id: "stage", status: "ready" as const, generationId: "gen", baseRevision: 1, partCount: 1, decodedBytes: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(), errorCode: null, result: null, preview, intent: { leaseToken: "lease", leaseFence: 1 } };
  vi.spyOn(mapStageClient, "prepare").mockResolvedValue(ready);
  vi.spyOn(mapStageClient, "commit").mockImplementation(async () => {
    serverState = saved;
    if (mode === "cancel receipt") throw new ApiError("lost response", 503, null);
    return { ...ready, status: "committed", result: saved };
  });
  vi.spyOn(mapStageClient, "cancel").mockResolvedValue({ ...ready, status: "committed", result: saved });
  await act(async () => { await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {
    yield { kind: "add" as const, element: createMapElementFromDrag("rectangle", { x: 20, y: 20 }, { x: 40, y: 40 }, "shape")! };
  } }, { leaseToken: "lease", leaseFence: 1 }); });
  act(() => store().updateFixture("fixture", { name: "unsaved-after-preview" }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  if (mode === "cancel receipt") {
    const cancel = screen.getByRole("button", { name: "대량 편집 취소" });
    await waitFor(() => expect(cancel).toBeEnabled()); fireEvent.click(cancel);
  }
  await waitFor(() => expect(client.getQueryData<FloorEditorState>(["floor-editor", "site", "floor"])?.floor.mapRevision).toBe(2));
  expect(store().isDirty).toBe(true);
  expect(store().state!.fixtures[0].name).toBe("unsaved-after-preview");
  expect(store().initialState!.fixtures[0].name).toBe("before");
  const unload = new Event("beforeunload", { cancelable: true });
  act(() => window.dispatchEvent(unload));
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  const dialog = await screen.findByRole("alertdialog", { name: "맵 편집 종료" });
  expect(screen.queryByText("Left editor")).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  vi.mocked(saveFloorEditorState).mockImplementation(async () => {
    serverState = { ...store().state!, floor: { ...store().state!.floor, mapRevision: 3, mapDocument: { ...preview, revision: 3 } } };
    return serverState;
  });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(store().isDirty).toBe(false));
  const cleanUnload = new Event("beforeunload", { cancelable: true });
  act(() => window.dispatchEvent(cleanUnload)); expect(cleanUnload.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  await screen.findByText("Left editor");
});
