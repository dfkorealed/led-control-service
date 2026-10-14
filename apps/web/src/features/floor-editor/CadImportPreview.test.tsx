import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CadImportReviewState } from "./editor-types";
import { CadImportPreview } from "./CadImportPreview";
import { useFloorEditorStore } from "./editor-store";
import type { ReactNode } from "react";

const preview = vi.hoisted(() => ({ scene: vi.fn(), image: vi.fn(), retry: vi.fn(),
  draw: null as (() => void) | null,
  displayChange: null as ((state: "loading" | "ready" | "error") => void) | null }));
vi.mock("react-konva", () => ({
  Stage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Layer: ({ children, onDraw }: { children: ReactNode; onDraw?: () => void }) => { preview.draw = onDraw ?? null; return <div>{children}</div>; },
  Image: () => <canvas data-testid="legacy-import-renderer" />
}));
vi.mock("./use-floor-plan-image", () => ({ useFloorPlanImage: preview.image }));
vi.mock("./CadImportSceneCanvas", async () => {
  return { useCadImportScene: preview.scene, CadImportSceneCanvas: (props: { onDisplayStateChange: typeof preview.displayChange }) => {
    preview.displayChange = props.onDisplayStateChange;
    return <canvas data-testid="native-import-renderer" />;
  } };
});
vi.mock("./CadCandidateLayer", () => ({ CadCandidateLayer: (props: { candidates: unknown[]; disabled?: boolean }) =>
  <div data-testid="preview-candidates" data-count={props.candidates.length} data-disabled={props.disabled} /> }));

const review = {
  job: { floorId: "floor-1", jobId: "import-1", renderedViewport: { width: 16000, height: 8000 }, renderedAssetPath: "/legacy.svg",
    sourceAssetId: "source", renderedAssetId: "rendered", sourceFormat: "dxf", status: "review_required", stage: "review_required",
    progressPercent: 100, attemptCount: 1, parserVersion: null, detectorVersion: null, failureCode: null,
    sourceAssetPath: "/source.dxf", startedAt: null, reviewRequiredAt: null, appliedAt: null, completedAt: null,
    failedAt: null, cancelledAt: null, createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z" },
  scene: { kind: "legacy" }, candidates: [{ id: "candidate-1", x: 100, y: 120, sourceEntityId: "entity-1", layerName: "LIGHT", blockName: null,
    rotation: 0, confidence: 1, detectionMethod: "rule_based", provider: null, model: null, inputDigest: null,
    profileVersion: "test", profileDigest: "a".repeat(64), reviewStatus: "pending" }], acceptedCandidateIds: []
} satisfies CadImportReviewState;

describe("CadImportPreview", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    preview.scene.mockReturnValue({ data: undefined, isError: false, refetch: preview.retry });
    preview.image.mockReturnValue({ image: null, status: "loading", retry: preview.retry });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 400));
    preview.displayChange = null;
    preview.draw = null;
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("waits for legacy pixels and fits the diagram without historical candidate markers or editor camera changes", async () => {
    const camera = { pan: useFloorEditorStore.getState().pan, zoom: useFloorEditorStore.getState().zoom };
    const ready = vi.fn();
    const view = render(<CadImportPreview floorId="floor-1" review={review} onReadyChange={ready} />);
    expect(ready).toHaveBeenLastCalledWith(false);
    preview.image.mockReturnValue({ image: new Image(), status: "ready", retry: preview.retry });
    view.rerender(<CadImportPreview floorId="floor-1" review={review} onReadyChange={ready} />);
    expect(ready).toHaveBeenLastCalledWith(false);
    act(() => preview.draw?.());
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
    expect(screen.queryByTestId("preview-candidates")).not.toBeInTheDocument();
    expect(useFloorEditorStore.getState().pan).toEqual(camera.pan);
    expect(useFloorEditorStore.getState().zoom).toBe(camera.zoom);
    expect(screen.getByRole("region", { name: "CAD 도면 미리보기" })).toHaveAttribute("data-zoom", "0.044");
  });

  it("uses one shared overlay through legacy image wait and removes it only after canvas draw", () => {
    const ready = vi.fn();
    const view = render(<CadImportPreview floorId="floor-1" review={review} onReadyChange={ready} />);
    expect(screen.getByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
    preview.image.mockReturnValue({ image: new Image(), status: "ready", retry: preview.retry });
    view.rerender(<CadImportPreview floorId="floor-1" review={review} onReadyChange={ready} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    act(() => preview.draw?.());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const oldDraw = preview.draw;
    view.rerender(<CadImportPreview floorId="floor-2" review={{ ...review, job: { ...review.job, jobId: "import-2" } }} onReadyChange={ready} />);
    act(() => oldDraw?.());
    expect(screen.getByRole("status")).toBeInTheDocument();
    preview.image.mockReturnValue({ image: null, status: "error", retry: preview.retry });
    view.rerender(<CadImportPreview floorId="floor-2" review={{ ...review, job: { ...review.job, jobId: "import-2" } }} onReadyChange={ready} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("hands native data wait to the canvas without duplicate overlays or stale job readiness", () => {
    const nativeReview = { ...review, scene: { kind: "native" as const, regionId: "region-1" } };
    const ready = vi.fn();
    const view = render(<CadImportPreview floorId="floor-1" review={nativeReview} onReadyChange={ready} />);
    expect(screen.getByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
    preview.scene.mockReturnValue({ data: { width: 16000, height: 8000, generationId: "prepared" }, isError: false, refetch: preview.retry });
    view.rerender(<CadImportPreview floorId="floor-1" review={nativeReview} onReadyChange={ready} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => preview.displayChange?.("ready"));
    const old = preview.displayChange;
    view.rerender(<CadImportPreview floorId="floor-1" review={{ ...nativeReview, job: { ...review.job, jobId: "import-2" } }} onReadyChange={ready} />);
    act(() => old?.("ready"));
    expect(ready).toHaveBeenLastCalledWith(false);
  });

  it("keeps native apply blocked until the existing renderer reports ready, and blocks again on display failure", async () => {
    const nativeReview = { ...review, scene: { kind: "native" as const, regionId: "region-1" } };
    preview.scene.mockReturnValue({ data: { width: 16000, height: 8000, generationId: "prepared" }, isError: false, refetch: preview.retry });
    const ready = vi.fn();
    const view = render(<CadImportPreview floorId="floor-1" review={nativeReview} onReadyChange={ready} />);
    expect(screen.getByTestId("native-import-renderer")).toBeVisible();
    expect(ready).toHaveBeenLastCalledWith(false);
    act(() => preview.displayChange?.("ready"));
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true));
    act(() => preview.displayChange?.("error"));
    await waitFor(() => expect(ready).toHaveBeenLastCalledWith(false));
  });

  it("offers explicit legacy retry after image failure and never falls back to legacy for native failure", () => {
    preview.image.mockReturnValue({ image: null, status: "error", retry: preview.retry });
    const ready = vi.fn();
    const view = render(<CadImportPreview floorId="floor-1" review={review} onReadyChange={ready} />);
    fireEvent.click(screen.getByRole("button", { name: "도면 다시 불러오기" }));
    expect(preview.retry).toHaveBeenCalledOnce();
    preview.scene.mockReturnValue({ data: undefined, isError: true, refetch: preview.retry });
    view.rerender(<CadImportPreview floorId="floor-1" review={{ ...review, scene: { kind: "native", regionId: "region-1" } }} onReadyChange={ready} />);
    expect(preview.image).toHaveBeenLastCalledWith("");
    expect(ready).toHaveBeenLastCalledWith(false);
  });
});
