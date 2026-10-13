import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CAD_SCENE_TILE_SIZE, normalizeCadMapSize, type CadSceneTile, type FloorMapSnapshot } from "@led-control/shared";
import Konva from "konva";
import { Layer, Stage } from "react-konva";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloorMapObjectNode, FloorScene } from "./FloorScene";
import { FloorMapViewport } from "./FloorMapViewport";

const cadRenderer = vi.hoisted(() => {
  const paints: Array<() => void> = [];
  let deferPaint = false;
  const instances: Array<{
    options: Record<string, unknown>;
    mount: ReturnType<typeof vi.fn>;
    setCamera: ReturnType<typeof vi.fn>;
    setLayerStates: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  class MockCadSceneRenderer {
    mount = vi.fn(async (_canvas: HTMLCanvasElement) => undefined);
    setCamera = vi.fn(() => deferPaint ? new Promise<void>(resolve => paints.push(resolve)) : Promise.resolve());
    setLayerStates = vi.fn();
    destroy = vi.fn();

    constructor(public readonly options: Record<string, unknown>) {
      instances.push(this);
    }
  }
  return { instances, MockCadSceneRenderer, paints, defer(value: boolean) { deferPaint = value; } };
});

const cadOverrideRuntime = vi.hoisted(() => ({
  overrideMaps: [] as Array<Map<string, unknown>>,
  worker: { decode: vi.fn(), destroy: vi.fn() },
  createCadSceneWorkerClient: vi.fn(() => ({ decode: vi.fn(), destroy: vi.fn() })),
  createCadOverrideWorker: vi.fn((_worker: unknown, getOverrides: () => ReadonlyMap<string, unknown>) => {
    cadOverrideRuntime.overrideMaps.push(new Map(getOverrides()));
    return cadOverrideRuntime.worker;
  })
}));

vi.mock("../cad-scene/CadSceneRenderer", () => ({
  CadSceneRenderer: cadRenderer.MockCadSceneRenderer
}));

vi.mock("../cad-scene/cad-scene-worker", () => ({
  createCadSceneWorkerClient: cadOverrideRuntime.createCadSceneWorkerClient
}));

vi.mock("../floor-editor/cad-editor-runtime", () => ({
  createCadOverrideWorker: cadOverrideRuntime.createCadOverrideWorker
}));

const snapshot: FloorMapSnapshot = {
  floorId: "00000000-0000-4000-8000-000000000003",
  revision: 3,
  width: 1200,
  height: 800,
  floorPlan: null,
  objects: [{
    id: "rectangle-1",
    type: "rectangle",
    x: 40,
    y: 60,
    width: 200,
    height: 100,
    rotation: 0,
    points: null,
    text: null,
    strokeColor: "#0b63e5",
    fillColor: "#dbeafe",
    strokeWidth: 2,
    fontSize: null,
    zIndex: 1,
    locked: false,
    visible: true
  }]
};

it("keeps filtered pins selectable and exposes only unknown state for unobserved pins", () => {
  const onAnchor = vi.fn();
  const onPress = vi.fn();
  const { unmount } = render(<FloorScene snapshot={{ ...snapshot, fixtures: [{ id: "unknown", name: "미조회", x: 200, y: 300, size: 20 }] }}
    fixtures={[]} interactive={false} emphasizedFixtureIds={new Set()} unobservedFixtureIds={new Set(["unknown"])}
    onFixtureAnchorChange={onAnchor} onFixturePress={onPress} />);
  const marker = screen.getByRole("button", { name: "미조회 조명 정보 확인 전" });
  expect(marker).not.toHaveAttribute("aria-label", expect.stringContaining("0%"));
  expect(marker).toHaveClass("opacity-30");
  expect(marker).toBeEnabled();
  fireEvent.click(marker);
  expect(onPress).toHaveBeenCalledWith("unknown", marker);
  expect(onAnchor).toHaveBeenCalledWith("unknown", marker);
  unmount();
  expect(onAnchor).toHaveBeenLastCalledWith("unknown", null);
});

describe("FloorScene", () => {
  it.each([false, true])("waits for automatic first legacy layer paint without a background (empty=%s)", async empty => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 500));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    let blocked = true, actualPaints = 0;
    const drawScene = Konva.Layer.prototype.drawScene;
    vi.spyOn(Konva.Layer.prototype, "drawScene").mockImplementation(function (this: Konva.Layer, ...args) {
      if (blocked) return this;
      actualPaints++;
      return drawScene.apply(this, args);
    });
    const value = { ...snapshot, objects: empty ? [] : snapshot.objects, fixtures: [] };
    const scene = (data: FloorMapSnapshot) => <FloorMapViewport snapshot={data} ariaLabel="legacy map"><FloorScene snapshot={data} fixtures={[]} interactive={false} /></FloorMapViewport>;
    const view = render(scene(value));
    expect(screen.getByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
    expect(actualPaints).toBe(0);
    // Allow Konva's already scheduled frame to paint; never call draw in the test.
    blocked = false;
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(actualPaints).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    view.rerender(scene({ ...value, floorId: "same-geometry-next-floor" }));
    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("waits for current viewport CAD paint after mount and never reloads the overlay during later zoom", async () => {
    const value = createCadSnapshot();
    cadRenderer.defer(true);
    vi.stubGlobal("fetch", createSuccessfulCadFetch(value));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 500));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    render(<FloorMapViewport snapshot={value} ariaLabel="CAD 지도"><FloorScene snapshot={value} fixtures={[]} interactive={false} /></FloorMapViewport>);
    await waitFor(() => expect(cadRenderer.paints).toHaveLength(1));
    expect(screen.getByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    await waitFor(() => expect(cadRenderer.paints).toHaveLength(2));
    await act(async () => cadRenderer.paints[0]());
    expect(screen.getByRole("status")).toBeInTheDocument();
    await act(async () => cadRenderer.paints[1]());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "지도 확대" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("uses first-paint loading for legacy images and fences replaced image events", () => {
    const value = { ...snapshot, floorPlan: { sourceType: "image" as const, imageUrl: "/plan-a.svg",
      width: 1200, height: 800, gridSize: 10, originalFileUrl: null, renderedImageUrl: null } };
    const scene = (data: FloorMapSnapshot) => <FloorMapViewport snapshot={data} ariaLabel="legacy map"><FloorScene snapshot={data} fixtures={[]} interactive={false} /></FloorMapViewport>;
    const view = render(scene(value));
    expect(screen.getByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
    const old = screen.getByRole("img", { name: "층 도면" });
    fireEvent.load(old);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(scene({ ...value, floorPlan: { ...value.floorPlan, imageUrl: "/plan-b.svg" } }));
    fireEvent.load(old);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.error(screen.getByRole("img", { name: "층 도면" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("resolves a native pointer received by an overlapping disabled neighbour to the current intended anchor", () => {
    const { center, disabled, onPress } = renderOverlappingMarkers();
    dispatchScenePointer(disabled, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchScenePointer(disabled, "pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith("center", center);
    expect(center).toHaveFocus();
  });

  it.each(["touch", "mouse"])("manual-cad %s navigation from a real marker pans without pointerup selection and permits the next tap", pointerType => {
    const { center, disabled, onPress } = renderOverlappingMarkers(true);
    const viewport = screen.getByRole("region", { name: "manual integration" });
    dispatchScenePointer(center, "pointerdown", { pointerId: 1, pointerType, button: pointerType === "mouse" ? 1 : 0, clientX: 100, clientY: 100 });
    dispatchScenePointer(center, "pointermove", { pointerId: 1, pointerType, clientX: 80, clientY: 100 });
    dispatchScenePointer(center, "pointerup", { pointerId: 1, pointerType, clientX: 80, clientY: 100 });
    fireEvent.click(center, { detail: 1 });
    expect(viewport.scrollLeft).toBe(20); expect(onPress).not.toHaveBeenCalled();
    dispatchScenePointer(disabled, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    dispatchScenePointer(disabled, "pointerup", { pointerId: 2, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    expect(onPress).toHaveBeenCalledWith("center", center);
  });

  it("manual-cad stationary Space navigation does not select a real marker or poison the next tap", () => {
    const { center, disabled, onPress } = renderOverlappingMarkers(true);
    const viewport = screen.getByRole("region", { name: "manual integration" });
    fireEvent.keyDown(viewport, { key: " " });
    dispatchScenePointer(center, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    dispatchScenePointer(center, "pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fireEvent.keyUp(viewport, { key: " " });
    expect(onPress).not.toHaveBeenCalled();
    dispatchScenePointer(disabled, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    dispatchScenePointer(disabled, "pointerup", { pointerId: 2, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    expect(onPress).toHaveBeenCalledWith("center", center);
    onPress.mockClear();
    fireEvent.click(center, { detail: 0 }); expect(onPress).toHaveBeenCalledWith("center", center);
  });

  it.each(["pointercancel", "lostpointercapture", "blur", "Escape", "second-pointer", "drag8"])("cancels an overlapping operational press on %s and consumes its physical ghost click", (reason) => {
    const { center, disabled, onPress } = renderOverlappingMarkers();
    dispatchScenePointer(disabled, "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "second-pointer") dispatchScenePointer(disabled, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 140, clientY: 100 });
    else if (reason === "drag8") dispatchScenePointer(disabled, "pointermove", { pointerId: 1, pointerType: "touch", clientX: 108, clientY: 100 });
    else fireEvent(window, new Event(reason));
    dispatchScenePointer(disabled, "pointerup", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    fireEvent.click(center, { detail: 1 });
    expect(onPress).not.toHaveBeenCalled();
  });

  it("does not promote a disabled center and retains native keyboard activation", () => {
    const { center, disabled, onPress } = renderOverlappingMarkers();
    dispatchScenePointer(disabled, "pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 107 });
    dispatchScenePointer(disabled, "pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 107 });
    expect(onPress).not.toHaveBeenCalled();
    fireEvent.click(center, { detail: 0 });
    expect(onPress).toHaveBeenCalledWith("center", center);
    expect(disabled).toBeDisabled();
  });

  it("re-measures camera geometry and rejects a press whose saved snapshot scope changed", () => {
    const { center, disabled, onPress, rerender, fixtures, sceneSelection } = renderOverlappingMarkers();
    vi.spyOn(center, "getBoundingClientRect").mockReturnValue(new DOMRect(276, 176, 48, 48));
    vi.spyOn(disabled, "getBoundingClientRect").mockReturnValue(new DOMRect(276, 183, 48, 48));
    dispatchScenePointer(disabled, "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 300, clientY: 200 });
    dispatchScenePointer(disabled, "pointerup", { pointerId: 1, pointerType: "touch", button: 0, clientX: 300, clientY: 200 });
    expect(onPress).toHaveBeenCalledWith("center", center);
    onPress.mockClear();
    dispatchScenePointer(disabled, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 300, clientY: 200 });
    rerender(<FloorScene snapshot={{ ...snapshot, revision: snapshot.revision + 1 }} fixtures={fixtures} selection={sceneSelection} interactive={false} coarsePointer onFixturePress={onPress} />);
    dispatchScenePointer(disabled, "pointerup", { pointerId: 2, pointerType: "touch", button: 0, clientX: 300, clientY: 200 });
    fireEvent.click(center, { detail: 1 });
    expect(onPress).not.toHaveBeenCalled();
  });

  it("does not select through an overlay or revive a press after unmount", () => {
    const { center, disabled, onPress, unmount } = renderOverlappingMarkers();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
    dispatchScenePointer(disabled, "pointerdown", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    dispatchScenePointer(disabled, "pointerup", { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    expect(onPress).not.toHaveBeenCalled();
    dispatchScenePointer(center, "pointerdown", { pointerId: 2, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    unmount();
    dispatchScenePointer(center, "pointerup", { pointerId: 2, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    expect(onPress).not.toHaveBeenCalled();
  });

  afterEach(() => {
    cleanup();
    cadRenderer.defer(false);
    cadRenderer.paints.length = 0;
    vi.restoreAllMocks();
    cadRenderer.instances.length = 0;
    cadOverrideRuntime.overrideMaps.length = 0;
    cadOverrideRuntime.createCadSceneWorkerClient.mockClear();
    cadOverrideRuntime.createCadOverrideWorker.mockClear();
    delete document.documentElement.dataset.ledControlMobileWebview;
    delete document.documentElement.dataset.ledControlNativeAppState;
    Reflect.deleteProperty(document, "elementFromPoint");
    vi.unstubAllGlobals();
  });

  it("renders an applied CAD scene through the read-only WebGL layer and keeps manual overlays", async () => {
    const sourceBounds = { minX: 0, minY: 0, maxX: 1600, maxY: 900 };
    const size = normalizeCadMapSize(sourceBounds);
    const sceneId = "00000000-0000-4000-8000-000000000011";
    const importId = "00000000-0000-4000-8000-000000000012";
    const assetId = "00000000-0000-4000-8000-000000000013";
    const cadSnapshot: FloorMapSnapshot = {
      ...snapshot,
      width: size.width,
      height: size.height,
      floorPlan: {
        sourceType: "cad",
        imageUrl: "",
        originalFileUrl: null,
        renderedImageUrl: null,
        width: size.width,
        height: size.height,
        gridSize: size.gridSize
      },
      cadScene: {
        id: sceneId,
        version: 1,
        sourceImportJobId: importId,
        width: size.width,
        height: size.height,
        tileSize: CAD_SCENE_TILE_SIZE,
        primitiveCount: 0,
        tileCount: 0,
        manifestAssetId: assetId,
        manifestContentPath: `/floors/${snapshot.floorId}/import-jobs/${importId}/scene/manifest/content`,
        tileContentPathTemplate: `/floors/${snapshot.floorId}/import-jobs/${importId}/scene/tiles/{lod}/{tileX}/{tileY}/{part}/content`,
        statePath: `/sites/00000000-0000-4000-8000-000000000099/floors/${snapshot.floorId}/cad-scene`
      }
    };
    const manifest = {
      version: 1,
      sceneId,
      regionId: "main",
      manifestAssetId: assetId,
      ...size,
      tileSize: CAD_SCENE_TILE_SIZE,
      lodMode: "additive",
      primitiveCount: 0,
      tileCount: 0,
      byteSize: 1,
      sha256: "a".repeat(64),
      sourceBounds,
      transform: (() => {
        const scale = Math.min(
          (size.width - size.padding * 2) / 1600,
          (size.height - size.padding * 2) / 900
        );
        return {
          scaleX: scale,
          scaleY: -scale,
          translateX: (size.width - 1600 * scale) / 2,
          translateY: (size.height - 900 * scale) / 2 + 900 * scale
        };
      })(),
      tiles: []
    };
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/cad-scene")) {
        return new Response(JSON.stringify({
          revision: 3,
          scene: cadSnapshot.cadScene,
          overrides: [{
            elementId: "cad-element-11111111111111111111111111111111",
            hidden: true,
            transform: { translateX: 12, translateY: 34, scaleX: 1.5, scaleY: 0.75, rotation: 20 },
            strokeColor: "#112233",
            fillColor: "#445566",
            strokeWidth: 4,
            text: "변경된 안내"
          }],
          layers: [{ layerName: "HIDDEN", visible: false, locked: false }]
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(manifest), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    document.documentElement.dataset.ledControlMobileWebview = "true";
    document.documentElement.dataset.ledControlNativeAppState = "active";

    render(
      <FloorMapViewport snapshot={cadSnapshot} ariaLabel="CAD 지도">
        <FloorScene snapshot={cadSnapshot} fixtures={[]} interactive={false} />
      </FloorMapViewport>
    );
    const viewport = screen.getByRole("region", { name: "CAD 지도" });
    const surface = document.querySelector<HTMLElement>("[data-floor-map-surface]")!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 }
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 500));
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(rect(24, 24, 752, 423));
    fireEvent.scroll(viewport);

    await waitFor(() => expect(cadRenderer.instances).toHaveLength(1));
    const renderer = cadRenderer.instances[0];
    expect(screen.getByTestId("cad-scene-canvas")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();
    await waitFor(() => expect(renderer.mount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());
    expect(renderer.setLayerStates).toHaveBeenCalledWith(new Map([["HIDDEN", { visible: false }]]));
    expect(cadOverrideRuntime.createCadOverrideWorker).toHaveBeenCalledTimes(1);
    expect(cadOverrideRuntime.overrideMaps[0].get("cad-element-11111111111111111111111111111111")).toEqual({
      elementId: "cad-element-11111111111111111111111111111111",
      hidden: true,
      transform: { translateX: 12, translateY: 34, scaleX: 1.5, scaleY: 0.75, rotation: 20 },
      strokeColor: "#112233",
      fillColor: "#445566",
      strokeWidth: 4,
      text: "변경된 안내"
    });
    expect((renderer as typeof renderer & { options: Record<string, unknown> }).options).toMatchObject({
      platform: "mobile",
      devicePixelRatio: window.devicePixelRatio
    });
    expect(fetch).toHaveBeenCalledWith(`/api${cadSnapshot.cadScene!.manifestContentPath}`, expect.objectContaining({ credentials: "include" }));

    window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: "background" } }));
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: "active" } }));
    await waitFor(() => expect(cadRenderer.instances).toHaveLength(2));
    await waitFor(() => expect(cadRenderer.instances[1].mount).toHaveBeenCalled());
    expect(cadRenderer.instances[1].mount.mock.calls[0][0]).not.toBe(renderer.mount.mock.calls[0][0]);
  });

  it("fails closed with a Korean retry state when CAD scene state cannot be loaded", async () => {
    const cadSnapshot = createCadSnapshot();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/cad-scene")) return new Response("failure", { status: 500 });
      return new Response(JSON.stringify(createCadManifest(cadSnapshot)), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }));

    render(
      <FloorMapViewport snapshot={cadSnapshot} ariaLabel="CAD 지도">
        <FloorScene snapshot={cadSnapshot} fixtures={[]} interactive={false} />
      </FloorMapViewport>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("CAD 도면을 불러오지 못했습니다");
    expect(screen.getByRole("button", { name: "CAD 도면 다시 시도" })).toBeInTheDocument();
    expect(cadRenderer.instances).toHaveLength(0);
    expect(screen.queryByTestId("cad-scene-canvas")).not.toBeInTheDocument();
  });

  it.each(["onError", "onDegraded"])("shows %s failures and retries with a fresh renderer", async callback => {
    const cadSnapshot = createCadSnapshot();
    vi.stubGlobal("fetch", createSuccessfulCadFetch(cadSnapshot));

    render(
      <FloorMapViewport snapshot={cadSnapshot} ariaLabel="CAD 지도">
        <FloorScene snapshot={cadSnapshot} fixtures={[]} interactive={false} />
      </FloorMapViewport>
    );
    await waitFor(() => expect(cadRenderer.instances).toHaveLength(1));
    const fail = cadRenderer.instances[0].options[callback] as (error: unknown) => void;
    act(() => fail?.(callback === "onError" ? new Error("tile failed") : { requestedTileCount: 2, renderedTileCount: 0, reason: "memory-budget" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("CAD 도면을 불러오지 못했습니다");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CAD 도면 다시 시도" }));
    await waitFor(() => expect(cadRenderer.instances).toHaveLength(2));
    await waitFor(() => expect(cadRenderer.instances[1].mount).toHaveBeenCalled());
    expect(cadRenderer.instances[1].mount.mock.calls[0][0]).not.toBe(cadRenderer.instances[0].mount.mock.calls[0][0]);
  });

  it.each(["unknown field", "translation limit", "tile coordinate", "tile bounds", "duplicate asset"])(
    "rejects %s before creating the CAD renderer",
    async (kind) => {
      const cadSnapshot = createCadSnapshot();
      const manifest = createCadManifest(cadSnapshot);
      const state = { revision: 1, scene: cadSnapshot.cadScene, overrides: [] as unknown[], layers: [] };
      if (kind === "unknown field") Object.assign(manifest, { unexpected: true });
      if (kind === "translation limit") state.overrides.push({
        elementId: "moved", hidden: false,
        transform: { translateX: 32769, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        strokeColor: null, fillColor: null, strokeWidth: null, text: null
      });
      if (kind.startsWith("tile") || kind === "duplicate asset") {
        const tile: CadSceneTile = {
          version: 1, sceneId: manifest.sceneId, assetId: "00000000-0000-4000-8000-000000000099",
          tileX: kind === "tile coordinate" ? 64 : 0, tileY: 0, lod: 0, part: 0,
          primitiveCount: 1, byteSize: 1, sha256: "a".repeat(64),
          bounds: { minX: 0, minY: 0, maxX: kind === "tile bounds" ? 600 : 512, maxY: 512 }
        };
        manifest.tiles.push(tile);
        if (kind === "duplicate asset") manifest.tiles.push({ ...tile, part: 1 });
        manifest.tileCount = manifest.tiles.length;
        manifest.primitiveCount = manifest.tiles.length;
        cadSnapshot.cadScene!.tileCount = manifest.tileCount;
        cadSnapshot.cadScene!.primitiveCount = manifest.primitiveCount;
      }
      vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
        url.endsWith("/cad-scene") ? state : manifest
      ))));
      render(<FloorMapViewport snapshot={cadSnapshot} ariaLabel="CAD 지도">
        <FloorScene snapshot={cadSnapshot} fixtures={[]} interactive={false} />
      </FloorMapViewport>);
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(cadRenderer.instances).toHaveLength(0);
    }
  );

  it.each(["declared", "chunked", "underreported"])("caps %s tile bytes before worker decoding", async (kind) => {
    const cadSnapshot = createCadSnapshot();
    vi.stubGlobal("fetch", createSuccessfulCadFetch(cadSnapshot));
    render(<FloorMapViewport snapshot={cadSnapshot} ariaLabel="CAD 지도">
      <FloorScene snapshot={cadSnapshot} fixtures={[]} interactive={false} />
    </FloorMapViewport>);
    await waitFor(() => expect(cadRenderer.instances).toHaveLength(1));
    const cancel = vi.fn();
    let pulls = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        if (pulls === 4) controller.close();
      }, cancel
    }), { headers: kind === "chunked" ? {} : { "Content-Length": kind === "declared" ? "16777217" : "1" } });
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const loadTile = cadRenderer.instances[0].options.loadTile as (tile: CadSceneTile, signal: AbortSignal) => Promise<Uint8Array>;
    await expect(loadTile({ lod: 0, tileX: 0, tileY: 0, part: 0 } as CadSceneTile, new AbortController().signal).then(() => undefined))
      .rejects.toThrow(/byte limit/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reloads CAD state on a map revision change with the same descriptor and mounts a fresh canvas", async () => {
    const cadSnapshot = createCadSnapshot();
    let revision = cadSnapshot.revision;
    const fetch = createSuccessfulCadFetch(cadSnapshot);
    const stateFetch = vi.fn(async () => new Response(JSON.stringify({
      revision,
      scene: cadSnapshot.cadScene,
      overrides: [],
      layers: [{ layerName: "EDITED", visible: revision === cadSnapshot.revision, locked: false }]
    }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", (url: string) => url.endsWith("/cad-scene") ? stateFetch() : fetch(url));
    const scene = (value: FloorMapSnapshot) => (
      <FloorMapViewport snapshot={value} ariaLabel="CAD 지도">
        <FloorScene snapshot={value} fixtures={[]} interactive={false} />
      </FloorMapViewport>
    );
    const view = render(scene(cadSnapshot));
    await waitFor(() => expect(cadRenderer.instances[0]?.setLayerStates).toHaveBeenCalledWith(new Map([
      ["EDITED", { visible: true }]
    ])));
    const oldCanvas = screen.getByTestId("cad-scene-canvas");

    revision += 1;
    view.rerender(scene({ ...cadSnapshot, revision }));

    await waitFor(() => expect(stateFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(cadRenderer.instances[1]?.setLayerStates).toHaveBeenCalledWith(new Map([
      ["EDITED", { visible: false }]
    ])));
    expect(cadRenderer.instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(oldCanvas.isConnected).toBe(false);
    expect(screen.getByTestId("cad-scene-canvas")).not.toBe(oldCanvas);
    expect(cadRenderer.instances[1].mount).toHaveBeenCalledWith(screen.getByTestId("cad-scene-canvas"));
  });

  it("does not fetch or create the renderer while a mobile WebView starts in background", async () => {
    const cadSnapshot = createCadSnapshot();
    const fetch = createSuccessfulCadFetch(cadSnapshot);
    vi.stubGlobal("fetch", fetch);
    document.documentElement.dataset.ledControlMobileWebview = "true";
    document.documentElement.dataset.ledControlNativeAppState = "background";

    render(
      <FloorMapViewport snapshot={cadSnapshot} ariaLabel="CAD 지도">
        <FloorScene snapshot={cadSnapshot} fixtures={[]} interactive={false} />
      </FloorMapViewport>
    );

    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    expect(cadRenderer.instances).toHaveLength(0);
    window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: "active" } }));
    await waitFor(() => expect(cadRenderer.instances).toHaveLength(1));
  });

  it("keeps the legacy renderer path for non-CAD floors", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <FloorMapViewport snapshot={snapshot} ariaLabel="기존 지도">
        <FloorScene snapshot={snapshot} fixtures={[]} interactive={false} />
      </FloorMapViewport>
    );

    expect(screen.queryByTestId("cad-scene-canvas")).not.toBeInTheDocument();
    expect(cadRenderer.instances).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not cover a native CAD scene with its legacy rendered image", () => {
    const cadSnapshot = createCadSnapshot();
    cadSnapshot.floorPlan!.renderedImageUrl = "/legacy-preview.svg";
    render(<FloorScene snapshot={cadSnapshot} fixtures={[]} interactive={false} />);
    expect(screen.queryByRole("img", { name: "층 도면" })).not.toBeInTheDocument();
  });

  it("sizes manual-object backing canvases to the displayed map instead of 16384 logical pixels", () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 0, 800, 500));
    try {
      render(<FloorScene snapshot={createCadSnapshot()} fixtures={[]} interactive={false} />);
      const canvas = document.querySelector<HTMLCanvasElement>(".floor-scene-canvas canvas")!;
      expect(canvas.width).toBeLessThanOrEqual(1600);
      expect(canvas.height).toBeLessThanOrEqual(1000);
    } finally { bounds.mockRestore(); }
  });

  it("renders multi-selected and disabled markers with 44px coarse hit targets", () => {
    const onFixturePress = vi.fn();
    const fixtureA = {
      id: "fixture-a",
      name: "B1-L001",
      x: 100,
      y: 120,
      brightness: 70,
      status: "online" as const
    };
    const fixtureB = {
      id: "fixture-b",
      name: "B1-L002",
      x: 200,
      y: 240,
      brightness: 20,
      status: "online" as const
    };

    render(
      <FloorScene
        snapshot={snapshot}
        fixtures={[fixtureA, fixtureB]}
        interactive={false}
        selection={{
          kind: "multiple",
          selectedFixtureIds: new Set([fixtureA.id]),
          disabledFixtureIds: new Set([fixtureB.id])
        }}
        coarsePointer
        onFixturePress={onFixturePress}
      />
    );

    expect(screen.getByRole("button", { name: /B1-L001.*선택됨/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /B1-L002.*선택 불가/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /B1-L001/ })).toHaveClass("size-12!", "min-h-12!");
  });

  it("renders compact selectable fixtures without visible marker copy", () => {
    const onFixturePress = vi.fn();
    render(
      <FloorScene
        snapshot={snapshot}
        fixtures={[{
          id: "fixture-1",
          name: "B1-L001",
          x: 100,
          y: 120,
          brightness: 70,
          status: "online"
        }]}
        interactive={false}
        selection={{ kind: "single", selectedFixtureIds: new Set(["fixture-1"]) }}
        onFixturePress={onFixturePress}
      />
    );

    expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();
    expect(screen.queryByTestId("floor-transformer")).not.toBeInTheDocument();
    const fixture = screen.getByRole("button", { name: "B1-L001 정상 70%" });
    expect(fixture).toHaveClass("size-5!", "min-h-5!", "rounded-pill!", "p-0!");
    expect(fixture).toHaveAttribute("data-spatial-map-marker", "true");
    expect(fixture).toHaveAttribute("data-brightness-level", "8");
    expect(fixture.querySelector("[data-spatial-map-marker-dot]")).toHaveClass(
      "bg-fixture-brightness-8",
      "shadow-fixture-brightness-8",
      "outline-fixture-selected"
    );
    expect(fixture).toHaveAttribute("aria-current", "true");
    expect(fixture).not.toHaveAttribute("aria-pressed");
    expect(fixture).toHaveAttribute("title", "B1-L001 정상 70%");
    expect(fixture).toHaveTextContent("");
    expect(fixture.querySelector("[data-spatial-map-marker-dot]")).toHaveClass("border-fixture-connected!", "rounded-pill!");
    expect(screen.queryByText("B1-L001")).not.toBeInTheDocument();
    expect(screen.queryByText("70%")).not.toBeInTheDocument();
    fireEvent.click(fixture);
    expect(onFixturePress).toHaveBeenCalledWith("fixture-1", fixture);
  });

  it("allows monitoring to show a name-only native tooltip while preserving the accessible status and anchor", () => {
    const onFixturePress = vi.fn();
    render(<FloorScene snapshot={snapshot} fixtures={[{
      id: "fixture-1", name: "B1-L001", x: 100, y: 120, brightness: 70, status: "online"
    }]} interactive={false} markerTitle={(fixture) => fixture.name} onFixturePress={onFixturePress} />);

    const marker = screen.getByRole("button", { name: "B1-L001 정상 70%" });
    expect(marker).toHaveAttribute("title", "B1-L001");
    fireEvent.click(marker);
    expect(onFixturePress).toHaveBeenCalledWith("fixture-1", marker);
  });

  it("keeps snapshot fixtures when runtime placement is stale while hiding runtime-only unplaced fixtures", () => {
    render(
      <FloorScene
        snapshot={{
          ...snapshot,
          floorPlan: {
            sourceType: "pdf",
            imageUrl: "",
            originalFileUrl: "/api/floors/floor-1/assets/source/content",
            renderedImageUrl: "/api/floors/floor-1/assets/rendered/content",
            width: 1200,
            height: 800,
            gridSize: 10
          },
          fixtures: [{ id: "fixture-assigned", name: "B1-L001", x: 300, y: 200, size: 20 }]
        }}
        fixtures={[
          { id: "fixture-assigned", name: "stale-runtime-name", x: 999, y: 999, brightness: 70, status: "online", placementStatus: "unplaced" },
          { id: "fixture-free", name: "B1-L002", x: 600, y: 400, brightness: 40, status: "online", placementStatus: "placed" },
          { id: "fixture-unplaced", name: "B1-L003", x: 700, y: 500, brightness: 0, status: "offline", placementStatus: "unplaced" }
        ]}
        interactive={false}
        floorName="B1"
      />
    );

    expect(screen.getByRole("img", { name: "B1 도면" })).toHaveAttribute(
      "src",
      "/api/floors/floor-1/assets/rendered/content"
    );
    expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B1-L001 정상 70%" })).toHaveStyle({
      "--fixture-left": "25%",
      "--fixture-top": "25%"
    });
    expect(screen.getByRole("button", { name: "B1-L002 정상 40%" })).toHaveStyle({
      "--fixture-left": "50%",
      "--fixture-top": "50%"
    });
    expect(screen.queryByRole("button", { name: /B1-L003/ })).not.toBeInTheDocument();
  });

  it.each([
    [-20, 1], [0, 1], [9, 1],
    [10, 2], [19, 2],
    [20, 3], [29, 3],
    [30, 4], [39, 4],
    [40, 5], [49, 5],
    [50, 6], [59, 6],
    [60, 7], [69, 7],
    [70, 8], [79, 8],
    [80, 9], [89, 9],
    [90, 10], [100, 10], [150, 10]
  ])("maps brightness %i to static level %i", (brightness, level) => {
    render(
      <FloorScene
        snapshot={snapshot}
        fixtures={[{
          id: `fixture-${brightness}`,
          name: `B1-${brightness}`,
          x: 100,
          y: 120,
          brightness,
          status: "online"
        }]}
        interactive={false}
      />
    );

    const marker = screen.getByRole("button", { name: `B1-${brightness} 정상 ${brightness}%` });
    expect(marker).toHaveAttribute("data-brightness-level", String(level));
    expect(marker.querySelector("[data-spatial-map-marker-dot]")).toHaveClass(`bg-fixture-brightness-${level}`, `shadow-fixture-brightness-${level}`);
  });

  it("keeps null-filled editor objects hit-testable across their interior", () => {
    const nodeRef: { current: Konva.Node | null } = { current: null };
    render(
      <Stage width={300} height={200}>
        <Layer>
          <FloorMapObjectNode
            object={{ ...snapshot.objects[0], fillColor: null }}
            interactive
            setNodeRef={(value) => { nodeRef.current = value; }}
          />
        </Layer>
      </Stage>
    );

    expect(nodeRef.current?.getAttr("fill")).toBe("transparent");
    expect(nodeRef.current?.listening()).toBe(true);
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect;
}

function createCadSnapshot(): FloorMapSnapshot {
  const { width, height } = normalizeCadMapSize({ minX: 0, minY: 0, maxX: 1600, maxY: 900 });
  const sceneId = "00000000-0000-4000-8000-000000000021";
  const importId = "00000000-0000-4000-8000-000000000022";
  return {
    ...snapshot,
    width,
    height,
    floorPlan: {
      sourceType: "cad",
      imageUrl: "",
      originalFileUrl: null,
      renderedImageUrl: null,
      width,
      height,
      gridSize: 10
    },
    cadScene: {
      id: sceneId,
      version: 1,
      sourceImportJobId: importId,
      width,
      height,
      tileSize: CAD_SCENE_TILE_SIZE,
      primitiveCount: 0,
      tileCount: 0,
      manifestAssetId: "00000000-0000-4000-8000-000000000023",
      manifestContentPath: `/floors/${snapshot.floorId}/import-jobs/${importId}/scene/manifest/content`,
      tileContentPathTemplate: `/floors/${snapshot.floorId}/import-jobs/${importId}/scene/tiles/{lod}/{tileX}/{tileY}/{part}/content`,
      statePath: `/sites/00000000-0000-4000-8000-000000000099/floors/${snapshot.floorId}/cad-scene`
    }
  };
}

function createCadManifest(cadSnapshot: FloorMapSnapshot) {
  const descriptor = cadSnapshot.cadScene!;
  const sourceBounds = { minX: 0, minY: 0, maxX: 1600, maxY: 900 };
  const size = normalizeCadMapSize(sourceBounds);
  const scale = Math.min((size.width - size.padding * 2) / 1600, (size.height - size.padding * 2) / 900);
  return {
    version: 1,
    sceneId: descriptor.id,
    regionId: "main",
    manifestAssetId: descriptor.manifestAssetId,
    width: descriptor.width,
    height: descriptor.height,
    padding: size.padding,
    gridSize: size.gridSize,
    tileSize: descriptor.tileSize,
    lodMode: "additive",
    primitiveCount: descriptor.primitiveCount,
    tileCount: descriptor.tileCount,
    byteSize: 1,
    sha256: "a".repeat(64),
    sourceBounds,
    transform: { scaleX: scale, scaleY: -scale, translateX: (size.width - 1600 * scale) / 2, translateY: (size.height + 900 * scale) / 2 },
    tiles: [] as CadSceneTile[]
  };
}

function createSuccessfulCadFetch(cadSnapshot: FloorMapSnapshot) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/cad-scene")) {
      return new Response(JSON.stringify({
        revision: 1,
        scene: cadSnapshot.cadScene,
        overrides: [],
        layers: []
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(createCadManifest(cadSnapshot)), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
}

function dispatchScenePointer(target: HTMLElement, type: string, init: Record<string, number | string>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, init);
  fireEvent(target, event);
}

function renderOverlappingMarkers(manual = false) {
  const fixtures = [
    { id: "center", name: "중앙", x: 600, y: 400, brightness: 70, status: "online" as const },
    { id: "disabled", name: "장애", x: 600, y: 418, brightness: 70, status: "fault" as const }
  ];
  const sceneSelection = { kind: "multiple" as const, selectedFixtureIds: new Set<string>(), disabledFixtureIds: new Set(["disabled"]) };
  const onPress = vi.fn();
  const scene = <FloorScene snapshot={snapshot} fixtures={fixtures} selection={sceneSelection} interactive={false} coarsePointer onFixturePress={onPress} />;
  const result = render(manual ? <FloorMapViewport snapshot={snapshot} ariaLabel="manual integration" interactionPolicy="direct-selection" toolModePolicy="manual-cad">{scene}</FloorMapViewport> : scene);
  const center = screen.getByRole("button", { name: "중앙 정상 70%" });
  const disabled = screen.getByRole("button", { name: /장애 장애 70% 선택 불가/ });
  vi.spyOn(center, "getBoundingClientRect").mockReturnValue(new DOMRect(76, 76, 48, 48));
  vi.spyOn(disabled, "getBoundingClientRect").mockReturnValue(new DOMRect(76, 83, 48, 48));
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => disabled });
  return { ...result, center, disabled, onPress, fixtures, sceneSelection };
}
