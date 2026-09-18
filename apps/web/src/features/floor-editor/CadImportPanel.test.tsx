import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { CadImportPanel } from "./CadImportPanel";
import type { CadImportReviewState, FloorAsset, FloorImportJob } from "./editor-types";

const floorEditorApi = vi.hoisted(() => ({
  applyFloorImportJob: vi.fn(),
  cancelFloorImportJob: vi.fn(),
  createFloorImportJob: vi.fn(),
  getActiveFloorImportJob: vi.fn(),
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
  renderedViewport: null,
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
  profileVersion: "test/1",
  profileDigest: "b".repeat(64),
  reviewStatus: "pending" as const
};

function renderPanel(options: {
  review?: CadImportReviewState | null;
  isDirty?: boolean;
  onReviewChange?: (review: CadImportReviewState | null) => void;
  onConflict?: () => void;
  onApplied?: (result: import("./editor-types").FloorImportApplyResult | null) => void | Promise<void>;
  onRender?: () => void;
} = {}) {
  const onReviewChange = options.onReviewChange ?? vi.fn();
  const onBusyChange = vi.fn();
  const onApplied = options.onApplied ?? vi.fn();
  const panel = (
    <CadImportPanel
      floorId="floor-1"
      expectedRevision={7}
      leaseToken="lease-token"
      leaseFence={9}
      isDirty={options.isDirty}
      review={options.review ?? null}
      onReviewChange={onReviewChange}
      onBusyChange={onBusyChange}
      onApplied={onApplied}
      onConflict={options.onConflict}
    />
  );
  const result = render(options.onRender
    ? <Profiler id="cad-import-panel" onRender={options.onRender}>{panel}</Profiler>
    : panel);
  return { ...result, onReviewChange, onBusyChange, onApplied };
}

function selectCad(name = "parking.dxf", type = "application/dxf") {
  fireEvent.change(screen.getByLabelText("CAD 파일"), {
    target: { files: [new File(["cad"], name, { type })] }
  });
}

describe("CadImportPanel", () => {
  beforeEach(() => {
    vi.useRealTimers();
    floorEditorApi.getActiveFloorImportJob.mockResolvedValue({ job: null });
  });
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

  it.each([
    ["parking.dwg", "application/dwg"],
    ["parking.dxf", "application/dxf"]
  ])("canonicalizes an empty browser MIME for %s before upload", async (name, canonicalType) => {
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce({ ...asset, mimeType: canonicalType });
    floorEditorApi.createFloorImportJob.mockResolvedValueOnce({
      ...queuedJob,
      sourceFormat: name.endsWith("dwg") ? "dwg" : "dxf"
    });
    renderPanel();
    selectCad(name, "");

    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));

    await waitFor(() => expect(floorEditorApi.uploadFloorAsset).toHaveBeenCalledOnce());
    const uploaded = floorEditorApi.uploadFloorAsset.mock.calls[0][1] as File;
    expect(uploaded.name).toBe(name);
    expect(uploaded.type).toBe(canonicalType);
  });

  it("still rejects a known non-empty MIME that disagrees with the extension", () => {
    renderPanel();
    selectCad("parking.dwg", "application/dxf");
    expect(screen.getByRole("alert")).toHaveTextContent("파일 형식과 확장자가 일치하지 않습니다.");
    expect(screen.getByRole("button", { name: "CAD 가져오기" })).toBeDisabled();
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
    let resolveCandidates!: (value: { jobId: string; candidates: typeof candidate[] }) => void;
    floorEditorApi.listFloorImportCandidates.mockReturnValueOnce(
      new Promise<{ jobId: string; candidates: typeof candidate[] }>((resolve) => {
        resolveCandidates = resolve;
      })
    );
    let captureReviewTransition = false;
    const transitionFrames: Array<{ progress: number | null; loading: boolean }> = [];
    const { onReviewChange } = renderPanel({
      onRender: () => {
        if (!captureReviewTransition) return;
        const progress = document.querySelector<HTMLProgressElement>('progress[aria-label="CAD 가져오기 진행률"]');
        transitionFrames.push({
          progress: progress?.value ?? null,
          loading: document.body.textContent?.includes("분석 완료 · 조명 위치 후보를 불러오는 중") ?? false
        });
      }
    });
    selectCad();
    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));
    await flushPromises();
    expect(floorEditorApi.createFloorImportJob).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledTimes(1);
    captureReviewTransition = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushPromises();
    expect(transitionFrames.length).toBeGreaterThan(0);
    expect(transitionFrames.every(({ progress, loading }) => progress === 100 && loading)).toBe(true);
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(100);
    expect(screen.getByText("분석 완료 · 조명 위치 후보를 불러오는 중")).toBeInTheDocument();

    resolveCandidates({ jobId: queuedJob.jobId, candidates: [candidate] });
    await flushPromises();
    expect(onReviewChange).toHaveBeenCalledWith({
      job: expect.objectContaining({ status: "review_required" }),
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledTimes(2);
  });

  it("removes candidate loading after failure and restores it only while retrying", async () => {
    const reviewJob = {
      ...queuedJob,
      status: "review_required" as const,
      stage: "review_required",
      progressPercent: 100,
      renderedAssetId: "rendered-1",
      renderedAssetPath: "/api/floors/floor-1/assets/rendered-1/content",
      renderedViewport: { width: 640, height: 360 }
    };
    let resolveCandidates!: (value: { jobId: string; candidates: typeof candidate[] }) => void;
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: reviewJob });
    floorEditorApi.listFloorImportCandidates
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(new Promise<{ jobId: string; candidates: typeof candidate[] }>((resolve) => {
        resolveCandidates = resolve;
      }));
    renderPanel();

    await screen.findByText("조명 위치 후보를 불러오지 못했습니다.");
    expect(screen.queryByRole("progressbar", { name: "CAD 가져오기 진행률" })).not.toBeInTheDocument();
    expect(screen.queryByText("분석 완료 · 조명 위치 후보를 불러오는 중")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
    await waitFor(() => expect(floorEditorApi.listFloorImportCandidates).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(100);
    expect(screen.getByText("분석 완료 · 조명 위치 후보를 불러오는 중")).toBeInTheDocument();

    resolveCandidates({ jobId: reviewJob.jobId, candidates: [candidate] });
    await flushPromises();
  });

  it("keeps a fixed one-second polling loop when processing timestamps do not change", async () => {
    vi.useFakeTimers();
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce(asset);
    floorEditorApi.createFloorImportJob.mockResolvedValueOnce(queuedJob);
    floorEditorApi.getFloorImportJob.mockResolvedValue({
      ...queuedJob,
      status: "processing",
      stage: "parsing",
      progressPercent: 35
    });
    const panel = renderPanel();
    selectCad();
    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));
    await flushPromises();

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledTimes(3);
    panel.unmount();
  });

  it("preserves progress and resumes polling after a status request fails", async () => {
    vi.useFakeTimers();
    const processingJob = { ...queuedJob, status: "processing" as const, stage: "parsing", progressPercent: 35 };
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce(asset);
    floorEditorApi.createFloorImportJob.mockResolvedValueOnce(processingJob);
    floorEditorApi.getFloorImportJob
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ...processingJob, stage: "rendering", progressPercent: 70 });
    renderPanel();
    selectCad();
    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));
    await flushPromises();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(35);
    expect(screen.getByRole("button", { name: "다시 확인" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(70);
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

  it("hydrates a durable review job on mount and exposes one bounded semantic candidate control", async () => {
    const reviewJob = {
      ...queuedJob,
      status: "review_required" as const,
      renderedAssetId: "rendered-1",
      renderedAssetPath: "/api/floors/floor-1/assets/rendered-1/content",
      renderedViewport: { width: 640, height: 360 }
    };
    const manyCandidates = Array.from({ length: 2_000 }, (_, index) => ({
      ...candidate,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sourceEntityId: `insert-${index}`
    }));
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: reviewJob });
    floorEditorApi.listFloorImportCandidates.mockResolvedValueOnce({ jobId: reviewJob.jobId, candidates: manyCandidates });
    const first = renderPanel();

    await waitFor(() => expect(first.onReviewChange).toHaveBeenCalledWith(expect.objectContaining({
      job: reviewJob,
      candidates: manyCandidates
    })));
    const reviewCalls = (first.onReviewChange as ReturnType<typeof vi.fn>).mock.calls as Array<[CadImportReviewState | null]>;
    const hydrated = reviewCalls.find(([next]) => next?.job.jobId === reviewJob.jobId)?.[0];
    first.unmount();
    renderPanel({ review: hydrated });

    expect(screen.queryByRole("progressbar", { name: "CAD 가져오기 진행률" })).not.toBeInTheDocument();
    expect(screen.queryByText("분석 완료 · 조명 위치 후보를 불러오는 중")).not.toBeInTheDocument();
    expect(screen.getByText("조명 위치 후보 2,000개를 찾았습니다.")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /후보 1\/2,000/ })).toHaveLength(1);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "다음 후보" }));
    expect(screen.getByRole("checkbox", { name: /후보 2\/2,000/ })).toBeInTheDocument();
  });

  it("finishes review hydration when the parent callback changes during the candidate request", async () => {
    const reviewJob = {
      ...queuedJob,
      status: "review_required" as const,
      progressPercent: 100,
      renderedAssetId: "rendered-1",
      renderedAssetPath: "/api/floors/floor-1/assets/rendered-1/content",
      renderedViewport: { width: 640, height: 360 }
    };
    let resolveCandidates!: (value: { jobId: string; candidates: typeof candidate[] }) => void;
    const candidatesRequest = new Promise<{ jobId: string; candidates: typeof candidate[] }>((resolve) => {
      resolveCandidates = resolve;
    });
    floorEditorApi.getActiveFloorImportJob.mockResolvedValue({ job: reviewJob });
    floorEditorApi.listFloorImportCandidates.mockReturnValue(candidatesRequest);
    const firstReviewChange = vi.fn();
    const latestReviewChange = vi.fn();
    const onBusyChange = vi.fn();
    const onApplied = vi.fn();
    const view = render(
      <CadImportPanel
        floorId="floor-1"
        expectedRevision={7}
        leaseToken="lease-token"
        leaseFence={9}
        review={null}
        onReviewChange={firstReviewChange}
        onBusyChange={onBusyChange}
        onApplied={onApplied}
      />
    );
    await waitFor(() => expect(floorEditorApi.listFloorImportCandidates).toHaveBeenCalledOnce());

    view.rerender(
      <CadImportPanel
        floorId="floor-1"
        expectedRevision={7}
        leaseToken="lease-token"
        leaseFence={9}
        review={null}
        onReviewChange={latestReviewChange}
        onBusyChange={onBusyChange}
        onApplied={onApplied}
      />
    );
    resolveCandidates({ jobId: reviewJob.jobId, candidates: [candidate] });

    await waitFor(() => expect(latestReviewChange).toHaveBeenCalledWith({
      job: reviewJob,
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    }));
  });

  it("recovers the durable queued job after create returns 409", async () => {
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce(asset);
    floorEditorApi.createFloorImportJob.mockRejectedValueOnce(new ApiError("conflict", 409, null));
    floorEditorApi.getActiveFloorImportJob
      .mockResolvedValueOnce({ job: null })
      .mockResolvedValueOnce({ job: queuedJob });
    renderPanel();
    selectCad();
    fireEvent.click(screen.getByRole("button", { name: "CAD 가져오기" }));

    await screen.findByText("가져오기 대기 중");
    expect(screen.queryByText("CAD 가져오기를 시작하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("clears the previous floor state and hydrates the new floor active job", async () => {
    floorEditorApi.getActiveFloorImportJob
      .mockResolvedValueOnce({ job: null })
      .mockResolvedValueOnce({ job: { ...queuedJob, floorId: "floor-2" } });
    const onReviewChange = vi.fn();
    const onBusyChange = vi.fn();
    const onApplied = vi.fn();
    const panel = render(<CadImportPanel
      floorId="floor-1"
      expectedRevision={7}
      leaseToken="lease-token"
      leaseFence={9}
      review={null}
      onReviewChange={onReviewChange}
      onBusyChange={onBusyChange}
      onApplied={onApplied}
    />);
    await waitFor(() => expect(floorEditorApi.getActiveFloorImportJob).toHaveBeenCalledWith("floor-1"));

    panel.rerender(<CadImportPanel
      floorId="floor-2"
      expectedRevision={3}
      leaseToken="lease-token-2"
      leaseFence={10}
      review={null}
      onReviewChange={onReviewChange}
      onBusyChange={onBusyChange}
      onApplied={onApplied}
    />);

    await screen.findByText("가져오기 대기 중");
    expect(floorEditorApi.getActiveFloorImportJob).toHaveBeenLastCalledWith("floor-2");
    expect(onReviewChange).toHaveBeenLastCalledWith(null);
  });

  it("does not hydrate applying as a recoverable active UI state", async () => {
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({
      job: { ...queuedJob, status: "applying", stage: "applying", renderedViewport: { width: 640, height: 360 } }
    });
    renderPanel();
    await flushPromises();

    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
    expect(screen.queryByText("CAD 도면을 적용하는 중")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "적용 결과 확인" })).not.toBeInTheDocument();
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
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
    expect(screen.getByText(/CAD 가져오기에 실패했습니다/)).toBeInTheDocument();
  });

  it("applies only reviewed candidate ids with the editor lease and revision", async () => {
    const acceptedCandidates = Array.from({ length: 2_000 }, (_, index) => ({
      ...candidate,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sourceEntityId: `insert-${index}`
    }));
    const acceptedIds = acceptedCandidates.map(item => item.id);
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: acceptedCandidates,
      acceptedCandidateIds: acceptedIds
    };
    floorEditorApi.applyFloorImportJob.mockResolvedValueOnce({
      jobId: queuedJob.jobId,
      status: "completed",
      revision: 8,
      acceptedCandidateIds: acceptedIds,
      renderedAssetId: "rendered-1",
      floorPlan: {}
    });
    const { onApplied } = renderPanel({ review });

    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));

    await waitFor(() => expect(floorEditorApi.applyFloorImportJob).toHaveBeenCalledWith(
      "floor-1",
      queuedJob.jobId,
      { expectedRevision: 7, leaseToken: "lease-token", leaseFence: 9, confirmMapReset: true, candidateIds: acceptedIds }
    ));
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ revision: 8 }));
  });

  it("blocks CAD start and apply while the editor has an unsaved draft", () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    const first = renderPanel({ isDirty: true });
    selectCad();
    expect(screen.getByText(/먼저 저장하거나 취소해 변경사항을 폐기/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CAD 가져오기" })).toBeDisabled();
    first.unmount();

    renderPanel({ review, isDirty: true });
    expect(screen.getByRole("button", { name: "선택한 후보와 배경 적용" })).toBeDisabled();
  });

  it("reconciles apply 409 before routing a still-reviewable job to the editor conflict flow", async () => {
    const onConflict = vi.fn();
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new ApiError("conflict", 409, null));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce(review.job);
    renderPanel({ review, onConflict });
    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));

    await waitFor(() => expect(onConflict).toHaveBeenCalledOnce());
    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledWith("floor-1", queuedJob.jobId);
    expect(screen.getByText(/최신 버전을 다시 불러온 뒤/)).toBeInTheDocument();
  });

  it("converges to completed after apply 409 without reopening the stale review", async () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    const onConflict = vi.fn();
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new ApiError("conflict", 409, null));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({ ...review.job, status: "completed" });
    const { onApplied, onReviewChange } = renderPanel({ review, onConflict });

    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(null));
    expect(onReviewChange).toHaveBeenCalledWith(null);
    expect(onConflict).not.toHaveBeenCalled();
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
  });

  it.each(["failed", "cancelled"] as const)("clears a %s reconciliation so a new import can start", async (status) => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({ ...review.job, status, stage: status });
    const { onReviewChange } = renderPanel({ review });

    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));

    await waitFor(() => expect(onReviewChange).toHaveBeenCalledWith(null));
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
  });

  it("reconciles an unknown apply result with GET before deciding it completed", async () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({ ...review.job, status: "completed" });
    const { onApplied } = renderPanel({ review });
    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));

    await waitFor(() => expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledWith("floor-1", queuedJob.jobId));
    expect(onApplied).toHaveBeenCalledWith(null);
  });

  it("preserves candidate choices when unknown apply reconciliation remains review-required", async () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: []
    };
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({ ...review.job, updatedAt: "2026-09-17T00:00:02.000Z" });
    const { onReviewChange } = renderPanel({ review });
    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));

    await waitFor(() => expect(onReviewChange).toHaveBeenCalledWith(expect.objectContaining({
      acceptedCandidateIds: [],
      candidates: [candidate],
      job: expect.objectContaining({ status: "review_required" })
    })));
    expect(screen.getByText(/서버 적용이 완료되지 않았습니다/)).toBeInTheDocument();
  });

  it("keeps a map-refresh recovery action after completed and closes it only after refresh succeeds", async () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    const onApplied = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to refresh editor state"))
      .mockResolvedValueOnce(undefined);
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({ ...review.job, status: "completed" });
    const { onReviewChange } = renderPanel({ review, onApplied });
    await flushPromises();
    (onReviewChange as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/적용은 완료되었지만 최신 맵을 불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "최신 맵 다시 불러오기" })).toBeInTheDocument();
    expect(screen.queryByLabelText("CAD 파일")).not.toBeInTheDocument();
    expect(onReviewChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "최신 맵 다시 불러오기" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(2));
    expect(onApplied).toHaveBeenNthCalledWith(2, null);
    expect(floorEditorApi.applyFloorImportJob).toHaveBeenCalledOnce();
    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledOnce();
    expect(onReviewChange).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("button", { name: "최신 맵 다시 불러오기" })).not.toBeInTheDocument();
    expect(screen.queryByText(/적용은 완료되었지만 최신 맵을 불러오지 못했습니다/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
  });
});

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
