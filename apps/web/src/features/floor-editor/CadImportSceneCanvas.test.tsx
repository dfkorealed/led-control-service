import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PropsWithChildren } from "react";
import type { MapDocumentRef } from "@led-control/shared/map-document-contracts";
import type { MapSceneCanvasProps } from "../map-scene/MapSceneCanvas";
import { createMapDocumentSource } from "../../api/map-document";
import { CadImportSceneCanvas, useCadImportScene } from "./CadImportSceneCanvas";
import type { CadImportReviewState } from "./editor-types";
import { editorDraftGeneration } from "./editor-drafts";

const canvas = vi.hoisted(() => ({ props: null as MapSceneCanvasProps | null }));
vi.mock("../map-scene/MapSceneCanvas", () => ({ MapSceneCanvas: (props: MapSceneCanvasProps) => {
  canvas.props = props; return <canvas data-testid="common-preview" />;
} }));
const ref: MapDocumentRef = { formatVersion: 1, generationId: "prepared", revision: 0,
  width: 16384, height: 8192, gridSize: 80, elementCount: 0,
  manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
const review: CadImportReviewState = {
  scene: { kind: "native", regionId: "selected" }, candidates: [], acceptedCandidateIds: [],
  job: { jobId: "job-1", floorId: "floor-1", sourceAssetId: "source", renderedAssetId: null,
    sourceFormat: "dwg", status: "review_required", stage: "review_required", progressPercent: 100,
    attemptCount: 1, parserVersion: "ascii-dxf-stream-v2", detectorVersion: "rules", failureCode: null,
    sourceAssetPath: "/source", renderedAssetPath: null, renderedViewport: null,
    startedAt: null, reviewRequiredAt: null, appliedAt: null, completedAt: null, failedAt: null, cancelledAt: null,
    createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z" }
};
const capabilities = { read: true, manage: true, control: true, commission: true };
const authScope = () => JSON.stringify(["org", "user", "admin", editorDraftGeneration(), "site", capabilities]);
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["auth", "me"], { user: { id: "user", organizationId: "org", role: "admin", status: "active" } });
  client.setQueryData(["dashboard", "site"], { site: { id: "site" }, floors: [{ id: "floor-1" }, { id: "floor-2" }], capabilities });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={["/settings?siteId=site"]}>{children}</MemoryRouter>
  </QueryClientProvider>;
  return { client, wrapper };
}
function payload(document = ref, regionId = "selected") {
  return { generationId: document.generationId, revision: document.revision, canonical: document.manifest,
    groups: [], layers: [], displayLayerBindings: [], display: {
      version: 2, sceneId: "00000000-0000-4000-8000-000000000001", regionId,
      manifestAssetId: "00000000-0000-4000-8000-000000000002", width: document.width, height: document.height,
      padding: 0, gridSize: document.gridSize, tileSize: 512, lodMode: "additive", primitiveCount: 0,
      tileCount: 0, byteSize: 1, sha256: "a".repeat(64), tiles: [],
      sourceBounds: { minX: 0, minY: 0, maxX: document.width, maxY: document.height },
      transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }
    } };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
function installFetch() {
  const fetcher = vi.fn(async (input: string, _options?: RequestInit) => {
    if (!input.startsWith("/api/floors/floor-1/import-jobs/job-1/map-document")) throw new Error(`Unexpected route: ${input}`);
    return json(input.includes("/manifest?") ? payload() : ref);
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); canvas.props = null; });

describe("prepared import common document", () => {
  it("loads the job document and selected region without legacy assets or the active map", async () => {
    const fetcher = installFetch(); const { wrapper, client } = setup();
    const { result } = renderHook(() => useCadImportScene("floor-1", review), { wrapper });
    await waitFor(() => expect(result.current.data).toMatchObject({ generationId: "prepared", width: 16384, height: 8192,
      source: { scopeKey: JSON.stringify([authScope(), "floor-1", "job-1"]) } }));
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      "/api/floors/floor-1/import-jobs/job-1/map-document",
      "/api/floors/floor-1/import-jobs/job-1/map-document/manifest?generationId=prepared&revision=0"
    ]);
    expect(client.getQueryCache().findAll({ queryKey: ["map-document"] }).some(query =>
      query.queryKey.includes("prepared") && query.queryKey.includes(0))).toBe(true);
  });

  it.each([undefined, { kind: "legacy" as const }])("does not start unresolved or explicit legacy reviews: %s", scene => {
    const fetcher = installFetch(); const { wrapper } = setup();
    renderHook(() => useCadImportScene("floor-1", { ...review, scene }), { wrapper });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discards cached previews when the actual principal disappears", async () => {
    const fetcher = installFetch(); const { wrapper, client } = setup();
    const { result } = renderHook(() => useCadImportScene("floor-1", review), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined()); const requests = fetcher.mock.calls.length;
    await act(async () => { client.setQueryData(["auth", "me"], null); });
    await waitFor(() => expect(result.current.data).toBeUndefined());
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it("rejects missing documents and another region, then retries without a fallback", async () => {
    const fetcher = installFetch(); fetcher.mockResolvedValueOnce(json(null));
    const { wrapper } = setup(); const { result } = renderHook(() => useCadImportScene("floor-1", review), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.data).toBeUndefined();
    fetcher.mockResolvedValueOnce(json(ref)).mockResolvedValueOnce(json(payload(ref, "other")));
    await act(async () => { await result.current.refetch(); });
    expect(result.current.isError).toBe(true); expect(result.current.data).toBeUndefined();
    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toMatchObject({ generationId: "prepared" });
  });

  it.each(["floor", "job", "principal"])("aborts and ignores late responses after %s changes", async change => {
    let finish!: (value: Response) => void; let oldSignal!: AbortSignal;
    const fetcher = vi.fn(async (input: string, _options?: RequestInit) => {
      const next = { ...ref, generationId: "new-generation" };
      return json(input.includes("/manifest?") ? payload(next) : next);
    });
    fetcher.mockImplementationOnce((_input, options) => {
      oldSignal = options!.signal as AbortSignal; return new Promise(resolve => { finish = resolve; });
    });
    vi.stubGlobal("fetch", fetcher); const { wrapper, client } = setup();
    const { result, rerender } = renderHook(({ floorId, value }) => useCadImportScene(floorId, value),
      { wrapper, initialProps: { floorId: "floor-1", value: review } });
    await waitFor(() => expect(oldSignal).toBeDefined());
    if (change === "principal") await act(async () => {
      client.setQueryData(["auth", "me"], { user: { id: "other", organizationId: "org", role: "admin", status: "active" } });
    });
    else { const floorId = change === "floor" ? "floor-2" : "floor-1";
      rerender({ floorId, value: { ...review, job: { ...review.job, floorId, jobId: "job-2" } } }); }
    await waitFor(() => expect(result.current.data).toMatchObject({ generationId: "new-generation" }));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { finish(json(ref)); });
    expect(result.current.data).toMatchObject({ generationId: "new-generation" });
  });
});

describe("prepared import canvas", () => {
  const props = () => ({ floorId: "floor-1", jobId: "job-1", manifest: { ...ref,
    source: createMapDocumentSource({ floorId: "floor-1", jobId: "job-1", authScope: authScope() }) },
    pan: { x: 20, y: 40 }, zoom: 0.5, viewport: { width: 800, height: 600 } });
  it("uses a read-only common renderer and the candidate pan/zoom frame", async () => {
    const { wrapper } = setup(); const value = props(); const view = render(<CadImportSceneCanvas {...value} />, { wrapper });
    await screen.findByTestId("common-preview");
    expect(canvas.props).toMatchObject({ readOnly: true, platform: "mobile", documentRef: ref,
      camera: { centerX: 760, centerY: 520, zoom: 0.5, viewportWidth: 800, viewportHeight: 600 } });
    view.rerender(<CadImportSceneCanvas {...value} pan={{ x: 100, y: 150 }} zoom={2} />);
    expect(canvas.props?.source).toBe(value.manifest.source);
    expect(canvas.props?.camera).toEqual({ centerX: 150, centerY: 75, zoom: 2, viewportWidth: 800, viewportHeight: 600 });
  });
  it("refuses another job's source and a zero-sized viewport", () => {
    const { wrapper } = setup(); const value = props();
    const view = render(<CadImportSceneCanvas {...value} jobId="wrong-job" />, { wrapper });
    expect(screen.queryByTestId("common-preview")).not.toBeInTheDocument();
    view.rerender(<CadImportSceneCanvas {...value} viewport={{ width: 0, height: 0 }} />);
    expect(screen.queryByTestId("common-preview")).not.toBeInTheDocument();
  });
  it("hides renderer failures and refetches the job on retry without a legacy image", async () => {
    const { wrapper, client } = setup(); const invalidate = vi.spyOn(client, "invalidateQueries");
    render(<CadImportSceneCanvas {...props()} />, { wrapper }); await screen.findByTestId("common-preview");
    act(() => canvas.props?.onError?.(new Error("stale reference")));
    expect(screen.getByRole("alert")).toBeInTheDocument(); expect(screen.queryByTestId("common-preview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "도면 다시 불러오기" })); await screen.findByTestId("common-preview");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cad-import-preview", authScope(), "site", "floor-1", "job-1"] });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
