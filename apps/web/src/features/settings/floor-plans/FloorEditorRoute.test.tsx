import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FloorEditorState } from "../../floor-editor/editor-types";
import { useFloorEditorStore } from "../../floor-editor/editor-store";
import { FloorEditorRoute } from "./FloorEditorRoute";

const getFloorEditorState = vi.hoisted(() => vi.fn());
const dirtySentinelKey = "__floorEditorDirtySentinel";

vi.mock("../../../api/floor-editor", () => ({ getFloorEditorState }));
vi.mock("../../floor-editor/FloorEditorView", () => ({
  FloorEditorView: ({ initialState, onCancel, onSaved, onDirtyChange }: {
    initialState: FloorEditorState;
    onCancel: () => void;
    onSaved: (state: FloorEditorState) => void;
    onDirtyChange: (dirty: boolean) => void;
  }) => (
    <section>
      <h2>{initialState.floor.name} 도면 편집</h2>
      <LocationProbe />
      <button onClick={() => onDirtyChange(true)}>수정</button>
      <button onClick={onCancel}>취소</button>
      <button onClick={() => { onDirtyChange(false); onSaved(initialState); }}>저장</button>
    </section>
  )
}));

const editorState: FloorEditorState = {
  floor: {
    id: "floor-b2",
    siteId: "site-2",
    name: "B2",
    level: -2,
    mapRevision: 7,
    floorPlan: {
      imageUrl: "/demo/floor-b2.svg", sourceType: "image",
      originalFileUrl: "/demo/floor-b2.svg", renderedImageUrl: "/demo/floor-b2.svg",
      width: 1200, height: 800, version: 1
    }
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
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Link to="/settings?siteId=site-2">설정 이동</Link>
        <Routes>
          <Route path="/settings" element={<><h2>설정 개요</h2><LocationProbe /></>} />
          <Route path="/settings/floor-plans" element={<><h2>도면 관리</h2><LocationProbe /></>} />
          <Route path="/settings/floor-plans/:floorId/edit" element={<FloorEditorRoute userRole={userRole} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, queryClient };
}

function renderBrowserRoute() {
  window.history.replaceState({}, "", "/settings?siteId=site-2");
  window.history.pushState({}, "", "/settings/floor-plans/floor-b2/edit?siteId=site-2");
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/settings" element={<><h2>설정 개요</h2><LocationProbe /></>} />
          <Route path="/settings/floor-plans" element={<><h2>도면 관리</h2><LocationProbe /></>} />
          <Route path="/settings/floor-plans/:floorId/edit" element={<FloorEditorRoute userRole="admin" />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

describe("FloorEditorRoute", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
    useFloorEditorStore.setState({ initialState: null, state: null, isDirty: false, selection: null });
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

  it("scopes the editor query by site and floor", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const { queryClient } = renderRoute("operator");

    await screen.findByRole("heading", { name: "B2 도면 편집" });

    expect(queryClient.getQueryData(["floor-editor", "site-2", "floor-b2"])).toEqual(editorState);
  });

  it("canonicalizes a direct editor URL without siteId from the editor response", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const { queryClient } = renderRoute("operator", "/settings/floor-plans/floor-b2/edit");

    await waitFor(() => expect(queryClient.getQueryData(["floor-editor", "site-2", "floor-b2"])).toEqual(editorState));
    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans/floor-b2/edit?siteId=site-2");
  });

  it("does not show an editor when the selected site does not own the floor", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    renderRoute("admin", "/settings/floor-plans/floor-b2/edit?siteId=site-1");

    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/floor-plans?siteId=site-1");
    expect(screen.queryByRole("heading", { name: "B2 도면 편집" })).not.toBeInTheDocument();
  });

  it("blocks a viewer's direct edit URL before loading editor state", async () => {
    renderRoute("viewer");

    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "B2 도면 편집" })).not.toBeInTheDocument();
    expect(getFloorEditorState).not.toHaveBeenCalled();
  });

  it("blocks an internal route while dirty and allows it after confirmation", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderRoute("admin");
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));

    fireEvent.click(screen.getByRole("link", { name: "설정 이동" }));
    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledOnce();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: "설정 이동" }));
    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/settings?siteId=site-2");
  });

  it("requires confirmation for dirty cancel but not after save", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderRoute("operator");
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("registers a beforeunload guard only while dirty", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    renderRoute("admin");
    await screen.findByRole("heading", { name: "B2 도면 편집" });

    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => {
      const dirtyEvent = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(dirtyEvent);
      expect(dirtyEvent.defaultPrevented).toBe(true);
    });
  });

  it("keeps the same editor route and draft across repeated cancelled browser backs", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    useFloorEditorStore.getState().initialize(editorState);
    useFloorEditorStore.setState({ state: { ...editorState, floor: { ...editorState.floor, name: "작성 중" } }, isDirty: true });
    renderBrowserRoute();
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => expect(window.history.state?.[dirtySentinelKey]).toBeTruthy());

    act(() => window.history.back());
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.history.state?.[dirtySentinelKey]).toBeTruthy());
    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/floor-plans/floor-b2/edit");
    expect(useFloorEditorStore.getState().state?.floor.name).toBe("작성 중");

    act(() => window.history.back());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(window.history.state?.[dirtySentinelKey]).toBeTruthy());

    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(getFloorEditorState).toHaveBeenCalledOnce();
    expect(useFloorEditorStore.getState().state?.floor.name).toBe("작성 중");
  });

  it("discards the draft and performs the real back after browser approval", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    useFloorEditorStore.getState().initialize(editorState);
    useFloorEditorStore.setState({ state: { ...editorState, floor: { ...editorState.floor, name: "작성 중" } }, isDirty: true });
    renderBrowserRoute();
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => expect(window.history.state?.[dirtySentinelKey]).toBeTruthy());

    act(() => window.history.back());

    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledOnce();
    expect(useFloorEditorStore.getState()).toMatchObject({ state: editorState, initialState: editorState, isDirty: false });
  });

  it("allows browser back without confirmation after save", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm");
    useFloorEditorStore.getState().initialize(editorState);
    renderBrowserRoute();
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => expect(window.history.state?.[dirtySentinelKey]).toBeTruthy());
    act(() => useFloorEditorStore.getState().adoptBaseline(editorState));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();

    act(() => window.history.back());

    expect(await screen.findByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("removes popstate and beforeunload guards on cleanup", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { unmount } = renderBrowserRoute();
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => expect(dirtyGuardIsActive()).toBe(true));

    unmount();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    act(() => window.history.back());

    expect(event.defaultPrevented).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

function dirtyGuardIsActive() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
