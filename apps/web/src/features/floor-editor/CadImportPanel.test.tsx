import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CadImportPanel } from "./CadImportPanel";
import type { CadImportReviewState, FloorAsset, FloorImportJob } from "./editor-types";

const floorEditorApi = vi.hoisted(() => ({
  applyFloorImportJob: vi.fn(),
  cancelFloorImportJob: vi.fn(),
  createFloorImportJob: vi.fn(),
  getFloorImportJob: vi.fn(),
  listFloorImportCandidates: vi.fn(),
  uploadFloorAsset: vi.fn()
}));

vi.mock("../../api/floor-editor", () => floorEditorApi);

const asset: FloorAsset = {
  id: "00000000-0000-4000-8000-000000000010",
  kind: "original",
  status: "ready",
  mimeType: "application/dxf",
  sizeBytes: 3,
  sha256: "a".repeat(64),
  accessPath: "/api/floors/floor-1/assets/asset-1/content"
};

const queuedJob: FloorImportJob = {
  jobId: "00000000-0000-4000-8000-000000000020",
  floorId: "floor-1",
  sourceAssetId: asset.id,
  renderedAssetId: null,
  sourceFormat: "dxf",
  status: "queued",
  stage: "queued",
  progressPercent: 0,
  attemptCount: 0,
  parserVersion: null,
  detectorVersion: null,
  failureCode: null,
  sourceAssetPath: asset.accessPath,
  renderedAssetPath: null,
  startedAt: null,
  reviewRequiredAt: null,
  appliedAt: null,
  completedAt: null,
  failedAt: null,
  cancelledAt: null,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z"
};

const candidate = {
  id: "00000000-0000-4000-8000-000000000030",
  sourceEntityId: "insert-1",
  layerName: "LIGHT",
  blockName: "LED",
  x: 100,
  y: 120,
  rotation: 0,
  confidence: 0.95,
  detectionMethod: "rule_based" as const,
  provider: null,
  model: null,
  inputDigest: null,
  reviewStatus: "pending" as const
};

function renderPanel(options: { review?: CadImportReviewState | null; onReviewChange?: (review: CadImportReviewState | null) => void } = {}) {
  const onReviewChange = options.onReviewChange ?? vi.fn();
  const onBusyChange = vi.fn();
  const onApplied = vi.fn();
  const result = render(
    <CadImportPanel
      floorId="floor-1"
      expectedRevision={7}
      leaseToken="lease-token"
      leaseFence={9}
      review={options.review ?? null}
      onReviewChange={onReviewChange}
      onBusyChange={onBusyChange}
      onApplied={onApplied}
    />
  );
  return { ...result, onReviewChange, onBusyChange, onApplied };
}

function selectCad(name = "parking.dxf", type = "application/dxf") {
  fireEvent.change(screen.getByLabelText("CAD 파일"), {
    target: { files: [new File(["cad"], name, { type })] }
  });
}

describe("CadImportPanel", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["parking.dwg", "application/dwg"],
    ["parking.dwg", "application/x-dwg"],
    ["parking.dxf", "application/dxf"]
  ])("uploads %s and creates a queued import job", async (name, type) => {
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce({ ...asset, mimeType: type });
    floorEditorApi.createFloorImportJob.mockResolvedValueOnce({ ...queuedJob, sourceFormat: name.endsWith("dwg") ? "dwg" : "dxf" });
    renderPanel();
    selectCad(name, type);

    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));

    await waitFor(() => expect(floorEditorApi.createFloorImportJob).toHaveBeenCalledWith("floor-1", {
      sourceAssetId: asset.id,
      sourceFormat: name.endsWith("dwg") ? "dwg" : "dxf"
    }));
  });

  it("rejects PDF before upload", () => {
    renderPanel();
    selectCad("parking.pdf", "application/pdf");

    expect(screen.getByRole("alert")).toHaveTextContent("DWG, DXF");
    expect(screen.getByRole("button", { name: "CAD 가져오기" })).toBeDisabled();
    expect(floorEditorApi.uploadFloorAsset).not.toHaveBeenCalled();
  });

  it("polls queued and processing jobs, loads review candidates, then stops polling", async () => {
    vi.useFakeTimers();
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce(asset);
    floorEditorApi.createFloorImportJob.mockResolvedValueOnce(queuedJob);
    floorEditorApi.getFloorImportJob
      .mockResolvedValueOnce({ ...queuedJob, status: "processing", stage: "parsing", progressPercent: 45 })
      .mockResolvedValueOnce({ ...queuedJob, status: "review_required", stage: "review_required", progressPercent: 100 });
    floorEditorApi.listFloorImportCandidates.mockResolvedValueOnce({ jobId: queuedJob.jobId, candidates: [candidate] });
    const { onReviewChange } = renderPanel();
    selectCad();
    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));
    await flushPromises();
    expect(floorEditorApi.createFloorImportJob).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushPromises();
    expect(onReviewChange).toHaveBeenCalledWith({
      job: expect.objectContaining({ status: "review_required" }),
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledTimes(2);
  });

  it("cleans up queued polling when unmounted", async () => {
    vi.useFakeTimers();
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce(asset);
    floorEditorApi.createFloorImportJob.mockResolvedValueOnce(queuedJob);
    const { unmount } = renderPanel();
    selectCad();
    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));
    await flushPromises();
    expect(floorEditorApi.createFloorImportJob).toHaveBeenCalledOnce();

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(floorEditorApi.getFloorImportJob).not.toHaveBeenCalled();
  });

  it("stops polling after a terminal job status", async () => {
    vi.useFakeTimers();
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce(asset);
    floorEditorApi.createFloorImportJob.mockResolvedValueOnce(queuedJob);
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob,
      status: "failed",
      stage: "failed",
      failureCode: "conversion_failed"
    });
    renderPanel();
    selectCad();
    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));
    await flushPromises();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledOnce();
  });

  it("applies only reviewed candidate ids with the editor lease and revision", async () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    floorEditorApi.applyFloorImportJob.mockResolvedValueOnce({
      jobId: queuedJob.jobId,
      status: "completed",
      revision: 8,
      acceptedCandidateIds: [candidate.id],
      renderedAssetId: "rendered-1",
      floorPlan: {}
    });
    const { onApplied } = renderPanel({ review });

    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));

    await waitFor(() => expect(floorEditorApi.applyFloorImportJob).toHaveBeenCalledWith(
      "floor-1",
      queuedJob.jobId,
      { expectedRevision: 7, leaseToken: "lease-token", leaseFence: 9, candidateIds: [candidate.id] }
    ));
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ revision: 8 }));
  });
});

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
