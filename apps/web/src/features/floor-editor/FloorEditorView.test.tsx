import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { FloorEditorView } from "./FloorEditorView";
import type { FloorEditorState } from "./editor-types";
import { useFloorEditorStore } from "./editor-store";

const floorEditorApi = vi.hoisted(() => ({
  listFloorEditorRevisions: vi.fn(),
  restoreFloorEditorRevision: vi.fn(),
  saveFloorEditorState: vi.fn()
}));

vi.mock("../../api/floor-editor", () => floorEditorApi);

const editorState: FloorEditorState = {
  floor: {
    id: "floor-b2",
    siteId: "site-2",
    name: "B2",
    level: -2,
    mapRevision: 7,
    floorPlan: {
      imageUrl: "/demo/floor-b2.svg",
      sourceType: "image",
      originalFileUrl: "/demo/floor-b2.svg",
      renderedImageUrl: "/demo/floor-b2.svg",
      width: 1200,
      height: 800,
      version: 1
    }
  },
  fixtures: [
    {
      id: "fixture-1",
      name: "B2-L01",
      x: 120,
      y: 140,
      ratedWatt: 40,
      brightness: 70,
      status: "online"
    }
  ],
  objects: [
    {
      id: "object-1",
      floorId: "floor-b2",
      type: "text",
      x: 300,
      y: 180,
      width: 120,
      height: 40,
      points: null,
      rotation: 0,
      strokeColor: "#111827",
      fillColor: "transparent",
      strokeWidth: 1,
      text: "출입구",
      fontSize: 18,
      zIndex: 1,
      locked: false,
      visible: true
    }
  ]
};

function renderEditor(state: FloorEditorState = editorState, props?: Partial<Parameters<typeof FloorEditorView>[0]>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <FloorEditorView initialState={state} userRole="admin" onCancel={vi.fn()} onSaved={vi.fn()} onReload={vi.fn()} {...props} />
    </QueryClientProvider>
  );
  return { ...result, queryClient };
}

describe("FloorEditorView", () => {
  beforeEach(() => {
    floorEditorApi.saveFloorEditorState.mockImplementation(async (_floorId, _payload) => ({
      ...structuredClone(editorState),
      floor: { ...structuredClone(editorState.floor), mapRevision: 8 }
    }));
    floorEditorApi.listFloorEditorRevisions.mockResolvedValue({ items: [], nextCursor: null });
    floorEditorApi.restoreFloorEditorRevision.mockResolvedValue({
      ...structuredClone(editorState),
      floor: { ...structuredClone(editorState.floor), mapRevision: 8 },
      skippedFixtureIds: []
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useFloorEditorStore.setState({ initialState: null, state: null, isDirty: false, activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null });
  });

  it("renders toolbar canvas properties save and cancel controls", () => {
    renderEditor();

    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "확대" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "축소" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "취소" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "도면 편집 도구" })).toBeInTheDocument();
    expect(screen.getByLabelText("B2 편집 캔버스")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "속성 패널" })).toBeInTheDocument();
  });

  it("calls cancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    renderEditor(editorState, { onCancel });

    fireEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("edits selected fixture properties and saves changed state", async () => {
    const onSaved = vi.fn();
    renderEditor(editorState, { onSaved });

    act(() => useFloorEditorStore.getState().selectFixture("fixture-1"));
    fireEvent.change(screen.getByLabelText("조명명"), { target: { value: "B2-L01 수정" } });
    fireEvent.change(screen.getByLabelText("정격 전력"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledWith("floor-b2", {
      expectedRevision: 7,
      fixtureUpdates: [{ id: "fixture-1", name: "B2-L01 수정", ratedWatt: 45 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    });
    expect(onSaved.mock.calls[0][0].floor.mapRevision).toBe(8);
    expect(useFloorEditorStore.getState()).toMatchObject({ isDirty: false });
  });

  it("creates a rectangle after selecting the toolbar and dragging on the Konva canvas", async () => {
    renderEditor({ ...editorState, objects: [] });

    fireEvent.click(screen.getByRole("button", { name: "사각형" }));
    const canvas = screen.getByLabelText("B2 편집 캔버스");
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 160 });
    fireEvent.mouseMove(canvas, { clientX: 320, clientY: 240 });
    fireEvent.mouseUp(canvas, { clientX: 320, clientY: 240 });

    const objects = useFloorEditorStore.getState().state?.objects ?? [];
    expect(objects[0]).toMatchObject({ type: "rectangle", x: 200, y: 160, width: 120, height: 80 });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledOnce());
    expect(floorEditorApi.saveFloorEditorState.mock.calls[0][1].objectCreates).toEqual([
      expect.objectContaining({ type: "rectangle", x: 200, y: 160, width: 120, height: 80, locked: false, visible: true })
    ]);
  });

  it("creates a rectangle by dragging the toolbar tool and dropping it on the canvas", async () => {
    renderEditor({ ...editorState, objects: [] });

    const dataTransfer = createDataTransfer();
    const canvas = screen.getByLabelText("B2 편집 캔버스");
    fireEvent.dragStart(screen.getByRole("button", { name: "사각형" }), { dataTransfer });
    fireEvent.dragOver(canvas, { dataTransfer });
    fireEvent(canvas, createDragEventWithPoint(canvas, "drop", dataTransfer, 240, 180));

    expect(screen.getAllByText("rectangle").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledOnce());
    expect(floorEditorApi.saveFloorEditorState.mock.calls[0][1].objectCreates).toEqual([
      expect.objectContaining({ type: "rectangle", x: 240, y: 180, width: 160, height: 96 })
    ]);
  });

  it("does not create an object when a tool is selected and the canvas is only clicked", () => {
    renderEditor({ ...editorState, objects: [] });

    fireEvent.click(screen.getByRole("button", { name: "사각형" }));
    const canvas = screen.getByLabelText("B2 편집 캔버스");
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 160 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 160 });

    expect(screen.queryByText("rectangle")).not.toBeInTheDocument();
  });

  it("creates a selected tool object when dragging on the Konva canvas", () => {
    renderEditor({ ...editorState, objects: [] });

    fireEvent.click(screen.getByRole("button", { name: "삼각형" }));
    const canvas = screen.getByLabelText("B2 편집 캔버스");
    fireEvent.mouseDown(canvas, { clientX: 240, clientY: 180 });
    fireEvent.mouseMove(canvas, { clientX: 340, clientY: 260 });
    fireEvent.mouseUp(canvas, { clientX: 340, clientY: 260 });

    expect(useFloorEditorStore.getState().state?.objects[0]).toMatchObject({ type: "triangle", x: 240, y: 180, width: 100, height: 80 });
  });

  it("saves a moved map object from editor state", async () => {
    renderEditor();

    act(() => useFloorEditorStore.getState().updateObject("object-1", { x: 360, y: 230 }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledWith(
      "floor-b2",
      expect.objectContaining({ objectUpdates: [{ id: "object-1", patch: { x: 360, y: 230 } }] })
    ));
  });

  it("saves a resized map object from editor state", async () => {
    renderEditor();

    act(() => useFloorEditorStore.getState().updateObject("object-1", { width: 180, height: 80 }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledWith(
      "floor-b2",
      expect.objectContaining({ objectUpdates: [{ id: "object-1", patch: { width: 180, height: 80 } }] })
    ));
  });

  it("uses a color palette input for object fill color", () => {
    renderEditor();

    act(() => useFloorEditorStore.getState().selectObject("object-1"));

    expect(screen.getByLabelText("채우기 색상")).toHaveAttribute("type", "color");
  });

  it("saves fixture size changes for Konva transformer resizing", async () => {
    renderEditor();

    act(() => useFloorEditorStore.getState().selectFixture("fixture-1"));
    fireEvent.change(screen.getByLabelText("크기"), { target: { value: "36" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledWith(
      "floor-b2",
      expect.objectContaining({ fixtureUpdates: [{ id: "fixture-1", size: 36 }] })
    ));
  });

  it("pans the canvas when the pan tool is dragged", () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "이동" }));
    fireEvent.mouseDown(screen.getByLabelText("B2 편집 캔버스"), { clientX: 100, clientY: 120 });
    fireEvent.mouseMove(screen.getByLabelText("B2 편집 캔버스"), { clientX: 130, clientY: 150 });

    expect(useFloorEditorStore.getState().pan).toEqual({ x: 30, y: 30 });
  });

  it("does not submit an unchanged state", async () => {
    renderEditor();

    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(floorEditorApi.saveFloorEditorState).not.toHaveBeenCalled();
  });

  it("keeps current edits and dirty state after a network failure", async () => {
    floorEditorApi.saveFloorEditorState.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderEditor();
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 222 }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("저장하지 못했습니다");
    expect(useFloorEditorStore.getState().state?.fixtures[0].x).toBe(222);
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
  });

  it("offers reload only after a 409 conflict", async () => {
    const onReload = vi.fn();
    floorEditorApi.saveFloorEditorState.mockRejectedValueOnce(
      new ApiError("PUT failed", 409, { message: "revision conflict" })
    );
    renderEditor(editorState, { onReload });
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 223 }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("다른 사용자가 먼저 저장했습니다");
    expect(screen.queryByRole("button", { name: /강제/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "최신 버전 다시 불러오기" }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
  });

  it("invalidates site and floor scoped queries after atomic save", async () => {
    const { queryClient } = renderEditor();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 224 }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", "site-2"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-editor", "site-2", "floor-b2"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-editor-revisions", "site-2", "floor-b2"] });
  });

  it("paginates revisions and displays actor time and total changes", async () => {
    floorEditorApi.listFloorEditorRevisions
      .mockResolvedValueOnce({
        items: [{
          revision: 7,
          snapshotSha256: "hash-7",
          changeSummary: { fixtureUpdates: 1, objectCreates: 2 },
          restoredFromRevision: null,
          createdAt: "2026-07-22T03:00:00.000Z",
          actor: { displayName: "김관리" }
        }],
        nextCursor: 7
      })
      .mockResolvedValueOnce({
        items: [{
          revision: 6,
          snapshotSha256: "hash-6",
          changeSummary: { objectDeletes: 1 },
          restoredFromRevision: null,
          createdAt: "2026-07-21T03:00:00.000Z",
          actor: { displayName: "서비스 운영자" }
        }],
        nextCursor: null
      });
    renderEditor();

    expect(await screen.findByText("김관리")).toBeInTheDocument();
    expect(screen.getByText("변경 3건")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이전 버전 더 보기" }));

    expect(await screen.findByText("서비스 운영자")).toBeInTheDocument();
    expect(floorEditorApi.listFloorEditorRevisions).toHaveBeenLastCalledWith("floor-b2", { cursor: 7 });
  });

  it("restores with the current baseline revision and adopts the response", async () => {
    floorEditorApi.listFloorEditorRevisions.mockResolvedValueOnce({
      items: [{
        revision: 5,
        snapshotSha256: "hash-5",
        changeSummary: { fixtureUpdates: 1 },
        restoredFromRevision: null,
        createdAt: "2026-07-20T03:00:00.000Z",
        actor: { displayName: "김관리" }
      }],
      nextCursor: null
    });
    renderEditor();

    fireEvent.click(await screen.findByRole("button", { name: "리비전 5 복구" }));

    await waitFor(() => expect(floorEditorApi.restoreFloorEditorRevision).toHaveBeenCalledWith(
      "floor-b2",
      5,
      { expectedRevision: 7 }
    ));
    expect(useFloorEditorStore.getState()).toMatchObject({ isDirty: false });
    expect(useFloorEditorStore.getState().initialState?.floor.mapRevision).toBe(8);
  });

  it("does not render restore controls for a viewer", async () => {
    floorEditorApi.listFloorEditorRevisions.mockResolvedValueOnce({
      items: [{
        revision: 5,
        snapshotSha256: "hash-5",
        changeSummary: {},
        restoredFromRevision: null,
        createdAt: "2026-07-20T03:00:00.000Z",
        actor: { displayName: "김관리" }
      }],
      nextCursor: null
    });

    renderEditor(editorState, { userRole: "viewer" });

    expect(await screen.findByText("김관리")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /복구/ })).not.toBeInTheDocument();
  });
});

function createDataTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn((type: string, value: string) => values.set(type, value)),
    getData: vi.fn((type: string) => values.get(type) ?? ""),
    clearData: vi.fn((type?: string) => {
      if (type) {
        values.delete(type);
      } else {
        values.clear();
      }
    })
  };
}

function createDragEventWithPoint(
  element: Element,
  eventName: "drop",
  dataTransfer: ReturnType<typeof createDataTransfer>,
  clientX: number,
  clientY: number
) {
  const event = createEvent[eventName](element, { dataTransfer });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}
