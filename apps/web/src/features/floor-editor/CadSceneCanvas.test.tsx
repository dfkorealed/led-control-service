import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CadSceneDescriptor, CadSceneManifest, CadSceneState, CadSceneTile } from "@led-control/shared";
import type { CadSceneRendererOptions } from "../cad-scene/CadSceneRenderer";
import type { CadSceneWorkerClient, DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import {
  CadDecodedTileStore,
  CadSceneCanvas,
  type CadSceneCanvasHandle,
  type CadSceneRendererLike
} from "./CadSceneCanvas";
import { CadSceneMemoryBudget } from "../cad-scene/cad-scene-memory-budget";

const descriptor: CadSceneDescriptor = {
  id: "00000000-0000-4000-8000-000000000001",
  version: 1,
  sourceImportJobId: "00000000-0000-4000-8000-000000000002",
  width: 16_384,
  height: 8_192,
  tileSize: 512,
  primitiveCount: 0,
  tileCount: 0,
  manifestAssetId: "00000000-0000-4000-8000-000000000003",
  manifestContentPath: "/floors/f/import-jobs/j/scene/manifest/content",
  tileContentPathTemplate: "/floors/f/import-jobs/j/scene/tiles/{lod}/{tileX}/{tileY}/{part}/content",
  statePath: "/sites/s/floors/f/cad-scene"
};

const manifest: CadSceneManifest = {
  version: 1,
  sceneId: descriptor.id,
  regionId: "region-1",
  manifestAssetId: descriptor.manifestAssetId,
  width: descriptor.width,
  height: descriptor.height,
  padding: 328,
  gridSize: 80,
  tileSize: 512,
  lodMode: "additive",
  primitiveCount: 0,
  tileCount: 0,
  byteSize: 1,
  sha256: "0".repeat(64),
  sourceBounds: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
  transform: { scaleX: 7_536, scaleY: -7_536, translateX: 656, translateY: 7_864 },
  tiles: []
};

function sceneState(revision = 7): CadSceneState {
  return {
    revision,
    scene: descriptor,
    overrides: [],
    layers: [{ layerName: "LOCKED", visible: false, locked: true }]
  };
}

function tile(tileX: number): CadSceneTile {
  return {
    version: 1,
    sceneId: descriptor.id,
    tileX,
    tileY: 0,
    lod: 1,
    part: 0,
    assetId: `00000000-0000-4000-8000-00000000000${4 + tileX}`,
    primitiveCount: 1,
    byteSize: 128,
    sha256: String(tileX).repeat(64),
    bounds: { minX: tileX * 512, minY: 0, maxX: (tileX + 1) * 512, maxY: 512 }
  };
}

function decoded(descriptorTile: CadSceneTile, groupId: string | null = "group-1"): DecodedCadSceneTile {
  const startX = descriptorTile.tileX * 512;
  const elementId = "cad-element-00000000000000000000000000000001";
  return {
    descriptor: descriptorTile,
    byteSize: 128,
    batches: [{
      styleKey: JSON.stringify(["WALL", "stroke", "#111111", 1, 2]),
      layerName: "WALL",
      color: "#111111",
      opacity: 1,
      positions: new Float32Array([startX, 10, startX + 20, 10]),
      indices: new Uint32Array([0, 1]),
      spans: [{ elementId, groupId, indexStart: 0, indexCount: 2 }]
    }],
    textBatches: [],
    pickEntries: [{
      elementId,
      groupId,
      layerName: "WALL",
      bounds: { minX: startX, minY: 10, maxX: startX + 20, maxY: 10 },
      zOrder: 1,
      pointStart: 0,
      pointCount: 2,
      closed: false,
      filled: false,
      strokeWidth: 2
    }],
    pickPoints: new Float32Array([startX, 10, startX + 20, 10]),
    spatialIndex: { cellSize: 64, buckets: {} },
    memory: { cpuBytes: 128, gpuBytes: 128, textAtlasBytes: 0 }
  };
}

describe("CadSceneCanvas", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("promotes the exact pick seed when overview geometry has no metadata and raw cache admission fails", async () => {
    const source = decoded(tile(0));
    source.memory.cpuBytes = 1024;
    const releaseSourceTile = vi.fn();
    const renderer = {
      mount: vi.fn().mockResolvedValue(undefined), setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue(null),
      pickExact: vi.fn().mockResolvedValue({ ...source.pickEntries[0], sourceTile: source, releaseSourceTile }),
      setSelectionExclusion: vi.fn(), setLayerStates: vi.fn(), destroy: vi.fn()
    };
    const createRenderer = vi.fn(() => renderer);
    const ref = createRef<CadSceneCanvasHandle>();
    const onSelectionChange = vi.fn();
    render(<CadSceneCanvas ref={ref} descriptor={descriptor} sceneState={sceneState()} pan={{ x: 0, y: 0 }} zoom={1}
      viewport={{ width: 800, height: 600 }} selection={null} onSelectionChange={onSelectionChange}
      decodedCacheMaximumBytes={256} createRenderer={createRenderer}
      loadManifest={vi.fn().mockResolvedValue({ ...manifest, tileCount: 1, tiles: [source.descriptor] })} />);
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());
    expect(createRenderer).toHaveBeenCalledWith(expect.objectContaining({ displayQuality: true }));
    await expect(ref.current!.pick({ x: 10, y: 10 }, "group")).resolves.toMatchObject({ mode: "group", targetId: "group-1" });
    await expect(ref.current!.pick({ x: 10, y: 10 }, "element")).resolves.toMatchObject({
      mode: "element", element: { points: [{ x: 0, y: 10 }, { x: 20, y: 10 }],
        locator: { tileX: 0, tileY: 0, lod: 1, part: 0 }, strokeColor: "#111111" }
    });
    expect(renderer.pick).not.toHaveBeenCalled();
    expect(renderer.pickExact).toHaveBeenCalledTimes(2);
    expect(releaseSourceTile).toHaveBeenCalledTimes(2);
  });

  it.each(["camera", "scene", "next click", "unmount"])("ignores delayed exact picks after %s changes", async change => {
    const source = decoded(tile(0));
    const releaseSourceTile = vi.fn();
    let finishPick!: (value: { elementId: string; groupId: string; layerName: string; sourceTile: DecodedCadSceneTile; releaseSourceTile: () => void }) => void;
    const renderer = {
      mount: vi.fn().mockResolvedValue(undefined), setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue(null),
      pickExact: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishPick = resolve; })).mockResolvedValue(null),
      setSelectionExclusion: vi.fn(), setLayerStates: vi.fn(), destroy: vi.fn()
    };
    const ref = createRef<CadSceneCanvasHandle>();
    const onSelectionChange = vi.fn();
    const props = { descriptor, sceneState: sceneState(), pan: { x: 0, y: 0 }, zoom: 1,
      viewport: { width: 800, height: 600 }, selection: null, onSelectionChange,
      createRenderer: () => renderer, loadManifest: vi.fn().mockResolvedValue({ ...manifest, tileCount: 1, tiles: [source.descriptor] }) };
    const view = render(<CadSceneCanvas ref={ref} {...props} />);
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());
    const pending = ref.current!.pick({ x: 10, y: 10 }, "element");
    expect(renderer.pickExact).toHaveBeenCalledTimes(1);
    if (change === "camera") view.rerender(<CadSceneCanvas ref={ref} {...props} pan={{ x: -100, y: 0 }} />);
    if (change === "scene") view.rerender(<CadSceneCanvas ref={ref} {...props} sceneState={sceneState(8)} />);
    if (change === "next click") await ref.current!.pick({ x: 700, y: 500 }, "element");
    if (change === "unmount") view.unmount();
    onSelectionChange.mockClear();
    await act(async () => {
      finishPick({ elementId: source.pickEntries[0].elementId, groupId: "group-1", layerName: "WALL", sourceTile: source, releaseSourceTile });
      expect(await pending).toBeNull();
    });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(releaseSourceTile).toHaveBeenCalledOnce();
  });

  it.each([false, true])("handles rejected exact picks without surfacing stale errors (stale=%s)", async stale => {
    let rejectPick!: (error: Error) => void;
    const renderer = {
      mount: vi.fn().mockResolvedValue(undefined), setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue(null), pickExact: vi.fn(() => new Promise<null>((_resolve, reject) => { rejectPick = reject; })),
      setSelectionExclusion: vi.fn(), setLayerStates: vi.fn(), destroy: vi.fn()
    };
    const ref = createRef<CadSceneCanvasHandle>();
    const onError = vi.fn(), onSelectionChange = vi.fn();
    const props = { descriptor, sceneState: sceneState(), pan: { x: 0, y: 0 }, zoom: 1,
      viewport: { width: 800, height: 600 }, selection: null, onSelectionChange, onError,
      createRenderer: () => renderer, loadManifest: vi.fn().mockResolvedValue(manifest) };
    const view = render(<CadSceneCanvas ref={ref} {...props} />);
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());
    const pending = ref.current!.pick({ x: 10, y: 10 }, "element");
    if (stale) view.rerender(<CadSceneCanvas ref={ref} {...props} pan={{ x: -100, y: 0 }} />);
    const error = new Error("exact tile unavailable");
    await act(async () => { rejectPick(error); await expect(pending).resolves.toBeNull(); });
    if (stale) expect(onError).not.toHaveBeenCalled();
    else expect(onError).toHaveBeenCalledWith(error);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("offers an explicit retry when the native scene cannot load", async () => {
    const loadManifest = vi.fn().mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValue(manifest);
    const renderer = {
      mount: vi.fn().mockResolvedValue(undefined), setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn(), setSelectionExclusion: vi.fn(), setLayerStates: vi.fn(), destroy: vi.fn()
    };
    render(<CadSceneCanvas descriptor={descriptor} sceneState={sceneState()} pan={{ x: 0, y: 0 }} zoom={1}
      viewport={{ width: 800, height: 600 }} selection={null} onSelectionChange={vi.fn()}
      loadManifest={loadManifest} createRenderer={() => renderer} />);
    expect(await screen.findByText("CAD 맵을 표시하지 못했습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CAD 맵 다시 시도" }));
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());
    expect(screen.queryByText("CAD 맵을 표시하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("keeps Pixi camera synchronized and destroys every replaced renderer", async () => {
    const renderers: CadSceneRendererLike[] = [];
    const createRenderer = vi.fn(() => {
      const renderer: CadSceneRendererLike = {
        mount: vi.fn().mockResolvedValue(undefined),
        setCamera: vi.fn().mockResolvedValue(undefined),
        pick: vi.fn().mockReturnValue(null),
        setSelectionExclusion: vi.fn(),
        setLayerStates: vi.fn(),
        destroy: vi.fn()
      };
      renderers.push(renderer);
      return renderer;
    });
    const loadManifest = vi.fn().mockResolvedValue(manifest);
    const ref = createRef<CadSceneCanvasHandle>();
    const props = {
      descriptor,
      sceneState: sceneState(),
      pan: { x: -100, y: -50 },
      zoom: 2,
      viewport: { width: 800, height: 600 },
      selection: null,
      onSelectionChange: vi.fn(),
      loadManifest,
      loadTile: vi.fn(),
      createRenderer
    } as const;
    const view = render(<CadSceneCanvas ref={ref} {...props} />);

    await waitFor(() => expect(renderers).toHaveLength(1));
    await waitFor(() => expect(renderers[0].setCamera).toHaveBeenLastCalledWith({
      centerX: 250,
      centerY: 175,
      zoom: 2,
      viewportWidth: 800,
      viewportHeight: 600
    }));
    expect(renderers[0].setLayerStates).toHaveBeenCalledWith(new Map([
      ["LOCKED", { visible: false }]
    ]));

    view.rerender(<CadSceneCanvas ref={ref} {...props} pan={{ x: -300, y: -100 }} zoom={1} />);
    await waitFor(() => expect(renderers[0].setCamera).toHaveBeenLastCalledWith({
      centerX: 700,
      centerY: 400,
      zoom: 1,
      viewportWidth: 800,
      viewportHeight: 600
    }));

    view.rerender(<CadSceneCanvas ref={ref} {...props} sceneState={sceneState(8)} />);
    await waitFor(() => expect(renderers).toHaveLength(2));
    expect(renderers[0].destroy).toHaveBeenCalledOnce();
    const oldCanvas = vi.mocked(renderers[0].mount).mock.calls[0][0];
    const newCanvas = vi.mocked(renderers[1].mount).mock.calls[0][0];
    expect(newCanvas).not.toBe(oldCanvas);
    expect(oldCanvas.isConnected).toBe(false);
    expect(newCanvas.isConnected).toBe(true);

    view.unmount();
    expect(renderers[1].destroy).toHaveBeenCalledOnce();
  });

  it("excludes only a promoted CAD element and demotes it on clear", async () => {
    const renderer: CadSceneRendererLike = {
      mount: vi.fn().mockResolvedValue(undefined),
      setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue(null),
      registerSourceBounds: vi.fn(),
      setSelectionExclusion: vi.fn(),
      setLayerStates: vi.fn(),
      destroy: vi.fn()
    };
    const base = {
      descriptor,
      sceneState: sceneState(),
      pan: { x: 0, y: 0 },
      zoom: 1,
      viewport: { width: 800, height: 600 },
      onSelectionChange: vi.fn(),
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadTile: vi.fn(),
      createRenderer: () => renderer
    } as const;
    const selection = {
      mode: "element" as const,
      targetId: "cad-element-00000000000000000000000000000001",
      element: {
        elementId: "cad-element-00000000000000000000000000000001",
        groupId: "group-1",
        layerName: "WALL",
        locator: { tileX: 0, tileY: 0, lod: 1 as const, part: 0 },
        bounds: { minX: 0, minY: 10, maxX: 20, maxY: 10 },
        points: [{ x: 0, y: 10 }, { x: 20, y: 10 }],
        fragments: [{ points: [{ x: 0, y: 10 }, { x: 20, y: 10 }], closed: false }],
        closed: false,
        text: null,
        fontSize: null,
        textGeometry: null,
        strokeColor: "#111111",
        fillColor: null,
        strokeWidth: 2,
        zOrder: 1,
        override: null
      }
    };
    const view = render(<CadSceneCanvas {...base} selection={selection} />);
    await waitFor(() => expect(renderer.setSelectionExclusion).toHaveBeenCalledWith(new Set([
      selection.targetId
    ])));
    expect(renderer.registerSourceBounds).toHaveBeenCalledWith(selection.targetId, selection.element.bounds);

    await act(async () => view.rerender(<CadSceneCanvas {...base} selection={null} />));
    expect(renderer.setSelectionExclusion).toHaveBeenLastCalledWith(new Set());
  });

  it("selects a group on click but does not exclude an element that cannot be promoted", async () => {
    const onSelectionChange = vi.fn();
    const renderer: CadSceneRendererLike = {
      mount: vi.fn().mockResolvedValue(undefined),
      setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue({
        elementId: "cad-element-00000000000000000000000000000001",
        groupId: "group-1",
        layerName: "WALL"
      }),
      setSelectionExclusion: vi.fn(),
      setLayerStates: vi.fn(),
      destroy: vi.fn()
    };
    const ref = createRef<CadSceneCanvasHandle>();
    render(
      <CadSceneCanvas
        ref={ref}
        descriptor={descriptor}
        sceneState={sceneState()}
        pan={{ x: 0, y: 0 }}
        zoom={1}
        viewport={{ width: 800, height: 600 }}
        selection={null}
        onSelectionChange={onSelectionChange}
        loadManifest={vi.fn().mockResolvedValue(manifest)}
        loadTile={vi.fn()}
        createRenderer={() => renderer}
      />
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    await expect(ref.current!.pick({ x: 10, y: 20 }, "group")).resolves.toMatchObject({
      mode: "group",
      targetId: "group-1"
    });
    await expect(ref.current!.pick({ x: 10, y: 20 }, "element")).resolves.toBeNull();

    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });

  it("promotes a standalone native element on a single click without a group drilldown", async () => {
    const onSelectionChange = vi.fn();
    const source = decoded(tile(0), null);
    const renderer: CadSceneRendererLike = {
      mount: vi.fn().mockResolvedValue(undefined),
      setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue({
        elementId: "cad-element-00000000000000000000000000000001",
        groupId: null,
        layerName: "WALL"
      }),
      pickExact: vi.fn().mockResolvedValue({ ...source.pickEntries[0], sourceTile: source }),
      setSelectionExclusion: vi.fn(),
      setLayerStates: vi.fn(),
      destroy: vi.fn()
    };
    const ref = createRef<CadSceneCanvasHandle>();
    render(<CadSceneCanvas ref={ref} descriptor={descriptor} sceneState={sceneState()} pan={{ x: 0, y: 0 }} zoom={1}
      viewport={{ width: 800, height: 600 }} selection={null} onSelectionChange={onSelectionChange}
      loadManifest={vi.fn().mockResolvedValue({ ...manifest, tileCount: 1, tiles: [source.descriptor] })} loadTile={vi.fn()} createRenderer={() => renderer} />);
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());

    await expect(ref.current!.pick({ x: 10, y: 10 }, "group")).resolves.toMatchObject({
      mode: "element", targetId: source.pickEntries[0].elementId,
      element: { groupId: null, points: [{ x: 0, y: 10 }, { x: 20, y: 10 }] }
    });
    expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "element" }));
  });

  it("queues the latest camera until mount is ready", async () => {
    let finishMount!: () => void;
    const mountPromise = new Promise<void>((resolve) => { finishMount = resolve; });
    const renderer: CadSceneRendererLike = {
      mount: vi.fn(() => mountPromise),
      setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue(null),
      setSelectionExclusion: vi.fn(),
      setLayerStates: vi.fn(),
      destroy: vi.fn()
    };
    const base = {
      descriptor,
      sceneState: sceneState(),
      viewport: { width: 800, height: 600 },
      selection: null,
      onSelectionChange: vi.fn(),
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadTile: vi.fn(),
      createRenderer: () => renderer
    } as const;
    const view = render(<CadSceneCanvas {...base} pan={{ x: 0, y: 0 }} zoom={1} />);
    await waitFor(() => expect(renderer.mount).toHaveBeenCalled());
    view.rerender(<CadSceneCanvas {...base} pan={{ x: -300, y: -100 }} zoom={2} />);
    expect(renderer.setCamera).not.toHaveBeenCalled();

    finishMount();
    await waitFor(() => expect(renderer.setCamera).toHaveBeenLastCalledWith({
      centerX: 350,
      centerY: 200,
      zoom: 2,
      viewportWidth: 800,
      viewportHeight: 600
    }));
  });

  it("promotes all decoded fragments and picks a persisted move at its destination", async () => {
    const tiles = [tile(0), tile(1)];
    const manifestWithTiles = { ...manifest, tileCount: 2, tiles };
    const rawWorker: CadSceneWorkerClient = {
      decode: vi.fn(async (_payload, descriptorTile) => decoded(descriptorTile)),
      destroy: vi.fn()
    };
    let rendererOptions!: CadSceneRendererOptions;
    const renderer: CadSceneRendererLike = {
      mount: vi.fn(async () => {
        await rendererOptions.worker!.decode(new Uint8Array([1]), tiles[0]);
        await rendererOptions.worker!.decode(new Uint8Array([2]), tiles[1]);
      }),
      setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue({
        elementId: "cad-element-00000000000000000000000000000001",
        groupId: "group-1",
        layerName: "WALL"
      }),
      setSelectionExclusion: vi.fn(),
      setLayerStates: vi.fn(),
      destroy: vi.fn()
    };
    const createRenderer = (options: CadSceneRendererOptions) => {
      rendererOptions = options;
      return renderer;
    };
    const movedState: CadSceneState = {
      ...sceneState(),
      overrides: [{
        elementId: "cad-element-00000000000000000000000000000001",
        hidden: false,
        transform: { translateX: 600, translateY: 100, scaleX: 1, scaleY: 1, rotation: 0 },
        strokeColor: null,
        fillColor: null,
        strokeWidth: null,
        text: null
      }]
    };
    const onSelectionChange = vi.fn();
    const ref = createRef<CadSceneCanvasHandle>();
    render(<CadSceneCanvas ref={ref} descriptor={descriptor} sceneState={movedState} pan={{ x: 0, y: 0 }} zoom={1}
      viewport={{ width: 1600, height: 600 }} selection={null} onSelectionChange={onSelectionChange}
      loadManifest={vi.fn().mockResolvedValue(manifestWithTiles)} loadTile={vi.fn().mockResolvedValue(new Uint8Array([1]))}
      createRenderer={createRenderer} createWorker={() => rawWorker} />);
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());

    const selected = await ref.current!.pick({ x: 610, y: 110 }, "element");
    expect(selected).toMatchObject({ mode: "element", element: { bounds: { minX: 0, maxX: 532 } } });
    expect((selected as { element: { fragments: unknown[] } }).element.fragments).toHaveLength(2);
    expect(renderer.pick).not.toHaveBeenCalled();
    expect(renderer.setSelectionExclusion).toHaveBeenCalledWith(new Set([
      "cad-element-00000000000000000000000000000001"
    ]));
  });

  it("bounds and clears the decoded tile cache", () => {
    const budget = new CadSceneMemoryBudget(200);
    const store = new CadDecodedTileStore(budget);
    store.set(decoded(tile(0)));
    store.set(decoded(tile(1)));
    expect([...store.values()]).toHaveLength(1);
    expect(store.totalBytes).toBeLessThanOrEqual(200);
    store.clear();
    expect([...store.values()]).toHaveLength(0);
    expect(budget.totalBytes).toBe(0);
  });

  it("does not restore an older camera when moved-element preloading finishes late", async () => {
    let resolveTile!: (value: Uint8Array) => void;
    const loadTile = vi.fn(() => new Promise<Uint8Array>(resolve => { resolveTile = resolve; }));
    const renderer: CadSceneRendererLike = {
      mount: vi.fn().mockResolvedValue(undefined), setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn(), setSelectionExclusion: vi.fn(), setLayerStates: vi.fn(), destroy: vi.fn()
    };
    const sourceTile = tile(0);
    const state: CadSceneState = { ...sceneState(), overrides: [{
      elementId: "cad-element-00000000000000000000000000000001",
      locator: { tileX: 0, tileY: 0, lod: 1, part: 0 }, hidden: false,
      transform: { translateX: 600, translateY: 100, scaleX: 1, scaleY: 1, rotation: 0 },
      strokeColor: null, fillColor: null, strokeWidth: null, text: null
    }] };
    const worker = { decode: vi.fn(async () => decoded(sourceTile)), destroy: vi.fn() };
    const props = {
      descriptor, sceneState: state, zoom: 1, viewport: { width: 800, height: 600 }, selection: null,
      onSelectionChange: vi.fn(), createRenderer: () => renderer, createWorker: () => worker,
      loadManifest: vi.fn().mockResolvedValue({ ...manifest, tileCount: 1, tiles: [sourceTile] }), loadTile
    };
    const view = render(<CadSceneCanvas {...props} pan={{ x: -2000, y: 0 }} />);
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());
    view.rerender(<CadSceneCanvas {...props} pan={{ x: 0, y: 0 }} />);
    await waitFor(() => expect(loadTile).toHaveBeenCalledTimes(1));
    view.rerender(<CadSceneCanvas {...props} pan={{ x: -3000, y: 0 }} />);
    await waitFor(() => expect(renderer.setCamera).toHaveBeenLastCalledWith(expect.objectContaining({ centerX: 3400 })));
    await act(async () => { resolveTile(new Uint8Array([1])); });
    expect(renderer.setCamera).toHaveBeenLastCalledWith(expect.objectContaining({ centerX: 3400 }));
  });

  it("cold-preloads only the locator tile for a moved override and renders it at the destination", async () => {
    const sourceTile = tile(0);
    const unrelatedTile = tile(7);
    const manifestWithTiles = { ...manifest, tileCount: 2, tiles: [sourceTile, unrelatedTile] };
    const rawWorker: CadSceneWorkerClient = {
      decode: vi.fn(async (_payload, descriptorTile) => decoded(descriptorTile)),
      destroy: vi.fn()
    };
    const renderer: CadSceneRendererLike = {
      mount: vi.fn().mockResolvedValue(undefined),
      setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue(null),
      setSelectionExclusion: vi.fn(),
      setLayerStates: vi.fn(),
      destroy: vi.fn()
    };
    const loadTile = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const state: CadSceneState = {
      ...sceneState(),
      overrides: [{
        elementId: "cad-element-00000000000000000000000000000001",
        locator: { tileX: 0, tileY: 0, lod: 1, part: 0 },
        hidden: false,
        transform: { translateX: 600, translateY: 100, scaleX: 1, scaleY: 1, rotation: 0 },
        strokeColor: null,
        fillColor: null,
        strokeWidth: null,
        text: null
      }]
    };
    const ref = createRef<CadSceneCanvasHandle>();
    render(<CadSceneCanvas ref={ref} descriptor={descriptor} sceneState={state} pan={{ x: 0, y: 0 }} zoom={1}
      viewport={{ width: 800, height: 600 }} selection={null} onSelectionChange={vi.fn()}
      loadManifest={vi.fn().mockResolvedValue(manifestWithTiles)} loadTile={loadTile}
      createRenderer={() => renderer} createWorker={() => rawWorker} />);

    await waitFor(() => expect(loadTile).toHaveBeenCalledTimes(1));
    expect(loadTile.mock.calls[0][0]).toContain("/1/0/0/0/content");
    expect(await ref.current!.pick({ x: 610, y: 110 }, "element")).toMatchObject({ mode: "element" });
    expect(loadTile.mock.calls.some(([path]) => String(path).includes("/1/7/0/0/content"))).toBe(false);
  });

  it("does not draw or pick a moved element on a hidden CAD layer", async () => {
    const sourceTile = tile(0);
    const state: CadSceneState = {
      ...sceneState(),
      layers: [{ layerName: "WALL", visible: false, locked: false }],
      overrides: [{
        elementId: "cad-element-00000000000000000000000000000001",
        locator: { tileX: 0, tileY: 0, lod: 1, part: 0 },
        hidden: false,
        transform: { translateX: 600, translateY: 100, scaleX: 1, scaleY: 1, rotation: 0 },
        strokeColor: null,
        fillColor: null,
        strokeWidth: null,
        text: null
      }]
    };
    const rawWorker: CadSceneWorkerClient = {
      decode: vi.fn(async (_payload, descriptorTile) => decoded(descriptorTile)),
      destroy: vi.fn()
    };
    const renderer: CadSceneRendererLike = {
      mount: vi.fn().mockResolvedValue(undefined), setCamera: vi.fn().mockResolvedValue(undefined),
      pick: vi.fn().mockReturnValue(null), setSelectionExclusion: vi.fn(), setLayerStates: vi.fn(), destroy: vi.fn()
    };
    const ref = createRef<CadSceneCanvasHandle>();
    const view = render(<CadSceneCanvas ref={ref} descriptor={descriptor} sceneState={state} pan={{ x: 0, y: 0 }} zoom={1}
      viewport={{ width: 800, height: 600 }} selection={null} onSelectionChange={vi.fn()}
      loadManifest={vi.fn().mockResolvedValue({ ...manifest, tileCount: 1, tiles: [sourceTile] })}
      loadTile={vi.fn().mockResolvedValue(new Uint8Array([1]))} createRenderer={() => renderer}
      createWorker={() => rawWorker} />);
    await waitFor(() => expect(renderer.setCamera).toHaveBeenCalled());
    expect(await ref.current!.pick({ x: 610, y: 110 }, "element")).toBeNull();
    expect(view.container.querySelector('[data-testid="cad-moved-elements-canvas"]'))
      .toHaveAttribute("data-visible-element-count", "0");
  });
});
