import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloorEditorView } from "./FloorEditorView";
import type { FloorEditorState } from "./editor-types";
import { useFloorEditorStore } from "./editor-store";

const floorEditorApi = vi.hoisted(() => ({
  createFloorMapObject: vi.fn(() => Promise.resolve({ id: "object-created" })),
  updateEditorFixture: vi.fn(() => Promise.resolve({ id: "fixture-1" })),
  updateFloorMapObject: vi.fn(() => Promise.resolve({ id: "object-1" })),
  updateFloorPlan: vi.fn(() => Promise.resolve({ imageUrl: "/demo/floor-b2.svg", width: 1200, height: 800, version: 2 }))
}));

vi.mock("../../api/floor-editor", () => floorEditorApi);

const editorState: FloorEditorState = {
  floor: {
    id: "floor-b2",
    name: "B2",
    level: -2,
    floorPlan: { imageUrl: "/demo/floor-b2.svg", width: 1200, height: 800, version: 1 }
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
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <FloorEditorView initialState={state} onCancel={vi.fn()} onSaved={vi.fn()} {...props} />
    </QueryClientProvider>
  );
}

describe("FloorEditorView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useFloorEditorStore.setState({ state: null, activeTool: "select", zoom: 1, pan: { x: 0, y: 0 }, selection: null });
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

    fireEvent.click(screen.getByRole("button", { name: "B2-L01 정상 70%" }));
    fireEvent.change(screen.getByLabelText("조명명"), { target: { value: "B2-L01 수정" } });
    fireEvent.change(screen.getByLabelText("정격 전력"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(floorEditorApi.updateEditorFixture).toHaveBeenCalledWith("fixture-1", {
      name: "B2-L01 수정",
      ratedWatt: 45,
      x: 120,
      y: 140
    });
    expect(floorEditorApi.updateFloorMapObject).toHaveBeenCalledWith(
      "object-1",
      expect.objectContaining({ type: "text", text: "출입구", visible: true })
    );
    expect(onSaved.mock.calls[0][0].fixtures[0]).toMatchObject({ name: "B2-L01 수정", ratedWatt: 45 });
  });

  it("creates a rectangle from the toolbar by clicking the canvas and posts draft object on save", async () => {
    renderEditor({ ...editorState, objects: [] });

    fireEvent.click(screen.getByRole("button", { name: "사각형" }));
    fireEvent.click(screen.getByLabelText("B2 편집 캔버스"), { clientX: 200, clientY: 160 });

    expect(screen.getAllByText("rectangle").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("선 색상")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(floorEditorApi.createFloorMapObject).toHaveBeenCalledOnce());
    expect(floorEditorApi.createFloorMapObject).toHaveBeenCalledWith(
      "floor-b2",
      expect.objectContaining({ type: "rectangle", locked: false, visible: true })
    );
  });

  it("pans the canvas when the pan tool is dragged", () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "이동" }));
    fireEvent.mouseDown(screen.getByLabelText("B2 편집 캔버스"), { clientX: 100, clientY: 120 });
    fireEvent.mouseMove(screen.getByLabelText("B2 편집 캔버스"), { clientX: 130, clientY: 150 });

    expect(document.querySelector(".floor-editor-world")).toHaveStyle("transform: translate(30px, 30px) scale(1)");
  });
});
