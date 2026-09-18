import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { FloorEditorView } from "./FloorEditorView";
import type { FloorEditorState, FloorImportApplyResult } from "./editor-types";
import { useFloorEditorStore } from "./editor-store";
import { saveEditorDraft } from "./editor-drafts";
import { clearTenantCache } from "../../api/principal-cache";
import * as spatialIndex from "./editor-spatial-index";

const floorEditorApi = vi.hoisted(() => ({
  applyFloorImportJob: vi.fn(),
  cancelFloorImportJob: vi.fn(),
  createFloorImportJob: vi.fn(),
  getActiveFloorImportJob: vi.fn(),
  getAppliedFloorImportOverlay: vi.fn(),
  getFloorEditorState: vi.fn(),
  getFloorImportJob: vi.fn(),
  listFloorImportCandidates: vi.fn(),
  listFloorEditorRevisions: vi.fn(),
  restoreFloorEditorRevision: vi.fn(),
  saveFloorEditorState: vi.fn(),
  uploadFloorAsset: vi.fn()
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
  lightSlots: [{ id: "slot-1", x: 120, y: 140, rotation: 0, assignedFixtureId: "fixture-1" }],
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

function renderEditor(state: FloorEditorState = editorState, props?: Partial<Parameters<typeof FloorEditorView>[0]>, userId?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (userId) queryClient.setQueryData(["auth", "me"], { user: { id: userId } });
  const editorProps = {
    userRole: "admin" as const,
    leaseToken: "lease-token",
    leaseFence: 7,
    onCancel: vi.fn(),
    onSaved: vi.fn(),
    onReload: vi.fn(),
    ...props
  };
  const result = render(
    <QueryClientProvider client={queryClient}>
      <FloorEditorView initialState={state} {...editorProps} />
    </QueryClientProvider>
  );
  return {
    ...result,
    queryClient,
    rerenderWithProps: (nextProps: Partial<Parameters<typeof FloorEditorView>[0]>) => result.rerender(
      <QueryClientProvider client={queryClient}>
        <FloorEditorView initialState={state} {...editorProps} {...nextProps} />
      </QueryClientProvider>
    ),
    rerenderEditor: (nextState: FloorEditorState) => result.rerender(
      <QueryClientProvider client={queryClient}>
        <FloorEditorView initialState={nextState} {...editorProps} />
      </QueryClientProvider>
    )
  };
}

describe("FloorEditorView", () => {
  it("shows a retryable CAD background error without recreating the image on selection changes", async () => {
    const images: Array<{ onload: null | (() => void); onerror: null | (() => void); src: string; decode: ReturnType<typeof vi.fn> }> = [];
    class FailingImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      src = "";
      decode = vi.fn(async () => undefined);
      constructor() { images.push(this); }
    }
    vi.stubGlobal("Image", FailingImage);
    renderEditor();

    act(() => useFloorEditorStore.getState().selectFixture("fixture-1"));
    expect(images).toHaveLength(1);
    act(() => images[0].onerror?.());
    expect(screen.getByText("CAD 도면을 표시하지 못했습니다.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "도면 다시 시도" }));
    expect(images).toHaveLength(2);
    await act(async () => images[1].onload?.());
    await waitFor(() => expect(screen.queryByText("CAD 도면을 표시하지 못했습니다.")).not.toBeInTheDocument());
  });

  it("culls offscreen canvas nodes, keeps selected fixtures mounted, and reduces low-zoom detail", () => {
    const large = structuredClone(editorState);
    large.floor.floorPlan = { ...large.floor.floorPlan!, width: 5_000, height: 5_000 };
    large.fixtures = [
      { ...large.fixtures[0], id: "fixture-near", x: 100, y: 100 },
      { ...large.fixtures[0], id: "fixture-far", x: 4_000, y: 4_000 }
    ];
    large.objects = [
      { ...large.objects[0], id: "object-near", x: 200, y: 200 },
      { ...large.objects[0], id: "object-far", x: 4_000, y: 4_000 }
    ];
    large.lightSlots = [
      { id: "slot-near", x: 300, y: 300, rotation: 0, assignedFixtureId: null },
      { id: "slot-far", x: 4_000, y: 4_000, rotation: 0, assignedFixtureId: null }
    ];
    renderEditor(large);
    const stage = (window as unknown as { Konva: { stages: import("konva").default.Stage[] } }).Konva.stages.at(-1)!;

    expect(stage.find(".fixture-fixture-near")).toHaveLength(1);
    expect(stage.find(".fixture-fixture-far")).toHaveLength(0);
    expect(stage.find(".map-object-object-near")).toHaveLength(1);
    expect(stage.find(".map-object-object-far")).toHaveLength(0);
    expect(stage.find(".cad-placement-slot")).toHaveLength(1);

    act(() => {
      useFloorEditorStore.getState().selectFixture("fixture-far");
      useFloorEditorStore.getState().setZoom(0.2);
    });
    const far = stage.findOne<import("konva").default.Group>(".fixture-fixture-far")!;
    expect(far).toBeDefined();
    expect(far.findOne<import("konva").default.Circle>("Circle")?.strokeWidth()).toBe(3);
    expect(stage.findOne<import("konva").default.Group>(".fixture-fixture-near")
      ?.findOne<import("konva").default.Circle>("Circle")?.strokeWidth()).toBe(1);
  });

  it("reuses fixture, object, and available-slot indexes while pan and zoom only requery them", () => {
    const large = structuredClone(editorState);
    large.floor.floorPlan = { ...large.floor.floorPlan!, width: 5_000, height: 5_000 };
    large.fixtures = Array.from({ length: 1_000 }, (_, index) => ({
      ...large.fixtures[0],
      id: `fixture-${index + 1}`,
      x: 20 + index % 40 * 25,
      y: 20 + Math.floor(index / 40) * 25
    }));
    large.objects = Array.from({ length: 2_000 }, (_, index) => ({
      ...large.objects[0],
      id: `object-${index + 1}`,
      x: 20 + index % 50 * 30,
      y: 20 + Math.floor(index / 50) * 30,
      zIndex: index
    }));
    large.lightSlots = Array.from({ length: 2_000 }, (_, index) => ({
      id: `slot-${index + 1}`,
      x: 20 + index % 50 * 30,
      y: 20 + Math.floor(index / 50) * 30,
      rotation: 0,
      assignedFixtureId: null
    }));
    const buildIndex = vi.spyOn(spatialIndex, "buildEditorSpatialIndex");

    renderEditor(large);
    const buildsAfterCollectionsLoad = buildIndex.mock.calls.length;
    expect(buildsAfterCollectionsLoad).toBeGreaterThanOrEqual(3);

    act(() => {
      const store = useFloorEditorStore.getState();
      store.setPan({ x: -600, y: -300 });
      store.setZoom(2);
    });

    expect(buildIndex.mock.calls.length).toBe(buildsAfterCollectionsLoad);
  });

  it("mounts newly visible nodes during a live pan before pointer up", () => {
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const large = structuredClone(editorState);
    large.floor.floorPlan = { ...large.floor.floorPlan!, width: 5_000, height: 5_000 };
    large.fixtures = [
      { ...large.fixtures[0], id: "fixture-near", x: 100, y: 100 },
      { ...large.fixtures[0], id: "fixture-pan-target", x: 1_200, y: 100 }
    ];
    renderEditor(large);
    const stage = (window as unknown as { Konva: { stages: import("konva").default.Stage[] } }).Konva.stages.at(-1)!;
    expect(stage.find(".fixture-fixture-pan-target")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "이동" }));
    const canvas = screen.getByLabelText("B2 편집 캔버스");
    fireEvent.mouseDown(canvas, { clientX: 600, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 100 });
    act(() => frame?.(16));

    expect(stage.find(".fixture-fixture-pan-target")).toHaveLength(1);
    expect(useFloorEditorStore.getState().pan).toEqual({ x: 0, y: 0 });
  });

  it("culls map objects using rotated and rendered-stroke world bounds", () => {
    const large = structuredClone(editorState);
    large.floor.floorPlan = { ...large.floor.floorPlan!, width: 5_000, height: 5_000 };
    large.fixtures = [];
    large.objects = [
      { ...large.objects[0], id: "rotated-visible", type: "rectangle", x: 1_000, y: 200, width: 40, height: 300, rotation: 90, strokeWidth: 20 },
      { ...large.objects[0], id: "stroke-visible", type: "line", x: 962, y: 50, width: 20, height: 0, rotation: 0, strokeWidth: 2 },
      { ...large.objects[0], id: "triangle-points-visible", type: "triangle", x: 1_200, y: 200, width: 40, height: 40, rotation: 90, strokeWidth: 2,
        points: [{ x: -100, y: 300 }, { x: 40, y: -100 }, { x: 0, y: 0 }] },
      { ...large.objects[0], id: "far", x: 2_000, y: 2_000 }
    ];
    renderEditor(large);
    const stage = (window as unknown as { Konva: { stages: import("konva").default.Stage[] } }).Konva.stages.at(-1)!;

    expect(stage.find(".map-object-rotated-visible")).toHaveLength(1);
    expect(stage.find(".map-object-stroke-visible")).toHaveLength(1);
    expect(stage.find(".map-object-triangle-points-visible")).toHaveLength(1);
    expect(stage.find(".map-object-far")).toHaveLength(0);
  });

  it("coalesces drawing pointer moves into one animation frame", () => {
    let frame: FrameRequestCallback | null = null;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    renderEditor({ ...editorState, objects: [] });
    fireEvent.click(screen.getByRole("button", { name: "사각형" }));
    const canvas = screen.getByLabelText("B2 편집 캔버스");

    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 160, clientY: 160 });
    fireEvent.mouseMove(canvas, { clientX: 200, clientY: 180 });
    fireEvent.mouseMove(canvas, { clientX: 240, clientY: 200 });

    expect(requestFrame).toHaveBeenCalledOnce();
    expect(useFloorEditorStore.getState().state?.objects).toHaveLength(0);
    act(() => frame?.(16));
    fireEvent.mouseUp(canvas, { clientX: 240, clientY: 200 });
    expect(useFloorEditorStore.getState().state?.objects).toHaveLength(1);
  });

  it("cancels pending fixture and object drags when the editor becomes read-only", () => {
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const view = renderEditor();
    const stage = (window as unknown as { Konva: { stages: import("konva").default.Stage[] } }).Konva.stages.at(-1)!;
    const fixture = stage.findOne<import("konva").default.Group>(".fixture-fixture-1")!;
    fixture.fire("dragstart", { target: fixture }, true);
    fixture.position({ x: 260, y: 260 });
    fixture.fire("dragmove", { target: fixture }, true);

    view.rerenderWithProps({ readOnly: true });
    act(() => frame?.(16));
    fixture.fire("dragend", { target: fixture }, true);
    expect(fixture.position()).toEqual({ x: 120, y: 140 });
    expect(useFloorEditorStore.getState().state?.fixtures[0]).toMatchObject({ x: 120, y: 140 });

    view.rerenderWithProps({ readOnly: false });
    const object = stage.findOne<import("konva").default.Node>(".map-object-object-1")!;
    object.fire("dragstart", { target: object }, true);
    object.position({ x: 500, y: 420 });
    object.fire("dragmove", { target: object }, true);
    view.rerenderWithProps({ readOnly: true });
    act(() => frame?.(32));
    object.fire("dragend", { target: object }, true);

    expect(object.position()).toEqual({ x: 300, y: 180 });
    expect(useFloorEditorStore.getState().state?.objects[0]).toMatchObject({ x: 300, y: 180 });
    expect(screen.getByTestId("floor-editor-canvas")).toHaveAttribute("data-active-guides", "");
  });

  it("keeps virtualized search, selection, and End-key focus working for 1,000 fixtures", async () => {
    const large = structuredClone(editorState);
    large.fixtures = Array.from({ length: 1_000 }, (_, index) => ({
      ...large.fixtures[0],
      id: `fixture-${index + 1}`,
      name: `L-${String(index + 1).padStart(4, "0")}`,
      placementStatus: "unplaced" as const
    }));
    renderEditor(large);
    const list = screen.getByTestId("placement-list");
    expect(within(list).getAllByRole("button").length).toBeLessThan(20);

    const first = screen.getByTestId("placement-fixture-fixture-1");
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    await waitFor(() => expect(screen.getByTestId("placement-fixture-fixture-1000")).toHaveFocus());

    fireEvent.change(screen.getByLabelText("조명 검색"), { target: { value: "0999" } });
    const searched = await screen.findByTestId("placement-fixture-fixture-999");
    fireEvent.click(searched);
    expect(useFloorEditorStore.getState().selectedFixtureIds).toEqual(["fixture-999"]);
  });

  it("moves roving focus to a mounted row after manual virtual-list scrolling", async () => {
    const large = structuredClone(editorState);
    large.fixtures = Array.from({ length: 1_000 }, (_, index) => ({
      ...large.fixtures[0],
      id: `fixture-${index + 1}`,
      name: `L-${String(index + 1).padStart(4, "0")}`,
      placementStatus: "unplaced" as const
    }));
    renderEditor(large);
    const first = screen.getByTestId("placement-fixture-fixture-1");
    const list = screen.getByTestId("placement-list");
    first.focus();

    Object.defineProperty(list, "scrollTop", { configurable: true, value: 500 * 64 });
    fireEvent.scroll(list);

    await waitFor(() => expect(screen.getByTestId("placement-fixture-fixture-501")).toHaveFocus());
    expect(screen.getByTestId("placement-fixture-fixture-501")).toHaveAttribute("tabindex", "0");
  });

  it("preserves viewport and selection when a save cache response is structurally shared", async () => {
    const saved = { ...structuredClone(editorState), floor: { ...editorState.floor, mapRevision: 8 }, fixtures: [{ ...editorState.fixtures[0], x: 240 }] };
    floorEditorApi.saveFloorEditorState.mockResolvedValueOnce(saved);
    const onSaved = vi.fn();
    const view = renderEditor(editorState, { onSaved });
    const key = ["floor-editor", "site-2", "floor-b2"];
    view.queryClient.setQueryData(key, structuredClone(editorState));
    act(() => {
      const store = useFloorEditorStore.getState();
      store.selectFixture("fixture-1");
      store.setZoom(0.6);
      store.setPan({ x: 75, y: -30 });
      store.updateFixture("fixture-1", { x: 240 });
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    const cached = view.queryClient.getQueryData<FloorEditorState>(key)!;
    expect(cached).toEqual(saved);
    expect(cached).not.toBe(saved);
    view.rerenderEditor(cached);
    expect(useFloorEditorStore.getState()).toMatchObject({ zoom: 0.6, pan: { x: 75, y: -30 }, selectedFixtureIds: ["fixture-1"], selection: { kind: "fixture", id: "fixture-1" }, initialState: saved, isDirty: false });
  });

  it("keeps clean same-scope history on equivalent refetch and resets it for another floor", () => {
    const view = renderEditor();
    act(() => {
      const store = useFloorEditorStore.getState();
      store.updateFixture("fixture-1", { x: 240 });
      store.undo();
      store.setZoom(0.6);
      store.setPan({ x: 75, y: -30 });
    });
    const future = useFloorEditorStore.getState().future;
    expect(future).toHaveLength(1);
    view.rerenderEditor(structuredClone(editorState));
    expect(useFloorEditorStore.getState().future).toBe(future);
    expect(useFloorEditorStore.getState().zoom).toBe(0.6);
    view.rerenderEditor({ ...structuredClone(editorState), floor: { ...editorState.floor, id: "other-floor" } });
    expect(useFloorEditorStore.getState()).toMatchObject({ zoom: 1, pan: { x: 0, y: 0 }, past: [], future: [], selectedFixtureIds: [] });
  });

  it("ignores a late save response after switching to another floor draft", async () => {
    const save = deferred<FloorEditorState>();
    floorEditorApi.saveFloorEditorState.mockReturnValueOnce(save.promise);
    const onSaved = vi.fn();
    const view = renderEditor(editorState, { onSaved });
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 44 }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    const other = { ...structuredClone(editorState), floor: { ...editorState.floor, id: "floor-other" } };
    view.rerenderEditor(other);
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 999 }));
    await act(async () => save.resolve({ ...editorState, floor: { ...editorState.floor, mapRevision: 8 } }));
    expect(useFloorEditorStore.getState().state?.floor.id).toBe("floor-other");
    expect(useFloorEditorStore.getState().state?.fixtures[0].x).toBe(1000);
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    floorEditorApi.getActiveFloorImportJob.mockResolvedValue({ job: null });
    floorEditorApi.getAppliedFloorImportOverlay.mockResolvedValue({ overlay: null });
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    useFloorEditorStore.setState({ initialState: null, state: null, isDirty: false, activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null });
  });

  it("renders toolbar canvas properties save and cancel controls", () => {
    renderEditor(editorState, {
      floors: [{ id: "floor-b2", name: "B2" }, { id: "floor-b1", name: "B1" }],
      onFloorChange: vi.fn()
    });

    expect(screen.getByRole("heading", { name: "B2 맵 편집" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "확대" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "축소" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "취소" })).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "맵 편집 도구" })).toBeInTheDocument();
    expect(screen.getByLabelText("B2 편집 캔버스")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "속성 패널" })).toBeInTheDocument();
    const sidePanel = screen.getByRole("complementary", { name: "맵 편집 정보" });
    expect(sidePanel).toBeVisible();
    expect(sidePanel.parentElement).toHaveAttribute("data-testid", "floor-editor-layout");
    expect(screen.getByRole("heading", { name: "맵 설정" })).toBeInTheDocument();
    expect(screen.getByLabelText("맵 너비")).toHaveValue("1,200");
    expect(screen.getByLabelText("맵 높이")).toHaveValue("800");
    expect(screen.getByLabelText("격자 간격")).toHaveValue("10");
    expect(screen.queryByLabelText("조명명")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "층 선택" })).toHaveAttribute("data-react-aria-pressable", "true");
    expect(screen.getByRole("checkbox", { name: "격자 스냅" }).closest("[data-field]")).toBeInTheDocument();
  });

  it("offers CAD import without the legacy image upload panel", () => {
    renderEditor(editorState);

    expect(screen.queryByRole("region", { name: "도면 자산" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "CAD 가져오기" })).toBeInTheDocument();
  });

  it("shows only controls that belong to the selected element type", () => {
    renderEditor();

    act(() => useFloorEditorStore.getState().selectFixture("fixture-1"));
    expect(screen.getByLabelText("조명명")).toBeInTheDocument();
    expect(screen.queryByLabelText("맵 너비")).not.toBeInTheDocument();

    act(() => useFloorEditorStore.getState().selectObject("object-1"));
    expect(screen.getByLabelText("텍스트 내용")).toBeInTheDocument();
    expect(screen.getByLabelText("글자 크기")).toBeInTheDocument();
    expect(screen.queryByLabelText("채우기 색상")).not.toBeInTheDocument();
  });

  it("switches shape properties between area and line controls", () => {
    const rectangle = { ...editorState.objects[0], type: "rectangle" as const, text: "" };
    renderEditor({ ...editorState, objects: [rectangle] });

    act(() => useFloorEditorStore.getState().selectObject("object-1"));
    expect(screen.getByLabelText("너비")).toBeInTheDocument();
    expect(screen.getByLabelText("높이")).toBeInTheDocument();
    expect(screen.getByLabelText("선 색상")).toBeInTheDocument();
    expect(screen.getByLabelText("채우기 색상")).toBeInTheDocument();

    act(() => useFloorEditorStore.setState((store) => ({
      state: store.state ? { ...store.state, objects: [{ ...rectangle, type: "line", height: 0 }] } : null
    })));
    expect(screen.getByLabelText("길이")).toBeInTheDocument();
    expect(screen.queryByLabelText("높이")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("채우기 색상")).not.toBeInTheDocument();
  });

  it("shows batch fixture properties for a multi-selection", () => {
    const second = { ...editorState.fixtures[0], id: "fixture-2", name: "B2-L02" };
    renderEditor({ ...editorState, fixtures: [...editorState.fixtures, second] });

    act(() => useFloorEditorStore.getState().selectFixtures(["fixture-1", "fixture-2"]));

    expect(screen.getByRole("heading", { name: "2개 선택" })).toBeInTheDocument();
    expect(screen.getByLabelText("이름 접두어")).toBeInTheDocument();
    expect(screen.queryByLabelText("맵 너비")).not.toBeInTheDocument();
  });
  it("rejects recovery while save is pending and ignores a response after principal purge", async () => {
    saveEditorDraft("draft-user", editorState, { ...editorState, fixtures: [{ ...editorState.fixtures[0], x: 555 }] });
    const save = deferred<FloorEditorState>();
    floorEditorApi.saveFloorEditorState.mockReturnValueOnce(save.promise);
    const { queryClient } = renderEditor(editorState, undefined, "draft-user");
    const recover = await screen.findByRole("button", { name: "초안 복구" });
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 222 }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(recover).toBeDisabled();
    fireEvent.click(recover);
    expect(useFloorEditorStore.getState().state?.fixtures[0].x).toBe(220);
    act(() => clearTenantCache(queryClient));
    await act(async () => save.resolve(editorState));
    expect(useFloorEditorStore.getState().state).toBeNull();
    expect(queryClient.getQueryData(["floor-editor", "site-2", "floor-b2"])).toBeUndefined();
  });
  it("ignores a late revision restore after changing floors", async () => {
    floorEditorApi.listFloorEditorRevisions.mockResolvedValueOnce({ items: [revision(5)], nextCursor: null });
    const restore = deferred<FloorEditorState & { skippedFixtureIds: string[] }>();
    floorEditorApi.restoreFloorEditorRevision.mockReturnValueOnce(restore.promise);
    const view = renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "리비전 5 복구" }));
    const other = { ...editorState, floor: { ...editorState.floor, id: "other" } };
    view.rerenderEditor(other);
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 777 }));
    await act(async () => restore.resolve({ ...editorState, skippedFixtureIds: [] }));
    expect(useFloorEditorStore.getState().state?.floor.id).toBe("other");
    expect(useFloorEditorStore.getState().state?.fixtures[0].x).toBe(780);
  });

  it("keeps editor icon actions at least 44 by 44 pixels across desktop and mobile tracks", async () => {
    floorEditorApi.listFloorEditorRevisions.mockResolvedValueOnce({ items: [revision(5)], nextCursor: null });
    renderEditor();

    const toolbar = screen.getByRole("toolbar", { name: "맵 편집 도구" });
    const toolButton = within(toolbar).getByRole("button", { name: "선택" });
    const restoreButton = await screen.findByRole("button", { name: "리비전 5 복구" });

    expect(toolButton).toHaveClass("min-h-12", "min-w-12", "max-compact:min-h-14", "max-compact:min-w-14");
    expect(restoreButton).toHaveClass("min-h-14", "min-w-14");
    expect(toolbar).toHaveClass("grid-cols-4", "max-compact:grid-cols-3");
  });

  it("keeps save disabled when a route-owned lease makes the editor read-only", () => {
    renderEditor(editorState, { readOnly: true });
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 221 }));

    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("aria-disabled", "true");
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
    fireEvent.blur(screen.getByLabelText("정격 전력"));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledWith("floor-b2", {
      expectedRevision: 7,
      leaseToken: "lease-token",
      leaseFence: 7,
      fixtureUpdates: [{ id: "fixture-1", name: "B2-L01 수정", ratedWatt: 45 }],
      slotAssignments: [],
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

    expect(screen.getByRole("heading", { name: "네모" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledOnce());
    expect(floorEditorApi.saveFloorEditorState.mock.calls[0][1].objectCreates).toEqual([
      expect.objectContaining({ type: "rectangle", x: 240, y: 180, width: 160, height: 100 })
    ]);
  });

  it("snaps an unplaced fixture to the exact position of a CAD slot inside the hit radius", () => {
    const state: FloorEditorState = {
      ...structuredClone(editorState),
      fixtures: [{ ...structuredClone(editorState.fixtures[0]), x: 0, y: 0, placementStatus: "unplaced" }],
      lightSlots: [{ id: "slot-free", x: 123.5, y: 247.25, rotation: 37, assignedFixtureId: null }]
    };
    renderEditor(state);
    const dataTransfer = createDataTransfer();
    const row = screen.getByTestId("placement-fixture-fixture-1");
    const canvas = screen.getByLabelText("B2 편집 캔버스");

    fireEvent.dragStart(row, { dataTransfer });
    fireEvent(canvas, createDragEventWithPoint(canvas, "drop", dataTransfer, 130, 250));

    expect(useFloorEditorStore.getState().state).toMatchObject({
      fixtures: [expect.objectContaining({ id: "fixture-1", placementStatus: "placed", x: 123.5, y: 247.25 })],
      lightSlots: [expect.objectContaining({ id: "slot-free", rotation: 37, assignedFixtureId: "fixture-1" })]
    });
  });

  it("saves slot assignment changes and adopts the assigned response as the reload baseline", async () => {
    const initial: FloorEditorState = {
      ...structuredClone(editorState),
      fixtures: [{ ...structuredClone(editorState.fixtures[0]), x: 0, y: 0, placementStatus: "unplaced" }],
      lightSlots: [{ id: "slot-1", x: 123.5, y: 247.25, rotation: 37, assignedFixtureId: null }]
    };
    const saved: FloorEditorState = {
      ...structuredClone(initial),
      floor: { ...initial.floor, mapRevision: 8 },
      fixtures: [{ ...initial.fixtures[0], x: 123.5, y: 247.25, placementStatus: "placed" }],
      lightSlots: [{ ...initial.lightSlots[0], assignedFixtureId: "fixture-1" }]
    };
    floorEditorApi.saveFloorEditorState.mockResolvedValueOnce(saved);
    const view = renderEditor(initial);
    act(() => useFloorEditorStore.getState().assignFixtureToSlot("fixture-1", "slot-1"));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledWith(
      "floor-b2",
      expect.objectContaining({
        slotAssignments: [{ slotId: "slot-1", assignedFixtureId: "fixture-1" }]
      })
    ));
    expect(useFloorEditorStore.getState()).toMatchObject({ initialState: saved, state: saved, isDirty: false });

    view.rerenderEditor(structuredClone(saved));
    expect(useFloorEditorStore.getState().state!.lightSlots).toEqual(saved.lightSlots);
    expect(useFloorEditorStore.getState().isDirty).toBe(false);
  });

  it("keeps the existing free placement behavior when a fixture is dropped outside every slot", () => {
    const state: FloorEditorState = {
      ...structuredClone(editorState),
      fixtures: [{ ...structuredClone(editorState.fixtures[0]), x: 0, y: 0, placementStatus: "unplaced" }],
      lightSlots: [{ id: "slot-free", x: 123.5, y: 247.25, rotation: 37, assignedFixtureId: null }]
    };
    renderEditor(state);
    act(() => useFloorEditorStore.getState().setSnap(false));
    const dataTransfer = createDataTransfer();
    const row = screen.getByTestId("placement-fixture-fixture-1");
    const canvas = screen.getByLabelText("B2 편집 캔버스");

    fireEvent.dragStart(row, { dataTransfer });
    fireEvent(canvas, createDragEventWithPoint(canvas, "drop", dataTransfer, 333, 277));

    expect(useFloorEditorStore.getState().state).toMatchObject({
      fixtures: [expect.objectContaining({ id: "fixture-1", placementStatus: "placed", x: 333, y: 277 })],
      lightSlots: [expect.objectContaining({ id: "slot-free", assignedFixtureId: null })]
    });
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
    renderEditor({
      ...editorState,
      objects: [{ ...editorState.objects[0], type: "rectangle", text: "" }]
    });

    act(() => useFloorEditorStore.getState().selectObject("object-1"));

    expect(screen.getByLabelText("채우기 색상")).toHaveAttribute("type", "color");
  });

  it("saves fixture size changes for Konva transformer resizing", async () => {
    renderEditor();

    act(() => useFloorEditorStore.getState().selectFixture("fixture-1"));
    fireEvent.change(screen.getByLabelText("크기"), { target: { value: "36" } });
    fireEvent.blur(screen.getByLabelText("크기"));
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
    fireEvent.mouseUp(screen.getByLabelText("B2 편집 캔버스"), { clientX: 130, clientY: 150 });

    expect(useFloorEditorStore.getState().pan).toEqual({ x: 30, y: 30 });
  });

  it("zooms with wheel input regardless of pointer device", () => {
    renderEditor();
    const stage = document.querySelector<HTMLElement>(".konvajs-content");
    expect(stage).not.toBeNull();

    fireEvent.wheel(stage!, { deltaY: 120 });
    expect(useFloorEditorStore.getState().zoom).toBeLessThan(1);

    act(() => useFloorEditorStore.setState({ zoom: 1, pan: { x: 0, y: 0 } }));
    fireEvent.wheel(stage!, { deltaY: -8 });
    expect(useFloorEditorStore.getState()).toMatchObject({ zoom: 1.1, pan: { x: 0, y: 0 } });
  });

  it("does not submit an unchanged state", async () => {
    renderEditor();

    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(floorEditorApi.saveFloorEditorState).not.toHaveBeenCalled();
  });

  it("synchronously locks rapid saves and disables every mutation surface while saving", async () => {
    const save = deferred<FloorEditorState>();
    floorEditorApi.saveFloorEditorState.mockReturnValueOnce(save.promise);
    renderEditor();
    act(() => useFloorEditorStore.getState().selectFixture("fixture-1"));
    fireEvent.change(screen.getByLabelText("조명명"), { target: { value: "저장 대기" } });

    const saveButton = screen.getByRole("button", { name: "저장" });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("조명명")).toBeDisabled();
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "사각형" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "실행 취소" })).toBeDisabled();
    act(() => useFloorEditorStore.getState().setActiveTool("rectangle"));
    fireEvent.mouseDown(screen.getByLabelText("B2 편집 캔버스"), { clientX: 200, clientY: 160 });
    fireEvent.mouseMove(screen.getByLabelText("B2 편집 캔버스"), { clientX: 320, clientY: 240 });
    fireEvent.mouseUp(screen.getByLabelText("B2 편집 캔버스"), { clientX: 320, clientY: 240 });
    expect(useFloorEditorStore.getState().state?.objects).toHaveLength(1);

    save.resolve({ ...structuredClone(editorState), floor: { ...structuredClone(editorState.floor), mapRevision: 8 } });
    await waitFor(() => expect(screen.getByRole("button", { name: "저장" })).toBeDisabled());
  });

  it("keeps save and restore mutually exclusive with rapid restore clicks", async () => {
    floorEditorApi.listFloorEditorRevisions.mockResolvedValueOnce({ items: [revision(5)], nextCursor: null });
    const restore = deferred<FloorEditorState & { skippedFixtureIds: string[] }>();
    floorEditorApi.restoreFloorEditorRevision.mockReturnValueOnce(restore.promise);
    renderEditor();
    const restoreButton = await screen.findByRole("button", { name: "리비전 5 복구" });

    fireEvent.click(restoreButton);
    fireEvent.click(restoreButton);
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 999 }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(floorEditorApi.restoreFloorEditorRevision).toHaveBeenCalledOnce();
    expect(floorEditorApi.saveFloorEditorState).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();

    restore.resolve({
      ...structuredClone(editorState),
      floor: { ...structuredClone(editorState.floor), mapRevision: 8 },
      skippedFixtureIds: []
    });
    await waitFor(() => expect(useFloorEditorStore.getState().isDirty).toBe(false));
  });

  it("prevents restore from entering while an atomic save is pending", async () => {
    floorEditorApi.listFloorEditorRevisions.mockResolvedValueOnce({ items: [revision(5)], nextCursor: null });
    const save = deferred<FloorEditorState>();
    floorEditorApi.saveFloorEditorState.mockReturnValueOnce(save.promise);
    renderEditor();
    const restoreButton = await screen.findByRole("button", { name: "리비전 5 복구" });
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 333 }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    act(() => useFloorEditorStore.getState().adoptBaseline(useFloorEditorStore.getState().state!));
    expect(restoreButton).toBeDisabled();
    fireEvent.click(restoreButton);

    expect(floorEditorApi.restoreFloorEditorRevision).not.toHaveBeenCalled();
    save.resolve({ ...structuredClone(editorState), floor: { ...structuredClone(editorState.floor), mapRevision: 8 } });
    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledOnce());
  });

  it("previews CAD review results without registering fixtures and applies with the editor authority", async () => {
    const jobId = "00000000-0000-4000-8000-000000000020";
    const candidateId = "00000000-0000-4000-8000-000000000030";
    const renderedAssetPath = "/api/floors/floor-b2/assets/rendered-cad/content";
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce({
      id: "00000000-0000-4000-8000-000000000010",
      kind: "original",
      status: "ready",
      mimeType: "application/dxf",
      sizeBytes: 3,
      sha256: "a".repeat(64),
      accessPath: "/api/floors/floor-b2/assets/source-cad/content"
    });
    floorEditorApi.createFloorImportJob.mockResolvedValueOnce({
      jobId,
      floorId: "floor-b2",
      sourceAssetId: "00000000-0000-4000-8000-000000000010",
      renderedAssetId: "rendered-cad",
      sourceFormat: "dxf",
      status: "review_required",
      stage: "review_required",
      progressPercent: 100,
      attemptCount: 1,
      parserVersion: "parser-1",
      detectorVersion: "detector-1",
      failureCode: null,
      sourceAssetPath: "/api/floors/floor-b2/assets/source-cad/content",
      renderedAssetPath,
      renderedViewport: { width: 640, height: 360 },
      startedAt: "2026-09-17T00:00:00.000Z",
      reviewRequiredAt: "2026-09-17T00:00:01.000Z",
      appliedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:01.000Z"
    });
    floorEditorApi.listFloorImportCandidates.mockResolvedValueOnce({
      jobId,
      candidates: [{
        id: candidateId,
        sourceEntityId: "insert-1",
        layerName: "LIGHT",
        blockName: "LED",
        x: 100,
        y: 120,
        rotation: 0,
        confidence: 0.95,
        detectionMethod: "rule_based",
        provider: null,
        model: null,
        inputDigest: null,
        reviewStatus: "pending"
      }]
    });
    floorEditorApi.applyFloorImportJob.mockResolvedValueOnce({
      jobId,
      status: "completed",
      revision: 8,
      acceptedCandidateIds: [candidateId],
      renderedAssetId: "00000000-0000-4000-8000-000000000040",
      deletedObjectCount: 1,
      unplacedFixtureCount: 1,
      deletedSlotCount: 1,
      createdSlotCount: 1,
      floorPlan: {
        sourceType: "image",
        imageUrl: renderedAssetPath,
        originalFileUrl: "/api/floors/floor-b2/assets/source-cad/content",
        renderedImageUrl: renderedAssetPath,
        width: 640,
        height: 360,
        gridSize: 10
      }
    } satisfies FloorImportApplyResult);
    floorEditorApi.getAppliedFloorImportOverlay
      .mockResolvedValueOnce({ overlay: null })
      .mockResolvedValueOnce({
        overlay: {
          floorId: "floor-b2",
          jobId,
          revision: 8,
          renderedAssetId: "rendered-cad",
          renderedAssetPath,
          renderedViewport: { width: 640, height: 360 },
          appliedAt: "2026-09-17T00:00:02.000Z",
          candidates: [{
            id: candidateId,
            sourceEntityId: "insert-1",
            layerName: "LIGHT",
            blockName: "LED",
            x: 100,
            y: 120,
            rotation: 0,
            confidence: 0.95,
            detectionMethod: "rule_based",
            provider: null,
            model: null,
            inputDigest: null,
            profileVersion: "rules-v1",
            profileDigest: "a".repeat(64),
            reviewStatus: "accepted"
          }]
        }
      });
    const authoritative = {
      ...structuredClone(editorState),
      floor: {
        ...structuredClone(editorState.floor),
        mapRevision: 8,
        floorPlan: {
          ...structuredClone(editorState.floor.floorPlan!),
          imageUrl: renderedAssetPath,
          originalFileUrl: "/api/floors/floor-b2/assets/source-cad/content",
          renderedImageUrl: renderedAssetPath,
          width: 640,
          height: 360,
          version: 2
        }
      }
    };
    floorEditorApi.getFloorEditorState.mockResolvedValueOnce(authoritative);
    const onReload = vi.fn();
    const onSaved = vi.fn();
    renderEditor(editorState, { onReload, onSaved });

    fireEvent.change(screen.getByLabelText("CAD 파일"), {
      target: { files: [new File(["dxf"], "parking.dxf", { type: "application/dxf" })] }
    });
    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));

    await screen.findByText("조명 위치 후보 1개를 찾았습니다.");
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("data-background-url", renderedAssetPath);
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("data-cad-candidate-count", "1");
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("data-map-width", "640");
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("data-map-height", "360");
    expect(useFloorEditorStore.getState().state?.fixtures).toHaveLength(1);

    expect(useFloorEditorStore.getState().zoom).toBeCloseTo(1.175);
    act(() => useFloorEditorStore.getState().setZoom(0.75));
    await waitFor(() => expect(useFloorEditorStore.getState().zoom).toBe(0.75));

    act(() => useFloorEditorStore.getState().setViewport({ width: 800, height: 600 }));
    fireEvent.click(screen.getByRole("button", { name: "맵 맞춤" }));
    expect(useFloorEditorStore.getState().zoom).toBeCloseTo(1.175);

    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));
    const resetDialog = screen.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
    expect(resetDialog).toHaveTextContent("조명 1개가 미배치 상태로 변경");
    expect(resetDialog).toHaveTextContent("수동 도형 1개가 삭제");
    expect(resetDialog).toHaveTextContent("기존 CAD 슬롯 1개가 삭제");
    expect(floorEditorApi.applyFloorImportJob).not.toHaveBeenCalled();
    fireEvent.click(within(resetDialog).getByRole("button", { name: "교체 후 적용" }));

    await waitFor(() => expect(floorEditorApi.applyFloorImportJob).toHaveBeenCalledWith("floor-b2", jobId, {
      expectedRevision: 7,
      leaseToken: "lease-token",
      leaseFence: 7,
      confirmMapReset: true,
      candidateIds: [candidateId]
    }));
    await waitFor(() => expect(floorEditorApi.getFloorEditorState).toHaveBeenCalledWith("floor-b2"));
    expect(useFloorEditorStore.getState()).toMatchObject({
      isDirty: false,
      initialState: { floor: { mapRevision: 8, floorPlan: { width: 640, height: 360 } } },
      state: { floor: { mapRevision: 8, floorPlan: { width: 640, height: 360 } } }
    });
    expect(onSaved).toHaveBeenCalledWith(authoritative);
    expect(onReload).not.toHaveBeenCalled();
    expect(floorEditorApi.saveFloorEditorState).not.toHaveBeenCalled();
    expect(floorEditorApi.getAppliedFloorImportOverlay).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("data-cad-candidate-count", "1");
  });

  it("reloads applied CAD candidates as a read-only reference while fixture placement and identify stay enabled", async () => {
    const candidateId = "00000000-0000-4000-8000-000000000030";
    const renderedAssetId = "00000000-0000-4000-8000-000000000040";
    const renderedAssetPath = `/api/floors/floor-b2/assets/${renderedAssetId}/content`;
    const state = {
      ...structuredClone(editorState),
      floor: {
        ...structuredClone(editorState.floor),
        floorPlan: {
          ...structuredClone(editorState.floor.floorPlan!),
          imageUrl: renderedAssetPath,
          renderedImageUrl: renderedAssetPath,
          width: 640,
          height: 360
        }
      }
    };
    floorEditorApi.getAppliedFloorImportOverlay.mockResolvedValueOnce({
      overlay: {
        floorId: "floor-b2",
        jobId: "00000000-0000-4000-8000-000000000020",
        revision: 7,
        renderedAssetId,
        renderedAssetPath,
        renderedViewport: { width: 640, height: 360 },
        appliedAt: "2026-09-17T00:00:00.000Z",
        candidates: [{
          id: candidateId,
          sourceEntityId: "insert-1",
          layerName: "LIGHT",
          blockName: "LED",
          x: 100,
          y: 120,
          rotation: 0,
          confidence: 0.95,
          detectionMethod: "rule_based",
          provider: null,
          model: null,
          inputDigest: null,
          profileVersion: "rules-v1",
          profileDigest: "a".repeat(64),
          reviewStatus: "accepted"
        }]
      }
    });

    renderEditor(state);

    await waitFor(() => expect(screen.getByLabelText("B2 편집 캔버스"))
      .toHaveAttribute("data-cad-candidate-count", "1"));
    expect(floorEditorApi.getAppliedFloorImportOverlay).toHaveBeenCalledWith("floor-b2");
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("data-background-url", renderedAssetPath);
    expect(screen.getByRole("button", { name: "선택" })).toBeEnabled();

    act(() => useFloorEditorStore.getState().selectFixture("fixture-1"));
    expect(screen.getByRole("button", { name: "확인 시작" })).toBeEnabled();
    expect(useFloorEditorStore.getState().state?.fixtures).toHaveLength(1);
  });

  it("refreshes the applied overlay revision after saving registered fixture placement", async () => {
    const candidateId = "00000000-0000-4000-8000-000000000030";
    const renderedAssetId = "00000000-0000-4000-8000-000000000040";
    const renderedAssetPath = `/api/floors/floor-b2/assets/${renderedAssetId}/content`;
    const state = {
      ...structuredClone(editorState),
      floor: {
        ...structuredClone(editorState.floor),
        floorPlan: {
          ...structuredClone(editorState.floor.floorPlan!),
          imageUrl: renderedAssetPath,
          renderedImageUrl: renderedAssetPath
        }
      }
    };
    const response = (revision: number) => ({
      overlay: {
        floorId: "floor-b2",
        jobId: "00000000-0000-4000-8000-000000000020",
        revision,
        renderedAssetId,
        renderedAssetPath,
        renderedViewport: { width: 1200, height: 800 },
        appliedAt: "2026-09-17T00:00:00.000Z",
        candidates: [{
          id: candidateId,
          sourceEntityId: "insert-1",
          layerName: "LIGHT",
          blockName: "LED",
          x: 100,
          y: 120,
          rotation: 0,
          confidence: 0.95,
          detectionMethod: "rule_based",
          provider: null,
          model: null,
          inputDigest: null,
          profileVersion: "rules-v1",
          profileDigest: "a".repeat(64),
          reviewStatus: "accepted"
        }]
      }
    });
    floorEditorApi.getAppliedFloorImportOverlay
      .mockResolvedValueOnce(response(7))
      .mockResolvedValueOnce(response(8));
    floorEditorApi.saveFloorEditorState.mockResolvedValueOnce({
      ...structuredClone(state),
      floor: { ...structuredClone(state.floor), mapRevision: 8 },
      fixtures: [{ ...structuredClone(state.fixtures[0]), x: 240 }]
    });
    renderEditor(state);
    await waitFor(() => expect(screen.getByLabelText("B2 편집 캔버스"))
      .toHaveAttribute("data-cad-candidate-count", "1"));

    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 240 }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.getAppliedFloorImportOverlay).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("B2 편집 캔버스")).toHaveAttribute("data-cad-candidate-count", "1");
  });

  it("connects a CAD apply conflict to the editor reload conflict UX", async () => {
    const jobId = "00000000-0000-4000-8000-000000000020";
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({
      job: {
        jobId,
        floorId: "floor-b2",
        sourceAssetId: "source-cad",
        renderedAssetId: "rendered-cad",
        sourceFormat: "dxf",
        status: "review_required",
        stage: "review_required",
        progressPercent: 100,
        attemptCount: 1,
        parserVersion: "parser-1",
        detectorVersion: "detector-1",
        failureCode: null,
        sourceAssetPath: "/source",
        renderedAssetPath: "/rendered",
        renderedViewport: { width: 640, height: 360 },
        startedAt: null,
        reviewRequiredAt: null,
        appliedAt: null,
        completedAt: null,
        failedAt: null,
        cancelledAt: null,
        createdAt: "2026-09-17T00:00:00.000Z",
        updatedAt: "2026-09-17T00:00:01.000Z"
      }
    });
    floorEditorApi.listFloorImportCandidates.mockResolvedValueOnce({ jobId, candidates: [{
      id: "00000000-0000-4000-8000-000000000030",
      sourceEntityId: "insert-1", layerName: "LIGHT", blockName: "LED", x: 100, y: 120,
      rotation: 0, confidence: 0.95, detectionMethod: "rule_based", provider: null, model: null,
      inputDigest: null, reviewStatus: "pending"
    }] });
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new ApiError("conflict", 409, null));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      jobId,
      floorId: "floor-b2",
      sourceAssetId: "source-cad",
      renderedAssetId: "rendered-cad",
      sourceFormat: "dxf",
      status: "review_required",
      stage: "review_required",
      progressPercent: 100,
      attemptCount: 1,
      parserVersion: "parser-1",
      detectorVersion: "detector-1",
      failureCode: null,
      sourceAssetPath: "/source",
      renderedAssetPath: "/rendered",
      renderedViewport: { width: 640, height: 360 },
      startedAt: null,
      reviewRequiredAt: null,
      appliedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:01.000Z"
    });
    renderEditor();

    await screen.findByText("조명 위치 후보 1개를 찾았습니다.");
    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" }))
      .getByRole("button", { name: "교체 후 적용" }));

    expect(await screen.findByText("최신 맵과 변경사항이 충돌했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "최신 버전 다시 불러오기" })).toBeInTheDocument();
  });

  it("keeps current edits and dirty state after a network failure", async () => {
    floorEditorApi.saveFloorEditorState.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    renderEditor();
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 222 }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("저장하지 못했습니다");
    expect(useFloorEditorStore.getState().state?.fixtures[0].x).toBe(220);
    expect(useFloorEditorStore.getState().isDirty).toBe(true);
  });

  it("409 충돌은 최신 버전 다시 불러오기만 제공한다", async () => {
    const onReload = vi.fn();
    floorEditorApi.saveFloorEditorState.mockRejectedValueOnce(
      new ApiError("PUT failed", 409, { message: "revision conflict" })
    );
    renderEditor(editorState, { onReload });
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 223 }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    const feedback = await screen.findByRole("alert");
    expect(feedback).toHaveTextContent("최신 맵과 변경사항이 충돌했습니다.");
    expect(feedback).toHaveTextContent("최신 버전을 다시 불러온 뒤 변경사항을 확인하세요.");
    expect(feedback).toHaveAttribute("data-tone", "danger");
    expect(screen.queryByRole("button", { name: /강제/ })).not.toBeInTheDocument();
    expect(within(feedback).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "최신 버전 다시 불러오기" }));

    const dialog = screen.getByRole("dialog", { name: "로컬 변경사항을 버릴까요?" });
    expect(dialog).toHaveTextContent("최신 버전을 불러오면 저장하지 않은 변경사항을 복구할 수 없습니다.");
    expect(onReload).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "변경사항 버리기" }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(useFloorEditorStore.getState().isDirty).toBe(false);
  });

  it("returns focus to the registered fixture row after unplacing a fixture", async () => {
    renderEditor();
    act(() => useFloorEditorStore.getState().selectFixture("fixture-1"));

    fireEvent.click(screen.getByRole("button", { name: "배치 해제" }));
    const dialog = screen.getByRole("dialog", { name: "이 조명을 맵에서 제거할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "배치 해제" }));

    const row = await screen.findByTestId("placement-fixture-fixture-1");
    await waitFor(() => expect(row).toHaveFocus());
    expect(useFloorEditorStore.getState().state).toMatchObject({
      fixtures: [expect.objectContaining({ id: "fixture-1", placementStatus: "unplaced", x: 0, y: 0 })],
      lightSlots: [expect.objectContaining({ id: "slot-1", assignedFixtureId: null })]
    });
  });

  it("invalidates site and floor scoped queries after atomic save", async () => {
    const { queryClient } = renderEditor();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 224 }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", "site-2"] });
    expect(queryClient.getQueryData(["floor-editor", "site-2", "floor-b2"])).toMatchObject({ floor: { mapRevision: 8 } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-fixtures", "site-2", "floor-b2"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-map", "site-2", "floor-b2"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-editor-revisions", "site-2", "floor-b2"] });
  });

  it("writes the saved editor map into inactive monitoring caches before a refetch", async () => {
    const saved: FloorEditorState = {
      ...structuredClone(editorState),
      floor: {
        ...structuredClone(editorState.floor),
        mapRevision: 8,
        floorPlan: {
          ...structuredClone(editorState.floor.floorPlan!),
          width: 1600,
          height: 900,
          version: 2
        }
      },
      fixtures: [{
        ...structuredClone(editorState.fixtures[0]),
        name: "B2-L01 변경",
        x: 240,
        y: 260,
        size: 36,
        ratedWatt: 45,
        placementStatus: "placed"
      }, {
        ...structuredClone(editorState.fixtures[0]),
        id: "fixture-free",
        name: "B2-L02 자유 배치",
        x: 640,
        y: 420,
        size: 24,
        placementStatus: "placed"
      }, {
        ...structuredClone(editorState.fixtures[0]),
        id: "fixture-unplaced",
        name: "B2-L03 미배치",
        x: 0,
        y: 0,
        placementStatus: "unplaced"
      }],
      lightSlots: [{
        ...structuredClone(editorState.lightSlots[0]),
        x: 240,
        y: 260,
        assignedFixtureId: "fixture-1"
      }],
      objects: [{
        ...structuredClone(editorState.objects[0]),
        text: "변경된 출입구",
        x: 420,
        strokeColor: "#2563eb"
      }]
    };
    floorEditorApi.saveFloorEditorState.mockResolvedValueOnce(saved);
    const { queryClient } = renderEditor();
    queryClient.setQueryData(["floor-map", "site-2", "floor-b2"], {
      floorId: "floor-b2",
      revision: 7,
      width: 1200,
      height: 800,
      floorPlan: editorState.floor.floorPlan,
      objects: editorState.objects
    });
    queryClient.setQueryData(["floor-fixtures", "site-2", "floor-b2"], {
      pages: [{
        items: [{
          ...structuredClone(editorState.fixtures[0]),
          size: 20,
          health: null,
          rssi: null,
          hopCount: null,
          commandSuccessRate: null,
          lastSeenAt: null,
          gateway: null,
          controllable: false,
          controlBlockReason: "fixture_unmapped"
        }],
        nextCursor: null
      }],
      pageParams: [""]
    });
    act(() => useFloorEditorStore.getState().updateFixture("fixture-1", { x: 240 }));

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.saveFloorEditorState).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(["floor-map", "site-2", "floor-b2"])).toMatchObject({
      revision: 8,
      width: 1600,
      height: 900,
      objects: [{ text: "변경된 출입구", x: 420, strokeColor: "#2563eb" }],
      fixtures: [
        { id: "fixture-1", name: "B2-L01 변경", x: 240, y: 260, size: 36 },
        { id: "fixture-free", name: "B2-L02 자유 배치", x: 640, y: 420, size: 24 }
      ]
    });
    expect(queryClient.getQueryData(["floor-fixtures", "site-2", "floor-b2"])).toMatchObject({
      pages: [{ items: [{ name: "B2-L01 변경", x: 240, y: 260, size: 36, ratedWatt: 45 }] }]
    });
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

  it("counts a changed floor plan as one revision change", async () => {
    floorEditorApi.listFloorEditorRevisions.mockResolvedValueOnce({
      items: [revision(7, { fixtureUpdates: 1, floorPlanChanged: true })],
      nextCursor: null
    });

    renderEditor();

    expect(await screen.findByText("변경 2건")).toBeInTheDocument();
  });

  it("distinguishes revision loading error and retry from an empty result", async () => {
    const firstRequest = deferred<{ items: never[]; nextCursor: null }>();
    floorEditorApi.listFloorEditorRevisions.mockReturnValueOnce(firstRequest.promise).mockResolvedValueOnce({ items: [], nextCursor: null });
    renderEditor();

    expect(screen.getByRole("status")).toHaveTextContent("버전 기록을 불러오는 중");
    firstRequest.reject(new Error("revision unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("버전 기록을 불러오지 못했습니다");

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));

    expect(await screen.findByText("저장된 버전이 없습니다.")).toBeInTheDocument();
    expect(floorEditorApi.listFloorEditorRevisions).toHaveBeenCalledTimes(2);
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
    const restored = {
      ...structuredClone(editorState),
      floor: { ...structuredClone(editorState.floor), mapRevision: 8 },
      objects: [{ ...structuredClone(editorState.objects[0]), text: "복구된 출입구" }],
      skippedFixtureIds: []
    };
    floorEditorApi.restoreFloorEditorRevision.mockResolvedValueOnce(restored);
    const { queryClient } = renderEditor();
    queryClient.setQueryData(["floor-map", "site-2", "floor-b2"], {
      floorId: "floor-b2",
      revision: 7,
      width: 1200,
      height: 800,
      floorPlan: editorState.floor.floorPlan,
      objects: editorState.objects
    });

    fireEvent.click(await screen.findByRole("button", { name: "리비전 5 복구" }));

    await waitFor(() => expect(floorEditorApi.restoreFloorEditorRevision).toHaveBeenCalledWith(
      "floor-b2",
      5,
      { expectedRevision: 7, leaseToken: "lease-token", leaseFence: 7 }
    ));
    expect(useFloorEditorStore.getState()).toMatchObject({ isDirty: false });
    expect(useFloorEditorStore.getState().initialState?.floor.mapRevision).toBe(8);
    expect(queryClient.getQueryData(["floor-map", "site-2", "floor-b2"])).toMatchObject({
      revision: 8,
      objects: [{ text: "복구된 출입구" }]
    });
  });

  it("reports fixtures skipped by a revision restore", async () => {
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
    floorEditorApi.restoreFloorEditorRevision.mockResolvedValueOnce({
      ...structuredClone(editorState),
      floor: { ...structuredClone(editorState.floor), mapRevision: 8 },
      skippedFixtureIds: ["fixture-removed"]
    });
    renderEditor();

    fireEvent.click(await screen.findByRole("button", { name: "리비전 5 복구" }));

    expect(await screen.findByRole("status")).toHaveTextContent("현재 존재하지 않는 조명 1개를 건너뛰었습니다");
  });

  it("keeps the skipped fixture notice across a same-floor editor refetch", async () => {
    floorEditorApi.listFloorEditorRevisions.mockResolvedValueOnce({ items: [revision(5)], nextCursor: null });
    floorEditorApi.restoreFloorEditorRevision.mockResolvedValueOnce({
      ...structuredClone(editorState),
      floor: { ...structuredClone(editorState.floor), mapRevision: 8 },
      skippedFixtureIds: ["fixture-removed"]
    });
    const { rerenderEditor } = renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "리비전 5 복구" }));
    expect(await screen.findByText(/현재 존재하지 않는 조명 1개/)).toBeInTheDocument();

    rerenderEditor({
      ...structuredClone(editorState),
      floor: { ...structuredClone(editorState.floor), mapRevision: 8 }
    });

    expect(screen.getByText(/현재 존재하지 않는 조명 1개/)).toBeInTheDocument();
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
    get types() { return [...values.keys()]; },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function revision(revisionNumber: number, changeSummary: Record<string, unknown> = { fixtureUpdates: 1 }) {
  return {
    revision: revisionNumber,
    snapshotSha256: `hash-${revisionNumber}`,
    changeSummary,
    restoredFromRevision: null,
    createdAt: "2026-07-20T03:00:00.000Z",
    actor: { displayName: "김관리" }
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
