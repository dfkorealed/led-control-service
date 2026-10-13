import { createRef, StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { MapDocumentRef } from "@led-control/shared/map-document-contracts";
import type { MapDisplayTile } from "@led-control/shared/map-display-contracts";
import type { CadSceneRenderBackend } from "../cad-scene/CadSceneRenderer";
import { MapSceneRenderer, type MapSceneRendererOptions } from "./MapSceneRenderer";
import { MapSceneCanvas, type MapSceneCanvasHandle } from "./MapSceneCanvas";
import type { MapSceneSource } from "./map-scene-source";

const documentRef: MapDocumentRef = { formatVersion: 1, generationId: "gen-a", revision: 0, width: 1024, height: 1024,
  gridSize: 50, elementCount: 0, manifest: { assetId: "canonical", byteSize: 100, decodedByteSize: 100, sha256: "a".repeat(64) } };
const camera = { centerX: 512, centerY: 512, viewportWidth: 320, viewportHeight: 480, zoom: 0.25 };
function harness() {
  const canvases: HTMLCanvasElement[] = [], renderers: MapSceneRenderer[] = [];
  const source: MapSceneSource = { scopeKey: "principal:floor", getElements: vi.fn(async () => []),
    loadDisplayTile: vi.fn(async () => new Uint8Array()), decodeDisplayTile: vi.fn(),
    getChanges: vi.fn(async ref => ({ generationId: ref.generationId, revision: ref.revision, operations: [], nextCursor: null })),
    getManifest: vi.fn<MapSceneSource["getManifest"]>(async ref => ({ generationId: ref.generationId, revision: ref.revision, canonical: ref.manifest,
      groups: [], layers: [], displayLayerBindings: [], display: { version: 2, sceneId: "display", regionId: "manual", manifestAssetId: "display",
        width: 1024, height: 1024, padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", primitiveCount: 0, tileCount: 0,
        byteSize: 100, sha256: "a".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: 1024, maxY: 1024 },
        transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] } })) };
  const backend: CadSceneRenderBackend<MapDisplayTile> = { mount: vi.fn(async canvas => { canvases.push(canvas); }), destroy: vi.fn(),
    render: vi.fn(), suspend: vi.fn(), resize: vi.fn(), setCamera: vi.fn(), replaceTile: vi.fn(), removeTile: vi.fn() };
  const createRenderer = (options: MapSceneRendererOptions) => {
    const renderer = new MapSceneRenderer({ ...options, backendFactory: () => backend }); renderers.push(renderer); return renderer;
  };
  const onManifest = vi.fn(), onError = vi.fn(), onReady = vi.fn();
  return { source, backend, renderers, canvases, props: { source, documentRef, camera, createRenderer, onManifest, onError, onReady } };
}
afterEach(cleanup);

describe("common map Canvas lifecycle", () => {
  it("fences actual consumer paint, error and degraded callbacks on A -> B -> A visits", async () => {
    const h = harness(), options: MapSceneRendererOptions[] = [];
    const onDegraded = vi.fn();
    const createRenderer = (value: MapSceneRendererOptions) => { options.push(value); return h.props.createRenderer(value); };
    const view = render(<MapSceneCanvas {...h.props} createRenderer={createRenderer} onDegraded={onDegraded} />);
    await waitFor(() => expect(h.props.onReady).toHaveBeenCalledWith(expect.any(Object)));
    view.rerender(<MapSceneCanvas {...h.props} createRenderer={createRenderer} onDegraded={onDegraded} source={{ ...h.source, scopeKey: "floor-b" }} />);
    await waitFor(() => expect(options).toHaveLength(2));
    view.rerender(<MapSceneCanvas {...h.props} createRenderer={createRenderer} onDegraded={onDegraded} />);
    await waitFor(() => expect(options).toHaveLength(3));
    act(() => {
      options[0].onPaintReady?.(true);
      options[1].onPaintReady?.(true);
      options[0].onError?.(new Error("old A"));
      options[0].onDegraded?.({ requestedTileCount: 2, renderedTileCount: 0, reason: "memory-budget" });
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(h.props.onError).not.toHaveBeenCalled();
    expect(onDegraded).not.toHaveBeenCalled();
    await waitFor(() => expect(h.props.onReady.mock.calls.filter(([handle]) => handle !== null)).toHaveLength(3));
    act(() => options[2].onPaintReady?.(true));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stops first paint loading on degradation and retains the existing host failure route", () => {
    const h = harness(), options: MapSceneRendererOptions[] = [], onDegraded = vi.fn();
    render(<MapSceneCanvas {...h.props} onDegraded={onDegraded} createRenderer={value => { options.push(value); return h.props.createRenderer(value); }} />);
    const result = { requestedTileCount: 2, renderedTileCount: 0, reason: "memory-budget" as const };
    act(() => options[0].onDegraded?.(result));
    expect(onDegraded).toHaveBeenCalledWith(result);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("keeps the overlay after handle creation until actual viewport paint and ignores subsequent pan/zoom waits", async () => {
    const h = harness(), options: MapSceneRendererOptions[] = [];
    const createRenderer = (value: MapSceneRendererOptions) => { options.push(value); return h.props.createRenderer(value); };
    const view = render(<MapSceneCanvas {...h.props} createRenderer={createRenderer} />);
    await waitFor(() => expect(h.props.onReady).toHaveBeenCalledWith(expect.any(Object)));
    expect(screen.getByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
    act(() => options[0].onPaintReady?.(true));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<MapSceneCanvas {...h.props} createRenderer={createRenderer} camera={{ ...camera, centerX: 700, zoom: 0.5 }} />);
    act(() => options[0].onPaintReady?.(false));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("loads replacement generations and floors without letting stale paints or errors settle them", async () => {
    const h = harness(), options: MapSceneRendererOptions[] = [];
    const createRenderer = (value: MapSceneRendererOptions) => { options.push(value); return h.props.createRenderer(value); };
    const view = render(<MapSceneCanvas {...h.props} createRenderer={createRenderer} />);
    await waitFor(() => expect(h.props.onReady).toHaveBeenCalledWith(expect.any(Object)));
    act(() => options[0].onPaintReady?.(true));
    view.rerender(<MapSceneCanvas {...h.props} createRenderer={createRenderer} documentRef={{ ...documentRef, generationId: "gen-b" }} />);
    act(() => options[0].onPaintReady?.(true));
    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledWith(expect.objectContaining({ generationId: "gen-b" })));
    act(() => options[0].onPaintReady?.(true));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<MapSceneCanvas {...h.props} createRenderer={createRenderer} source={{ ...h.source, scopeKey: "floor-2" }} />);
    act(() => { options[0].onPaintReady?.(true); options[0].onError?.(new Error("old")); });
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(h.props.onError).not.toHaveBeenCalled();
  });

  it("stops the spinner on a renderer error while preserving the host error", async () => {
    const h = harness(), options: MapSceneRendererOptions[] = [];
    const createRenderer = (value: MapSceneRendererOptions) => { options.push(value); return h.props.createRenderer(value); };
    render(<MapSceneCanvas {...h.props} createRenderer={createRenderer} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    const error = new Error("tile failed");
    act(() => options[0].onError?.(error));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(h.props.onError).toHaveBeenLastCalledWith(error);
  });

  it.each(["desktop", "mobile"] as const)("replays unchanged document, camera and promotion on a %s platform transition", async platform => {
    const h = harness(), promotedElementIds = ["selected"];
    const cameras: Array<MockInstance<MapSceneRenderer["setCamera"]>> = [];
    const promotions: Array<MockInstance<MapSceneRenderer["setPromotedElementIds"]>> = [];
    const createRenderer = (options: MapSceneRendererOptions) => {
      const renderer = h.props.createRenderer(options);
      cameras.push(vi.spyOn(renderer, "setCamera"));
      promotions.push(vi.spyOn(renderer, "setPromotedElementIds"));
      return renderer;
    };
    const view = render(<MapSceneCanvas {...h.props} createRenderer={createRenderer} platform={platform} promotedElementIds={promotedElementIds} />);
    await waitFor(() => expect(h.props.onReady).toHaveBeenCalledWith(expect.any(Object)));
    const previousCanvas = view.container.querySelector("canvas");
    h.props.onReady.mockClear();
    view.rerender(<MapSceneCanvas {...h.props} createRenderer={createRenderer}
      platform={platform === "desktop" ? "mobile" : "desktop"} promotedElementIds={promotedElementIds} />);
    expect(h.renderers).toHaveLength(2);
    expect(view.container.querySelector("canvas")).not.toBe(previousCanvas);
    expect(h.renderers[0].memoryBytes).toBe(0);
    expect(cameras[1]).toHaveBeenCalledWith(camera);
    expect(promotions[1]).toHaveBeenCalledWith(promotedElementIds);
    await waitFor(() => expect(h.source.getManifest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.props.onReady.mock.calls.at(-1)?.[0]).toMatchObject({ setCamera: expect.any(Function) }));
    expect(h.backend.resize).toHaveBeenLastCalledWith(camera.viewportWidth, camera.viewportHeight, 1);
    expect(h.props.onError).not.toHaveBeenCalled();
  });

  it("fences old document adoption and paint callbacks when platform changes", async () => {
    const h = harness(), onPaintReady = vi.fn();
    const manifest = await h.source.getManifest(documentRef, new AbortController().signal);
    let release!: (value: typeof manifest) => void;
    vi.mocked(h.source.getManifest).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const options: MapSceneRendererOptions[] = [];
    const createRenderer = (value: MapSceneRendererOptions) => { options.push(value); return h.props.createRenderer(value); };
    const view = render(<MapSceneCanvas {...h.props} createRenderer={createRenderer} platform="desktop" onPaintReady={onPaintReady} />);
    await waitFor(() => expect(h.source.getManifest).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(h.source.getManifest).mock.calls[1][1];
    view.rerender(<MapSceneCanvas {...h.props} createRenderer={createRenderer} platform="mobile" onPaintReady={onPaintReady} />);
    await waitFor(() => expect(h.props.onReady.mock.calls.at(-1)?.[0]).toMatchObject({ setCamera: expect.any(Function) }));
    expect(signal.aborted).toBe(true);
    const notifications = h.props.onManifest.mock.calls.length;
    onPaintReady.mockClear();
    await act(async () => { release(manifest); options[0].onPaintReady?.(true); });
    expect(h.props.onManifest).toHaveBeenCalledTimes(notifications);
    expect(onPaintReady).not.toHaveBeenCalledWith(true);
    act(() => options[1].onPaintReady?.(true));
    expect(onPaintReady).toHaveBeenLastCalledWith(true);
    expect(h.props.onError).not.toHaveBeenCalled();
  });

  it("keeps metadata readiness separate from paint and fences old scope callbacks", async () => {
    const h = harness(), onPaintReady = vi.fn();
    const options: MapSceneRendererOptions[] = [];
    const createRenderer = (value: MapSceneRendererOptions) => { options.push(value); return h.props.createRenderer(value); };
    const view = render(<MapSceneCanvas {...h.props} createRenderer={createRenderer} onPaintReady={onPaintReady} />);
    await waitFor(() => expect(h.props.onReady).toHaveBeenCalledWith(expect.any(Object)));
    expect(onPaintReady).toHaveBeenLastCalledWith(false);
    expect(onPaintReady).not.toHaveBeenCalledWith(true);
    act(() => options[0].onPaintReady?.(true));
    expect(onPaintReady).toHaveBeenLastCalledWith(true);
    view.rerender(<MapSceneCanvas {...h.props} createRenderer={createRenderer} onPaintReady={onPaintReady}
      source={{ ...h.source, scopeKey: "principal:new" }} />);
    await waitFor(() => expect(options).toHaveLength(2));
    onPaintReady.mockClear();
    act(() => options[0].onPaintReady?.(true));
    expect(onPaintReady).not.toHaveBeenCalled();
    act(() => options[1].onPaintReady?.(true));
    expect(onPaintReady).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(onPaintReady).toHaveBeenLastCalledWith(false);
  });
  it("keeps the actual canvas and renderer on revision/camera/callback updates and publishes structures", async () => {
    const h = harness(); const ref = createRef<MapSceneCanvasHandle>();
    const view = render(<MapSceneCanvas {...h.props} ref={ref} />);
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledTimes(1));
    const canvas = view.container.querySelector("canvas");
    const latestManifest = vi.fn();
    view.rerender(<MapSceneCanvas {...h.props} ref={ref} documentRef={{ ...documentRef, revision: 1 }}
      camera={{ ...camera, centerX: 600 }} onManifest={latestManifest} />);
    await waitFor(() => expect(latestManifest).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, layers: [], groups: [] })));
    expect(h.renderers).toHaveLength(1);
    expect(view.container.querySelector("canvas")).toBe(canvas);
    await waitFor(() => expect(h.backend.setCamera).toHaveBeenLastCalledWith({ ...camera, centerX: 600 }));
    expect(h.props.onError).not.toHaveBeenCalled();
    ref.current!.setCamera({ ...camera, centerX: 620 });
    await waitFor(() => expect(h.backend.setCamera).toHaveBeenLastCalledWith({ ...camera, centerX: 620 }));
    view.unmount();
    expect(h.renderers[0].memoryBytes).toBe(0);
    expect(h.props.onReady).toHaveBeenLastCalledWith(null);
  });

  it("uses fresh canvas nodes in StrictMode and when source scope changes, without stale callbacks", async () => {
    const h = harness();
    const view = render(<StrictMode><MapSceneCanvas {...h.props} /></StrictMode>);
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledTimes(1));
    expect(h.canvases).toHaveLength(2);
    expect(h.canvases[0]).not.toBe(h.canvases[1]);
    expect(h.renderers[0].memoryBytes).toBe(0);
    const before = view.container.querySelector("canvas");
    view.rerender(<StrictMode><MapSceneCanvas {...h.props} source={{ ...h.source, scopeKey: "principal:other-floor" }} /></StrictMode>);
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledTimes(2));
    expect(view.container.querySelector("canvas")).not.toBe(before);
    expect(h.props.onError).not.toHaveBeenCalled();
  });

  it("keeps one map surface when a same-scope source and permission refresh", async () => {
    const h = harness();
    const freshSource: MapSceneSource = { ...h.source, getManifest: vi.fn(h.source.getManifest) };
    const ref = createRef<MapSceneCanvasHandle>();
    const view = render(<MapSceneCanvas {...h.props} ref={ref} />);
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledTimes(1));
    const canvas = view.container.querySelector("canvas");

    view.rerender(<MapSceneCanvas {...h.props} ref={ref} source={freshSource} readOnly
      documentRef={{ ...documentRef, revision: 1 }} onManifest={vi.fn()} />);

    await waitFor(() => expect(freshSource.getManifest).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), expect.any(AbortSignal)));
    expect(h.renderers).toHaveLength(1);
    expect(view.container.querySelector("canvas")).toBe(canvas);
    expect(() => ref.current!.applyChanges([{ kind: "delete", id: "x" }], [])).toThrow("read-only");
  });

  it("blocks mutating handles in read-only mode while fetching persisted state and permitting selection lookup", async () => {
    const h = harness(); const ref = createRef<MapSceneCanvasHandle>();
    render(<MapSceneCanvas {...h.props} ref={ref} readOnly />);
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledTimes(1));
    expect(h.source.getChanges).toHaveBeenCalled();
    expect(() => ref.current!.applyChanges([{ kind: "delete", id: "x" }], [])).toThrow("read-only");
    await expect(ref.current!.getElements(["x"])).resolves.toEqual([]);
    expect(h.source.getElements).toHaveBeenCalledWith(documentRef, ["x"], expect.any(AbortSignal));
  });

  it("aborts a stale manifest on scope change and does not notify the next host", async () => {
    const h = harness(); let finish!: (value: Awaited<ReturnType<MapSceneSource["getManifest"]>>) => void;
    const old = await h.source.getManifest(documentRef, new AbortController().signal);
    vi.mocked(h.source.getManifest).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<MapSceneCanvas {...h.props} />);
    await waitFor(() => expect(h.source.getManifest).toHaveBeenCalledTimes(2));
    const oldSignal = vi.mocked(h.source.getManifest).mock.calls[1][1];
    const next = { ...h.source, scopeKey: "principal:other-floor" };
    view.rerender(<MapSceneCanvas {...h.props} source={next} />);
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledTimes(1));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(old));
    expect(h.props.onManifest).toHaveBeenCalledTimes(1);
  });
});
