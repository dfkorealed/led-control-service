import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FloorMapSnapshot } from "@led-control/shared";
import type { MapSceneCanvasProps } from "../map-scene/MapSceneCanvas";
import { FloorScene } from "./FloorScene";
import { FloorMapViewport } from "./FloorMapViewport";

const scene = vi.hoisted(() => ({ props: null as MapSceneCanvasProps | null }));
vi.mock("../map-scene/MapSceneCanvas", () => ({ MapSceneCanvas: (props: MapSceneCanvasProps) => {
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); scene.props = null;
  delete document.documentElement.dataset.ledControlNativeAppState;
  delete document.documentElement.dataset.ledControlMobileWebview;
});

describe("common monitoring host", () => {
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

  it("fails visibly without legacy fallback and retries with a new source", async () => {
    const { ui, client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(ui()); await screen.findByTestId("common-canvas");
    const first = scene.props!.source;
    act(() => scene.props!.onError?.(new Error("forbidden")));
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
