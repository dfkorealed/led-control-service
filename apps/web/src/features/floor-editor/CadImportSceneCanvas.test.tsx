import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CadSceneManifest } from "@led-control/shared";
import type { PropsWithChildren } from "react";
import { CadImportSceneCanvas, useCadImportScene } from "./CadImportSceneCanvas";
import type { CadImportReviewState } from "./editor-types";

const api = vi.hoisted(() => ({ getCadSceneManifest: vi.fn(), getCadSceneTile: vi.fn() }));
const runtime = vi.hoisted(() => ({ createReadOnlyCadSceneRenderer: vi.fn() }));
vi.mock("../../api/floor-editor", () => api);
vi.mock("../floor-map/cad-scene-readonly-runtime", () => runtime);

const manifest: CadSceneManifest = {
  version: 1, sceneId: "00000000-0000-4000-8000-000000000001", regionId: "region-selected",
  manifestAssetId: "00000000-0000-4000-8000-000000000002", width: 16384, height: 8192,
  padding: 328, gridSize: 80, tileSize: 512, lodMode: "additive", primitiveCount: 0,
  tileCount: 0, byteSize: 1, sha256: "0".repeat(64), tiles: [],
  sourceBounds: { minX: 5000, minY: 7000, maxX: 5002, maxY: 7001 },
  transform: { scaleX: 7536, scaleY: -7536, translateX: -37679344, translateY: 52759864 }
};
const review: CadImportReviewState = {
  scene: { kind: "native", regionId: manifest.regionId }, candidates: [], acceptedCandidateIds: [],
  job: {
    jobId: "job-1", floorId: "floor-1", sourceAssetId: "source", renderedAssetId: "svg",
    sourceFormat: "dwg", status: "review_required", stage: "review_required", progressPercent: 100,
    attemptCount: 1, parserVersion: "ascii-dxf-stream-v2", detectorVersion: "rules", failureCode: null,
    sourceAssetPath: "/source", renderedAssetPath: "/full-source.svg", renderedViewport: { width: 640, height: 360 },
    startedAt: null, reviewRequiredAt: null, appliedAt: null, completedAt: null, failedAt: null, cancelledAt: null,
    createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z"
  }
};

function wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>;
}
function renderer() {
  return { mount: vi.fn(async (_canvas: HTMLCanvasElement) => {}), setCamera: vi.fn().mockResolvedValue(undefined),
    setLayerStates: vi.fn(), destroy: vi.fn() };
}
const props = { floorId: "floor-1", jobId: "job-1", manifest, pan: { x: 20, y: 40 },
  zoom: 0.5, viewport: { width: 800, height: 600 } };

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("native import review scene", () => {
  it("uses the job manifest dimensions rather than the legacy SVG viewport", async () => {
    api.getCadSceneManifest.mockResolvedValue(manifest);
    const { result } = renderHook(() => useCadImportScene("floor-1", review), { wrapper });
    await waitFor(() => expect(result.current.data?.width).toBe(16384));
    expect(result.current.data?.height).toBe(8192);
    expect(api.getCadSceneManifest).toHaveBeenCalledWith("/floors/floor-1/import-jobs/job-1/scene/manifest/content", expect.any(AbortSignal));
  });

  it.each([undefined, { kind: "legacy" as const }])("does not infer native or legacy from unresolved context %s", async scene => {
    const { result } = renderHook(() => useCadImportScene("floor-1", { ...review, scene }), { wrapper });
    expect(result.current.data).toBeUndefined();
    expect(api.getCadSceneManifest).not.toHaveBeenCalled();
  });

  it("rejects another region and exposes retry without an SVG fallback", async () => {
    api.getCadSceneManifest.mockResolvedValueOnce({ ...manifest, regionId: "other" }).mockResolvedValueOnce(manifest);
    const { result } = renderHook(() => useCadImportScene("floor-1", review), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.data).toEqual(manifest));
  });

  it.each(["floor", "job"])("aborts a pending manifest and ignores its late result after %s changes", async change => {
    let finish!: (value: CadSceneManifest) => void;
    let oldSignal!: AbortSignal;
    api.getCadSceneManifest.mockImplementationOnce((_path, signal) => {
      oldSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    }).mockResolvedValueOnce({ ...manifest, sceneId: "new-scene" });
    const { result, rerender } = renderHook(({ floorId, value }) => useCadImportScene(floorId, value),
      { wrapper, initialProps: { floorId: "floor-1", value: review } });
    await waitFor(() => expect(oldSignal).toBeDefined());
    const floorId = change === "floor" ? "floor-2" : "floor-1";
    rerender({ floorId, value: { ...review, job: { ...review.job, floorId, jobId: "job-2" } } });
    await waitFor(() => expect(result.current.data?.sceneId).toBe("new-scene"));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { finish(manifest); });
    expect(result.current.data?.sceneId).toBe("new-scene");
  });

  it("mounts on a fresh canvas and uses the latest camera after async initialization", async () => {
    const target = renderer();
    let finishMount!: () => void;
    target.mount.mockImplementationOnce(() => new Promise<void>(resolve => { finishMount = resolve; }));
    runtime.createReadOnlyCadSceneRenderer.mockResolvedValue(target);
    const view = render(<CadImportSceneCanvas {...props} />);
    await waitFor(() => expect(target.mount).toHaveBeenCalledOnce());
    const firstCanvas = target.mount.mock.calls[0][0] as HTMLCanvasElement;
    view.rerender(<CadImportSceneCanvas {...props} pan={{ x: 100, y: 150 }} zoom={2} />);
    await act(async () => { finishMount(); });
    expect(target.setCamera).toHaveBeenLastCalledWith({ centerX: 150, centerY: 75, zoom: 2, viewportWidth: 800, viewportHeight: 600 });
    expect(runtime.createReadOnlyCadSceneRenderer).toHaveBeenCalledWith(expect.objectContaining({ platform: "mobile" }), new Map());
    view.unmount();
    expect(target.destroy).toHaveBeenCalledOnce();
    expect(firstCanvas.isConnected).toBe(false);
  });

  it("destroys a late renderer after unmount without mounting it", async () => {
    const target = renderer();
    let finish!: (value: ReturnType<typeof renderer>) => void;
    runtime.createReadOnlyCadSceneRenderer.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<CadImportSceneCanvas {...props} />);
    view.unmount();
    await act(async () => { finish(target); });
    expect(target.destroy).toHaveBeenCalledOnce();
    expect(target.mount).not.toHaveBeenCalled();
  });

  it("retries renderer failure on a new canvas without a legacy image", async () => {
    const first = renderer(), second = renderer();
    first.mount.mockRejectedValueOnce(new Error("WebGL initialization failed"));
    runtime.createReadOnlyCadSceneRenderer.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    render(<CadImportSceneCanvas {...props} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "도면 다시 불러오기" }));
    await waitFor(() => expect(second.setCamera).toHaveBeenCalledOnce());
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(first.mount.mock.calls[0][0]).not.toBe(second.mount.mock.calls[0][0]);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
