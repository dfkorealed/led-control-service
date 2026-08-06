import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FloorEditorState } from "../../floor-editor/editor-types";
import { dirtyEditorSentinelKey } from "../../floor-editor/dirty-editor-history";
import { useFloorEditorStore } from "../../floor-editor/editor-store";
import { FloorEditorRoute } from "./FloorEditorRoute";

const floorEditorApi = vi.hoisted(() => ({
  getFloorEditorState: vi.fn(),
  acquireFloorEditorLease: vi.fn(),
  releaseFloorEditorLease: vi.fn()
}));
const { getFloorEditorState, acquireFloorEditorLease, releaseFloorEditorLease } = floorEditorApi;

vi.mock("../../../api/floor-editor", () => floorEditorApi);
vi.mock("../../floor-editor/FloorEditorView", () => ({
  FloorEditorView: ({ initialState, onCancel, onSaved, onDirtyChange, readOnly = false }: {
    initialState: FloorEditorState;
    onCancel: () => void;
    onSaved: (state: FloorEditorState) => void;
    onDirtyChange: (dirty: boolean) => void;
    readOnly?: boolean;
  }) => (
    <section>
      <h2>{initialState.floor.name} 도면 편집</h2>
      <output data-testid="lease-read-only">{String(readOnly)}</output>
      <LocationProbe />
      <button onClick={() => onDirtyChange(true)}>수정</button>
      <button onClick={() => onDirtyChange(false)}>변경 되돌리기</button>
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
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Link to="/settings/security?siteId=site-2">보안 이동</Link>
          <Routes>
            <Route path="/settings" element={<><h2>설정 개요</h2><LocationProbe /></>} />
            <Route path="/settings/floor-plans" element={<><h2>도면 관리</h2><LocationProbe /></>} />
            <Route path="/settings/security" element={<><h2>보안 설정</h2><LocationProbe /></>} />
            <Route path="/settings/floor-plans/:floorId/edit" element={<FloorEditorRoute userRole="admin" />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>
  );
}

function renderFloorTransitionRoute() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/settings/floor-plans/floor-b2/edit?siteId=site-2"]}>
        <FloorTransitionControl />
        <Routes>
          <Route path="/settings/floor-plans/:floorId/edit" element={<FloorEditorRoute userRole="admin" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function FloorTransitionControl() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/settings/floor-plans/floor-b3/edit?siteId=site-3")}>B3로 이동</button>;
}

describe("FloorEditorRoute", () => {
  beforeEach(() => {
    acquireFloorEditorLease.mockResolvedValue({ editable: true, token: "test-lease-token", holderName: "김관리" });
    releaseFloorEditorLease.mockResolvedValue({ released: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
    useFloorEditorStore.setState({ initialState: null, state: null, isDirty: false, selection: null });
  });

  it("switches an editor to read-only when another user holds the floor lease", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    acquireFloorEditorLease.mockResolvedValue({
      editable: false,
      holderName: "김관리",
      acquiredAt: "2026-08-06T00:00:00.000Z"
    });

    renderRoute("admin");

    expect(await screen.findByRole("alert")).toHaveTextContent("김관리");
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");
  });

  it("releases the acquired lease when the editor route unmounts normally", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    acquireFloorEditorLease.mockResolvedValue({ editable: true, token: "lease-token", holderName: "김관리" });
    const { unmount } = renderRoute("admin");

    await screen.findByRole("heading", { name: "B2 도면 편집" });
    await waitFor(() => expect(acquireFloorEditorLease).toHaveBeenCalledWith("floor-b2"));
    unmount();

    await waitFor(() => expect(releaseFloorEditorLease).toHaveBeenCalledWith("floor-b2", "lease-token"));
  });

  it("serializes pending heartbeats and keeps a lost lease read-only", async () => {
    vi.useFakeTimers();
    getFloorEditorState.mockResolvedValue(editorState);
    const pendingHeartbeat = deferred<{ editable: boolean; token?: string; holderName?: string }>();
    acquireFloorEditorLease
      .mockResolvedValueOnce({ editable: true, token: "lease-token", holderName: "김관리" })
      .mockReturnValueOnce(pendingHeartbeat.promise);
    renderRoute("admin");

    await act(async () => {});
    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(2);

    pendingHeartbeat.reject(new Error("lease unavailable"));
    await act(async () => {});
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(2);
  });

  it("fails closed before Redis expiry when a heartbeat remains pending and ignores its late success", async () => {
    vi.useFakeTimers();
    getFloorEditorState.mockResolvedValue(editorState);
    const pendingHeartbeat = deferred<{ editable: boolean; token?: string; holderName?: string }>();
    acquireFloorEditorLease
      .mockResolvedValueOnce({ editable: true, token: "lease-token", holderName: "김관리" })
      .mockReturnValueOnce(pendingHeartbeat.promise);
    const { unmount } = renderRoute("admin");

    await act(async () => {});
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("false");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(2);

    pendingHeartbeat.resolve({ editable: true, token: "lease-token", holderName: "김관리" });
    await act(async () => {});
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(2);

    unmount();
    expect(releaseFloorEditorLease).not.toHaveBeenCalled();
  });

  it("releases a token from an initial acquire that arrives after its request deadline", async () => {
    vi.useFakeTimers();
    let currentTime = 0;
    vi.spyOn(performance, "now").mockImplementation(() => currentTime);
    getFloorEditorState.mockResolvedValue(editorState);
    const delayedAcquire = deferred<{ editable: boolean; token?: string; holderName?: string }>();
    acquireFloorEditorLease.mockReturnValueOnce(delayedAcquire.promise);
    renderRoute("admin");

    await act(async () => {});
    currentTime = 80_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    delayedAcquire.resolve({ editable: true, token: "late-token", holderName: "김관리" });
    await act(async () => {});

    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(1);
    expect(releaseFloorEditorLease).toHaveBeenCalledWith("floor-b2", "late-token");
  });

  it("uses a renewal request deadline despite a delayed success and stalled next renewal", async () => {
    vi.useFakeTimers();
    let currentTime = 0;
    vi.spyOn(performance, "now").mockImplementation(() => currentTime);
    getFloorEditorState.mockResolvedValue(editorState);
    const delayedRenewal = deferred<{ editable: boolean; token?: string; holderName?: string }>();
    const stalledRenewal = deferred<{ editable: boolean; token?: string; holderName?: string }>();
    acquireFloorEditorLease
      .mockResolvedValueOnce({ editable: true, token: "lease-token", holderName: "김관리" })
      .mockReturnValueOnce(delayedRenewal.promise)
      .mockReturnValueOnce(stalledRenewal.promise);
    renderRoute("admin");

    await act(async () => {});
    currentTime = 30_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(2);

    currentTime = 70_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    delayedRenewal.resolve({ editable: true, token: "lease-token", holderName: "김관리" });
    await act(async () => {});
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("false");

    currentTime = 90_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(3);
    currentTime = 110_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");

    stalledRenewal.resolve({ editable: true, token: "lease-token", holderName: "김관리" });
    await act(async () => {});
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");
    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(3);
  });

  it("does not replace an expired prior deadline when a renewal completion is delivered late", async () => {
    vi.useFakeTimers();
    let currentTime = 0;
    vi.spyOn(performance, "now").mockImplementation(() => currentTime);
    getFloorEditorState.mockResolvedValue(editorState);
    const delayedRenewal = deferred<{ editable: boolean; token?: string; holderName?: string }>();
    acquireFloorEditorLease
      .mockResolvedValueOnce({ editable: true, token: "lease-token", holderName: "김관리" })
      .mockReturnValueOnce(delayedRenewal.promise);
    renderRoute("admin");

    await act(async () => {});
    currentTime = 30_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    currentTime = 90_000;
    delayedRenewal.resolve({ editable: true, token: "lease-token", holderName: "김관리" });
    await act(async () => {});

    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");
  });

  it("does not let a stale floor acquisition clear the new floor's releasable token", async () => {
    getFloorEditorState.mockImplementation((floorId: string) => Promise.resolve(
      floorId === "floor-b2" ? editorState : {
        ...editorState,
        floor: { ...editorState.floor, id: "floor-b3", siteId: "site-3", name: "B3", level: -3 }
      }
    ));
    const staleAcquire = deferred<{ editable: boolean; token?: string; holderName?: string }>();
    acquireFloorEditorLease
      .mockReturnValueOnce(staleAcquire.promise)
      .mockResolvedValueOnce({ editable: true, token: "b3-token", holderName: "김관리" });
    const { unmount } = renderFloorTransitionRoute();

    await waitFor(() => expect(acquireFloorEditorLease).toHaveBeenCalledWith("floor-b2"));
    fireEvent.click(screen.getByRole("button", { name: "B3로 이동" }));
    await screen.findByRole("heading", { name: "B3 도면 편집" });
    await waitFor(() => expect(acquireFloorEditorLease).toHaveBeenCalledWith("floor-b3"));
    staleAcquire.reject(new Error("old floor unavailable"));
    await act(async () => {});
    unmount();

    await waitFor(() => expect(releaseFloorEditorLease).toHaveBeenCalledWith("floor-b3", "b3-token"));
  });

  it("cancels the old floor deadline when moving to another editable floor", async () => {
    vi.useFakeTimers();
    getFloorEditorState.mockImplementation((floorId: string) => Promise.resolve(
      floorId === "floor-b2" ? editorState : {
        ...editorState,
        floor: { ...editorState.floor, id: "floor-b3", siteId: "site-3", name: "B3", level: -3 }
      }
    ));
    acquireFloorEditorLease
      .mockResolvedValueOnce({ editable: true, token: "b2-token", holderName: "김관리" })
      .mockResolvedValueOnce({ editable: true, token: "b3-token", holderName: "김관리" })
      .mockResolvedValue({ editable: true, token: "b3-token", holderName: "김관리" });
    const { unmount } = renderFloorTransitionRoute();

    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    fireEvent.click(screen.getByRole("button", { name: "B3로 이동" }));
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "B3 도면 편집" })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(70_000); });
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("false");
    unmount();
    expect(releaseFloorEditorLease).toHaveBeenCalledWith("floor-b3", "b3-token");
  });

  it("retries an initial same-floor conflict after delayed cleanup release without reviving a lost token", async () => {
    vi.useFakeTimers();
    getFloorEditorState.mockResolvedValue(editorState);
    const delayedRelease = deferred<{ released: boolean }>();
    releaseFloorEditorLease.mockReturnValueOnce(delayedRelease.promise);
    acquireFloorEditorLease
      .mockResolvedValueOnce({ editable: true, token: "old-token", holderName: "김관리" })
      .mockResolvedValueOnce({ editable: false, holderName: "김관리" })
      .mockResolvedValueOnce({ editable: true, token: "new-token", holderName: "김관리" });
    const firstRoute = renderRoute("admin");

    await act(async () => {});
    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    firstRoute.unmount();
    const secondRoute = renderRoute("admin");
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("true");

    delayedRelease.resolve({ released: true });
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(acquireFloorEditorLease).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("lease-read-only")).toHaveTextContent("false");
    secondRoute.unmount();
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
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeTruthy());

    act(() => window.history.back());
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeTruthy());
    expect(screen.getByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/floor-plans/floor-b2/edit");
    expect(useFloorEditorStore.getState().state?.floor.name).toBe("작성 중");

    act(() => window.history.back());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeTruthy());

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
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeTruthy());

    act(() => window.history.back());

    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledOnce();
    expect(useFloorEditorStore.getState()).toMatchObject({ state: editorState, initialState: editorState, isDirty: false });
  });

  it("replaces the dirty sentinel on save so consecutive backs visit editor then the previous route", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm");
    useFloorEditorStore.getState().initialize(editorState);
    renderBrowserRoute();
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeTruthy());
    act(() => useFloorEditorStore.getState().adoptBaseline(editorState));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();

    act(() => window.history.back());

    expect(await screen.findByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("replaces the dirty sentinel after confirmed cancel", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderBrowserRoute();
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(await screen.findByRole("heading", { name: "도면 관리" })).toBeInTheDocument();
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("replaces the dirty sentinel after confirmed internal navigation", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderBrowserRoute();
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeTruthy());

    fireEvent.click(screen.getByRole("link", { name: "보안 이동" }));
    expect(await screen.findByRole("heading", { name: "보안 설정" })).toBeInTheDocument();
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("consumes the dirty sentinel when the same editor becomes clean", async () => {
    getFloorEditorState.mockResolvedValue(editorState);
    const confirm = vi.spyOn(window, "confirm");
    renderBrowserRoute();
    await screen.findByRole("heading", { name: "B2 도면 편집" });
    fireEvent.click(screen.getByRole("button", { name: "수정" }));
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "변경 되돌리기" }));
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeUndefined());
    act(() => window.history.back());

    expect(await screen.findByRole("heading", { name: "설정 개요" })).toBeInTheDocument();
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
    await waitFor(() => expect(window.history.state?.[dirtyEditorSentinelKey]).toBeUndefined());
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));

    expect(event.defaultPrevented).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

function dirtyGuardIsActive() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
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
