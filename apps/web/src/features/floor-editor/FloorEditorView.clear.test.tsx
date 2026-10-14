import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SessionStatusProvider, ToastRegion } from "../../components/ui";
import { getFloorEditorState } from "../../api/floor-editor";
import { clearFloorEditorDocument } from "../../api/floor-editor-reset";
import { ApiError } from "../../api/client";
import { FloorEditorView } from "./FloorEditorView";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";
import { editorDraftGeneration, clearEditorDrafts } from "./editor-drafts";
import type { FloorEditorState } from "./editor-types";

vi.mock("../map-scene/MapSceneCanvas", () => ({ MapSceneCanvas: () => <canvas /> }));
vi.mock("../../api/map-document", () => ({ createMapDocumentSource: () => ({ scopeKey: "fixture", getElements: async () => [],
  getSelection: async () => ({ generationId: "gen", revision: 1, ids: [], nextCursor: null }) }) }));
vi.mock("../../api/floor-editor-reset", async original => ({ ...await original<typeof import("../../api/floor-editor-reset")>(), clearFloorEditorDocument: vi.fn() }));
vi.mock("../../api/floor-editor", async original => ({ ...await original<typeof import("../../api/floor-editor")>(), getFloorEditorState: vi.fn(),
  getActiveFloorImportJob: async () => ({ job: null }), getAppliedFloorImportOverlay: async () => ({ overlay: null }),
  listFloorEditorRevisions: async () => ({ items: [], nextCursor: null }) }));

const base: FloorEditorState = { floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 1, floorPlan: null,
  mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 2,
    manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } }, fixtures: [], objects: [], lightSlots: [] };
const cleared: FloorEditorState = { ...base, floor: { ...base.floor, mapRevision: 2,
  mapDocument: { ...base.floor.mapDocument!, generationId: "clear-gen", revision: 2, elementCount: 0 } } };
const store = useFloorEditorStore.getState;
const clients: QueryClient[] = [];
function mount(options: { readOnly?: boolean; userRole?: "admin" | "viewer"; leaseToken?: string; initial?: FloorEditorState } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  client.setQueryData(["auth", "me"], { user: { id: "clear-user", role: "admin" } });
  const onSaved = vi.fn(), onDirtyChange = vi.fn();
  const content = (initial: FloorEditorState, readOnly = options.readOnly) => <QueryClientProvider client={client}><SessionStatusProvider><ToastRegion /><MemoryRouter>
    <FloorEditorView initialState={initial} userRole={options.userRole ?? "admin"} readOnly={readOnly}
      leaseToken={options.leaseToken ?? "lease"} leaseFence={1} onSaved={onSaved} onDirtyChange={onDirtyChange} onCancel={() => undefined} onReload={() => undefined} />
  </MemoryRouter></SessionStatusProvider></QueryClientProvider>;
  const view = render(content(structuredClone(options.initial ?? base)));
  return { ...view, onSaved, onDirtyChange, client, change: (initial: FloorEditorState, readOnly?: boolean) => view.rerender(content(initial, readOnly)) };
}
function open() { fireEvent.click(screen.getByRole("button", { name: "맵 초기화" })); return screen.getByRole("dialog", { name: "맵 초기화" }); }
function run() { fireEvent.click(screen.getByRole("button", { name: "초기화 실행" })); }
function dirty() { act(() => {
  store().loadMapStructures(store().mapScope!, { layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }], groups: [] });
  store().applyMapTransaction({ operations: [{ kind: "add", element: createMapElementFromDrag("rectangle", { x: 10, y: 10 }, { x: 40, y: 40 }, "draft")! }] });
}); }
beforeEach(() => { store().reset(); localStorage.clear(); vi.resetAllMocks();
  vi.mocked(clearFloorEditorDocument).mockResolvedValue(cleared.floor.mapDocument!);
  vi.mocked(getFloorEditorState).mockResolvedValue(cleared);
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe("map clear command", () => {
  it.each(["elements_only", "elements_and_placement"] as const)("confirms %s, discards drafts only after exact authoritative ACK and binds current draft scope", async mode => {
    const view = mount(); dirty();
    const dialog = open();
    expect(within(dialog).getByRole("radio", { name: "요소만 초기화" })).toBeChecked();
    expect(dialog).toHaveTextContent("저장하지 않은 변경사항은 폐기");
    expect(dialog).toHaveTextContent("등록 조명과 제어 설정은 유지");
    if (mode === "elements_and_placement") fireEvent.click(within(dialog).getByRole("radio", { name: "요소와 조명 배치 초기화" }));
    run();
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledWith(cleared));
    expect(clearFloorEditorDocument).toHaveBeenCalledWith("floor", expect.objectContaining({ mode, baseRevision: 1, leaseToken: "lease", leaseFence: 1, requestId: expect.any(String) }));
    expect(getFloorEditorState).toHaveBeenCalledWith("floor");
    expect(store().isDirty).toBe(false); expect(store().past).toHaveLength(0);
    expect(store().mapScope?.authScope).toBe(`clear-user:${editorDraftGeneration()}:admin`);
    expect(view.client.getQueryData<FloorEditorState>(["floor-editor", "site", "floor"])?.floor.mapRevision).toBe(2);
    expect(await screen.findByText("맵을 초기화했습니다.")).toBeInTheDocument();
  });
  it("cancels with no API call or draft changes", () => {
    mount(); dirty(); const state = store().state, operations = store().mapOperations;
    fireEvent.click(within(open()).getByRole("button", { name: "취소" }));
    expect(store().state).toBe(state); expect(store().mapOperations).toBe(operations);
    expect(clearFloorEditorDocument).not.toHaveBeenCalled(); expect(getFloorEditorState).not.toHaveBeenCalled();
  });
  it("accepts an identical document ref regardless of JSON property order", async () => {
    const view = mount();
    const { manifest, ...ref } = cleared.floor.mapDocument!;
    vi.mocked(getFloorEditorState).mockResolvedValue({ ...cleared, floor: { ...cleared.floor, mapDocument: { manifest, ...ref } } });
    open(); run(); await waitFor(() => expect(view.onSaved).toHaveBeenCalled());
  });
  it("does not publish or notify a later generation after invalidation", async () => {
    const view = mount();
    vi.spyOn(view.client, "invalidateQueries").mockImplementation(async () => {
      const next = structuredClone(cleared); next.floor.mapDocument!.generationId = "external-change";
      store().initialize(next, store().mapScope!.authScope);
    });
    open(); run(); await waitFor(() => expect(store().initialState?.floor.mapDocument?.generationId).toBe("external-change"));
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText("맵을 초기화했습니다.")).not.toBeInTheDocument();
  });
  it("protects departure for a clean map while clear is pending", async () => {
    const view = mount(); let resolve!: (state: typeof cleared.floor.mapDocument) => void;
    vi.mocked(clearFloorEditorDocument).mockReturnValueOnce(new Promise(done => { resolve = done; }) as never);
    open(); run(); expect(view.onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => resolve(cleared.floor.mapDocument));
    await waitFor(() => expect(view.onDirtyChange).toHaveBeenLastCalledWith(false));
  });
  it("locks navigation and commands while pending and reuses the original command after network error", async () => {
    const view = mount(); dirty();
    let reject!: (error: Error) => void;
    vi.mocked(clearFloorEditorDocument).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    open(); run();
    expect(screen.getByRole("button", { name: "저장", hidden: true })).toBeDisabled();
    expect(screen.getByRole("button", { name: "CAD 가져오기", hidden: true })).toBeDisabled();
    expect(view.onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => reject(new TypeError("network")));
    await screen.findAllByText(/맵 초기화 결과를 확인하지 못했습니다/);
    expect(store().isDirty).toBe(true); expect(view.onSaved).not.toHaveBeenCalled();
    expect(getFloorEditorState).toHaveBeenCalledTimes(1);
    run(); await waitFor(() => expect(view.onSaved).toHaveBeenCalledWith(cleared));
    expect(vi.mocked(clearFloorEditorDocument).mock.calls[0][1]).toEqual(vi.mocked(clearFloorEditorDocument).mock.calls[1][1]);
    expect(getFloorEditorState).toHaveBeenCalledTimes(2);
  });
  it("uses a new request id for a different mode and still checks server state", async () => {
    mount(); vi.mocked(clearFloorEditorDocument).mockRejectedValueOnce(new TypeError("network"));
    open(); run(); await screen.findAllByText(/맵 초기화 결과를 확인하지 못했습니다/);
    fireEvent.click(screen.getByRole("radio", { name: "요소와 조명 배치 초기화" })); run();
    await screen.findByText("맵을 초기화했습니다.");
    const calls = vi.mocked(clearFloorEditorDocument).mock.calls;
    expect(calls[0][1].requestId).not.toBe(calls[1][1].requestId);
    expect(getFloorEditorState).toHaveBeenCalledTimes(2);
  });
  it.each(["floor", "site", "generation", "revision", "ref"])("rejects mismatched authoritative %s", async mismatch => {
    const view = mount(); dirty(); const wrong = structuredClone(cleared);
    if (mismatch === "floor") wrong.floor.id = "other";
    if (mismatch === "site") wrong.floor.siteId = "other";
    if (mismatch === "generation") wrong.floor.mapDocument!.generationId = "other";
    if (mismatch === "revision") wrong.floor.mapRevision = 4;
    if (mismatch === "ref") wrong.floor.mapDocument!.manifest.assetId = "other";
    vi.mocked(getFloorEditorState).mockResolvedValue(wrong);
    open(); run(); await screen.findAllByText(/맵 초기화 결과를 확인하지 못했습니다/);
    expect(view.onSaved).not.toHaveBeenCalled(); expect(store().isDirty).toBe(true);
  });
  it.each(["floor", "generation", "purge", "readOnly", "unmount"])("ignores late %s session response", async change => {
    const view = mount(); let resolve!: (state: FloorEditorState) => void;
    vi.mocked(getFloorEditorState).mockReturnValue(new Promise(done => { resolve = done; }));
    open(); run(); await waitFor(() => expect(getFloorEditorState).toHaveBeenCalled());
    const next = structuredClone(base);
    if (change === "floor") { next.floor.id = "other"; view.change(next); }
    if (change === "generation") { next.floor.mapDocument!.generationId = "other"; act(() => store().initialize(next, store().mapScope!.authScope)); }
    if (change === "purge") act(() => clearEditorDrafts());
    if (change === "readOnly") view.change(next, true);
    if (change === "unmount") view.unmount();
    await act(async () => resolve(cleared));
    expect(view.onSaved).not.toHaveBeenCalled();
    expect(store().initialState?.floor.mapDocument?.generationId).not.toBe("clear-gen");
  });
  it.each([403, 409])("preserves draft on server %s and checks authoritative state", async status => {
    const view = mount(); dirty(); vi.mocked(clearFloorEditorDocument).mockRejectedValue(new ApiError("blocked", status, null));
    open(); run(); await screen.findAllByText(/맵 초기화 결과를 확인하지 못했습니다/);
    expect(getFloorEditorState).toHaveBeenCalledWith("floor"); expect(store().isDirty).toBe(true); expect(view.onSaved).not.toHaveBeenCalled();
  });
  it.each([{ readOnly: true }, { userRole: "viewer" as const }, { leaseToken: "" }, { initial: { ...base, floor: { ...base.floor, mapDocument: undefined } } }])("disables unauthorized or legacy clear %j", options => {
    mount(options); expect(screen.getByRole("button", { name: "맵 초기화" })).toBeDisabled();
    expect(clearFloorEditorDocument).not.toHaveBeenCalled();
  });
});
