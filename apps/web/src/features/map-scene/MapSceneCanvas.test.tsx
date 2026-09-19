import { createRef, StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapDocumentRef } from "@led-control/shared/map-document-contracts";
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
      groups: [], layers: [], displayLayerBindings: [], display: { version: 1, sceneId: "display", regionId: "manual", manifestAssetId: "display",
        width: 1024, height: 1024, padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", primitiveCount: 0, tileCount: 0,
        byteSize: 100, sha256: "a".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: 1024, maxY: 1024 },
        transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] } })) };
  const backend: CadSceneRenderBackend = { mount: vi.fn(async canvas => { canvases.push(canvas); }), destroy: vi.fn(),
    render: vi.fn(), suspend: vi.fn(), resize: vi.fn(), setCamera: vi.fn(), replaceTile: vi.fn(), removeTile: vi.fn() };
  const createRenderer = (options: MapSceneRendererOptions) => {
    const renderer = new MapSceneRenderer({ ...options, backendFactory: () => backend }); renderers.push(renderer); return renderer;
  };
  const onManifest = vi.fn(), onError = vi.fn(), onReady = vi.fn();
  return { source, backend, renderers, canvases, props: { source, documentRef, camera, createRenderer, onManifest, onError, onReady } };
}
afterEach(cleanup);

describe("common map Canvas lifecycle", () => {
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
    view.unmount();
    expect(h.renderers[0].memoryBytes).toBe(0);
    expect(h.props.onReady).toHaveBeenLastCalledWith(null);
  });

  it("uses fresh canvas nodes in StrictMode and when permission/source changes, without stale callbacks", async () => {
    const h = harness();
    const view = render(<StrictMode><MapSceneCanvas {...h.props} /></StrictMode>);
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledTimes(1));
    expect(h.canvases).toHaveLength(2);
    expect(h.canvases[0]).not.toBe(h.canvases[1]);
    expect(h.renderers[0].memoryBytes).toBe(0);
    const before = view.container.querySelector("canvas");
    view.rerender(<StrictMode><MapSceneCanvas {...h.props} readOnly /></StrictMode>);
    await waitFor(() => expect(h.props.onManifest).toHaveBeenCalledTimes(2));
    expect(view.container.querySelector("canvas")).not.toBe(before);
    expect(h.props.onError).not.toHaveBeenCalled();
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
