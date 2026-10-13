import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FloorMapSnapshot } from "@led-control/shared";
import type { MapSceneCanvasProps } from "../map-scene/MapSceneCanvas";
import { FloorScene } from "./FloorScene";
import { FloorMapViewport } from "./FloorMapViewport";
import { FloorMapObjectNode } from "./FloorScene";
import { Layer, Stage } from "react-konva";
import Konva from "konva";
import { CustomerThemeContext } from "../../components/ui/theme/CustomerThemeProvider";
import { readThemePalette } from "../../components/ui/theme/customer-theme";

const scene = vi.hoisted(() => ({ props: null as MapSceneCanvasProps | null, modulePending: null as Promise<void> | null }));
vi.mock("../map-scene/MapSceneCanvas", () => ({ MapSceneCanvas: (props: MapSceneCanvasProps) => {
  if (scene.modulePending) throw scene.modulePending;
  scene.props = props;
  return <canvas data-testid="common-canvas" />;
} }));

const snapshot: FloorMapSnapshot = { floorId: "floor", revision: 3, width: 1600, height: 900,
  floorPlan: { sourceType: "cad", imageUrl: "/old.svg", renderedImageUrl: "/old.svg",
    originalFileUrl: null, width: 1600, height: 900, gridSize: 10 }, objects: [], fixtures: [],
  mapDocument: { formatVersion: 1, generationId: "gen", revision: 3, width: 1600, height: 900,
    gridSize: 10, elementCount: 1, manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], { user: { id: "user", organizationId: "org", role: "admin", status: "active" } });
  client.setQueryData(["dashboard", "site"], { site: { id: "site" }, floors: [{ id: "floor" }, { id: "floor-2" }],
    capabilities: { read: true, manage: true, control: true, commission: true } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450, toJSON: () => ({})
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(450);
  const press = vi.fn();
  const ui = (value = snapshot) => <QueryClientProvider client={client}><MemoryRouter initialEntries={["/monitoring?siteId=site"]}>
    <FloorMapViewport snapshot={value} ariaLabel="map"><FloorScene snapshot={value} interactive={false}
      fixtures={[{ id: "stale", name: "stale fixture", x: 1, y: 1, status: "online", brightness: 70 }]}
      onFixturePress={press} /></FloorMapViewport>
  </MemoryRouter></QueryClientProvider>;
  return { client, ui, press };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); scene.props = null; scene.modulePending = null;
  delete document.documentElement.dataset.ledControlNativeAppState;
  delete document.documentElement.dataset.ledControlMobileWebview;
});

describe("common monitoring host", () => {
  it("covers the lazy module wait and hands loading ownership to the actual common canvas", async () => {
    const { ui } = setup();
    let release!: () => void;
    scene.modulePending = new Promise<void>(resolve => { release = resolve; });
    render(ui());
    expect(await screen.findByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
    await act(async () => { scene.modulePending = null; release(); });
    await screen.findByTestId("common-canvas");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("repaints selected legacy chrome without altering the saved object color", () => {
    const object = { id: "object", type: "rectangle" as const, x: 10, y: 20, width: 40, height: 30,
      rotation: 0, strokeColor: "#111111", fillColor: "#222222", strokeWidth: 1, visible: true, locked: false, zIndex: 0 };
    const child = <Stage width={800} height={600}><Layer><FloorMapObjectNode object={object} interactive={false} selected /></Layer></Stage>;
    const value = { theme: "light" as const, setTheme() {}, persistence: "available" as const,
      palette: { ...readThemePalette(), "fixture-editor-selected": "#123456" } };
    const view = render(<CustomerThemeContext.Provider value={value}>{child}</CustomerThemeContext.Provider>);
    const node = Konva.stages.at(-1)!.findOne<Konva.Rect>(".map-object-object")!;
    expect(node.stroke()).toBe("#123456");
    view.rerender(<CustomerThemeContext.Provider value={{ ...value, theme: "dark", palette: { ...value.palette, "fixture-editor-selected": "#abcdef" } }}>{child}</CustomerThemeContext.Provider>);
    expect(node.stroke()).toBe("#abcdef"); expect(node.fill()).toBe("#222222"); expect(object.strokeColor).toBe("#111111");
  });

  it("keeps the existing common surface, selected marker, source and camera across palette publication", async () => {
    const { ui } = setup();
    const child = ui({ ...snapshot, fixtures: [{ id: "stale", name: "L1", x: 800, y: 450, size: 20 }] });
    const value = { theme: "light" as const, setTheme() {}, persistence: "available" as const, palette: readThemePalette() };
    const view = render(<CustomerThemeContext.Provider value={value}>{child}</CustomerThemeContext.Provider>);
    const canvas = await screen.findByTestId("common-canvas"), source = scene.props!.source;
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    const camera = scene.props!.camera, pin = screen.getByRole("button", { name: "L1 정상 70%" });
    view.rerender(<CustomerThemeContext.Provider value={{ ...value, theme: "dark", palette: { ...value.palette, "surface-panel": "#182334" } }}>{child}</CustomerThemeContext.Provider>);
    expect(screen.getByTestId("common-canvas")).toBe(canvas); expect(scene.props!.source).toBe(source);
    expect(scene.props!.camera).toEqual(camera); expect(screen.getByRole("button", { name: "L1 정상 70%" })).toBe(pin);
    expect(screen.getByRole("region", { name: "map" })).toHaveAttribute("data-zoom", "1.1");
  });
  it("uses only the read-only common renderer and the measured viewport, without reviving stale placements", async () => {
    const { ui } = setup(); render(ui());
    await screen.findByTestId("common-canvas");
    expect(scene.props).toMatchObject({ readOnly: true, documentRef: { generationId: "gen", revision: 3 },
      camera: { viewportWidth: 800, viewportHeight: 450, zoom: 0.5 } });
    expect(scene.props!.source.scopeKey).toContain("site");
    expect(scene.props!.source.scopeKey).toContain("user");
    expect(document.querySelector(".floor-scene-canvas")).toBeNull();
    expect(screen.queryByRole("img", { name: "층 도면" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stale fixture/ })).not.toBeInTheDocument();
  });

  it("keeps fixture status and selection separate from saved geometry", async () => {
    const { ui, press } = setup(); render(ui({ ...snapshot, fixtures: [{ id: "stale", name: "L1", x: 800, y: 450, size: 20 }] }));
    await screen.findByTestId("common-canvas");
    const marker = screen.getByRole("button", { name: "L1 정상 70%" });
    fireEvent.click(marker);
    expect(press).toHaveBeenCalledWith("stale", marker);
  });

  it("preserves source identity across revisions but replaces it on floor or permission changes", async () => {
    const { ui, client } = setup(); const view = render(ui());
    await screen.findByTestId("common-canvas"); const first = scene.props!.source;
    view.rerender(ui({ ...snapshot, revision: 4, mapDocument: { ...snapshot.mapDocument!, revision: 4 } }));
    expect(scene.props!.source).toBe(first);
    expect(scene.props!.documentRef.revision).toBe(4);
    view.rerender(ui({ ...snapshot, floorId: "floor-2" }));
    await waitFor(() => expect(scene.props!.source).not.toBe(first));
    const second = scene.props!.source;
    await act(async () => { client.setQueryData(["auth", "me"], { user: { id: "user", organizationId: "org", role: "viewer", status: "active" } }); });
    await waitFor(() => expect(scene.props!.source).not.toBe(second));
  });

  it.each(["onError", "onDegraded"])("fails visibly on %s without legacy fallback and retries with a new source", async callback => {
    const { ui, client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(ui()); await screen.findByTestId("common-canvas");
    const first = scene.props!.source;
    act(() => {
      if (callback === "onError") scene.props!.onError?.(new Error("forbidden"));
      else scene.props!.onDegraded?.({ requestedTileCount: 2, renderedTileCount: 0, reason: "memory-budget" });
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("common-canvas")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "층 도면" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "맵 다시 불러오기" }));
    await screen.findByTestId("common-canvas");
    expect(scene.props!.source).not.toBe(first);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-map", "site", "floor"], exact: true });
  });

  it("fits a replacement generation but preserves zoom for an ordinary saved revision", async () => {
    const { ui } = setup(); const view = render(ui());
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    expect(screen.getByRole("region", { name: "map" })).toHaveAttribute("data-zoom", "1.1");
    view.rerender(ui({ ...snapshot, revision: 4, mapDocument: { ...snapshot.mapDocument!, revision: 4 } }));
    expect(screen.getByRole("region", { name: "map" })).toHaveAttribute("data-zoom", "1.1");
    view.rerender(ui({ ...snapshot, mapDocument: { ...snapshot.mapDocument!, generationId: "replacement" } }));
    expect(screen.getByRole("region", { name: "map" })).toHaveAttribute("data-zoom", "1");
  });

  it("does not mount in a background WebView and recreates its source on resume", async () => {
    document.documentElement.dataset.ledControlMobileWebview = "true";
    document.documentElement.dataset.ledControlNativeAppState = "background";
    const { ui } = setup(); render(ui());
    expect(screen.queryByTestId("common-canvas")).not.toBeInTheDocument();
    act(() => { window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: "active" } })); });
    await screen.findByTestId("common-canvas");
    expect(scene.props!.platform).toBe("mobile");
    const first = scene.props!.source;
    act(() => { window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: "background" } })); });
    expect(screen.queryByTestId("common-canvas")).not.toBeInTheDocument();
    act(() => { window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: "active" } })); });
    await screen.findByTestId("common-canvas");
    expect(scene.props!.source).not.toBe(first);
  });
});
