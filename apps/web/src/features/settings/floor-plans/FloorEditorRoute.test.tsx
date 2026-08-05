import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FloorEditorState } from "../../floor-editor/editor-types";
import { FloorEditorRoute } from "./FloorEditorRoute";

const getFloorEditorState = vi.hoisted(() => vi.fn());

vi.mock("../../../api/floor-editor", () => ({ getFloorEditorState }));
vi.mock("../../floor-editor/FloorEditorView", () => ({
  FloorEditorView: ({ initialState, onCancel, onSaved }: {
    initialState: FloorEditorState;
    onCancel: () => void;
    onSaved: (state: FloorEditorState) => void;
  }) => (
    <section>
      <h2>{initialState.floor.name} 도면 편집</h2>
      <button onClick={onCancel}>취소</button>
      <button onClick={() => onSaved(initialState)}>저장</button>
    </section>
  )
}));

const editorState: FloorEditorState = {
  floor: {
    id: "floor-b2",
    name: "B2",
    level: -2,
    floorPlan: { imageUrl: "/demo/floor-b2.svg", width: 1200, height: 800, version: 1 }
  },
  fixtures: [],
  objects: []
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderRoute(userRole: "operator" | "admin" | "viewer", initialEntry = "/settings/floor-plans/floor-b2/edit?siteId=site-2") {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/settings/floor-plans" element={<><h2>도면 관리</h2><LocationProbe /></>} />
          <Route path="/settings/floor-plans/:floorId/edit" element={<FloorEditorRoute userRole={userRole} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("FloorEditorRoute", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each(["저장", "취소"])("returns an admin to the selected site's list after %s", async (action) => {
    getFloorEditorState.mockResolvedValue(editorState);
    renderRoute("admin");

    expect(await screen.findByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(getFloorEditorState).toHaveBeenCalledWith("floor-b2");

    fireEvent.click(screen.getByRole("button", { name: action }));

    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-2");
  });

  it("blocks a viewer's direct edit URL before loading editor state", async () => {
    renderRoute("viewer");

    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "B2 도면 편집" })).not.toBeInTheDocument();
    expect(getFloorEditorState).not.toHaveBeenCalled();
  });
});
