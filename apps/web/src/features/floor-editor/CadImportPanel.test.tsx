import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { CadImportPanel } from "./CadImportPanel";
import type { CadImportReviewState, FloorAsset, FloorImportApplyResult, FloorImportJob } from "./editor-types";

const floorEditorApi = vi.hoisted(() => ({
  applyFloorImportJob: vi.fn(),
  cancelFloorImportJob: vi.fn(),
  createFloorImportJob: vi.fn(),
  getActiveFloorImportJob: vi.fn(),
  getFloorImportJob: vi.fn(),
  listFloorImportCandidates: vi.fn(),
  uploadFloorAsset: vi.fn()
}));

const cadRegionApi = vi.hoisted(() => ({
  listFloorImportRegions: vi.fn(),
  selectFloorImportRegion: vi.fn()
}));

vi.mock("../../api/floor-editor", () => floorEditorApi);
vi.mock("../../api/queries", () => cadRegionApi);

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

const firstRegion = {
  regionId: "region-1",
  bounds: { minX: 0, minY: 0, maxX: 2_000, maxY: 1_000 },
  primitiveCount: 1_200,
  textCount: 20,
  lightCandidateCount: 12,
  area: 2_000_000,
  preview: {
    assetId: "00000000-0000-4000-8000-000000000050",
    width: 640,
    height: 320,
    byteSize: 1_024,
    sha256: "c".repeat(64)
  }
};

const secondRegion = {
  regionId: "region-2",
  bounds: { minX: 4_000, minY: 0, maxX: 4_500, maxY: 500 },
  primitiveCount: 120,
  textCount: 4,
  lightCandidateCount: 2,
  area: 250_000,
  preview: {
    assetId: "00000000-0000-4000-8000-000000000051",
    width: 320,
    height: 320,
    byteSize: 512,
    sha256: "d".repeat(64)
  }
};

const multipleRegions = {
  jobId: queuedJob.jobId,
  selectionStatus: "selection_required" as const,
  selectedRegionId: null,
  excludedRegionPrimitiveCount: 7,
  regions: [firstRegion, secondRegion]
};

const autoSelectedRegion = {
  jobId: queuedJob.jobId,
  selectionStatus: "auto_selected" as const,
  selectedRegionId: firstRegion.regionId,
  excludedRegionPrimitiveCount: 3,
  regions: [firstRegion]
};

function renderPanel(options: {
  review?: CadImportReviewState | null;
  isDirty?: boolean;
  resetSummary?: { fixtureCount: number; objectCount: number; slotCount: number };
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
      resetSummary={options.resetSummary ?? { fixtureCount: 4, objectCount: 2, slotCount: 3 }}
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

function openAndConfirmApply() {
  fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));
  const dialog = screen.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "교체 후 적용" }));
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
    cadRegionApi.listFloorImportRegions.mockResolvedValue(autoSelectedRegion);
  });
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
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

  it("requires one of multiple detected regions and loads only one active preview before scene build", async () => {
    const regionJob = {
      ...queuedJob,
      status: "region_selection_required" as const,
      stage: "region_selection_required",
      progressPercent: 70,
      parserVersion: "cad-core/1"
    };
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: regionJob });
    cadRegionApi.listFloorImportRegions.mockResolvedValueOnce(multipleRegions);
    cadRegionApi.selectFloorImportRegion.mockResolvedValueOnce({
      ...multipleRegions,
      selectionStatus: "selected",
      selectedRegionId: firstRegion.regionId
    });
    renderPanel();

    expect(await screen.findByRole("radiogroup", { name: "가져올 도면 영역" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "도면 영역 1 미리보기" })).toHaveAttribute(
      "src",
      `/api/floors/floor-1/assets/${firstRegion.preview.assetId}/content`
    );
    expect(screen.queryByRole("img", { name: "도면 영역 2 미리보기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "선택 영역으로 장면 만들기" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: /도면 영역 1/ }));

    expect(screen.getByText("도형 1,200개")).toBeInTheDocument();
    expect(screen.getByText("조명 후보 12개")).toBeInTheDocument();
    expect(screen.getByText("제외 요소 7개")).toBeInTheDocument();
    expect(screen.getByText("새 맵 16,384 × 8,192")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "선택 영역으로 장면 만들기" }));

    await waitFor(() => expect(cadRegionApi.selectFloorImportRegion).toHaveBeenCalledWith(
      "floor-1",
      queuedJob.jobId,
      firstRegion.regionId
    ));
    expect(screen.queryByRole("radiogroup", { name: "가져올 도면 영역" })).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(72);
    expect(screen.getByText("선택 영역의 CAD 장면을 준비하는 중")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "DWG/DXF 가져오기" })).toHaveFocus();
  });

  it("pages a large region list without dropping later regions and decodes only one preview", async () => {
    const regionJob = {
      ...queuedJob,
      status: "region_selection_required" as const,
      stage: "region_selection_required",
      progressPercent: 70,
      parserVersion: "cad-core/1"
    };
    const manyRegions = Array.from({ length: 1_817 }, (_, index) => ({
      ...firstRegion,
      regionId: `region-${index + 1}`,
      preview: {
        ...firstRegion.preview,
        assetId: `00000000-0000-4000-8000-${String(index + 50).padStart(12, "0")}`
      }
    }));
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: regionJob });
    cadRegionApi.listFloorImportRegions.mockResolvedValueOnce({
      ...multipleRegions,
      regions: manyRegions
    });
    renderPanel();

    expect(await screen.findByRole("radiogroup", { name: "가져올 도면 영역" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(20);
    expect(screen.getByText("1~20 / 1817건")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /도면 영역 .* 미리보기/ })).toHaveLength(1);
    expect(screen.getByRole("img", { name: "도면 영역 1 미리보기" })).toHaveAttribute("loading", "lazy");
    expect(screen.getByRole("img", { name: "도면 영역 1 미리보기" })).toHaveAttribute("decoding", "async");

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByText("21~40 / 1817건")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /^도면 영역 21 ·/ }));

    expect(screen.getAllByRole("img", { name: /도면 영역 .* 미리보기/ })).toHaveLength(1);
    expect(screen.getByRole("img", { name: "도면 영역 21 미리보기" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByRole("radio", { name: /^도면 영역 21 ·/ })).toBeChecked();
  });

  it.each([
    ["transport loss", new TypeError("Failed to fetch")],
    ["duplicate conflict", new ApiError("conflict", 409, null)]
  ])("reconciles a committed region selection after %s", async (_label, postError) => {
    const regionJob = {
      ...queuedJob,
      status: "region_selection_required" as const,
      stage: "region_selection_required",
      progressPercent: 70,
      parserVersion: "cad-core/1"
    };
    const selectedRegions = {
      ...multipleRegions,
      selectionStatus: "selected" as const,
      selectedRegionId: firstRegion.regionId
    };
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: regionJob });
    cadRegionApi.listFloorImportRegions
      .mockResolvedValueOnce(multipleRegions)
      .mockResolvedValueOnce(selectedRegions);
    cadRegionApi.selectFloorImportRegion.mockRejectedValueOnce(postError);
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob,
      status: "processing",
      stage: "compiling_scene",
      progressPercent: 81,
      parserVersion: "cad-core/1"
    });
    renderPanel();

    await screen.findByRole("radiogroup", { name: "가져올 도면 영역" });
    fireEvent.click(screen.getByRole("radio", { name: /도면 영역 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택 영역으로 장면 만들기" }));

    await waitFor(() => expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledWith("floor-1", queuedJob.jobId));
    expect(cadRegionApi.listFloorImportRegions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("radiogroup", { name: "가져올 도면 영역" })).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(81);
    expect(screen.queryByText("도면 영역을 선택하지 못했습니다. 다시 시도하세요.")).not.toBeInTheDocument();
  });

  it.each([
    ["queued", "queued", 0, 72],
    ["review_required", "review_required", 100, 100]
  ] as const)("continues from canonical %s after the selection response is lost", async (status, stage, progressPercent, expectedProgress) => {
    const regionJob = {
      ...queuedJob,
      status: "region_selection_required" as const,
      stage: "region_selection_required",
      progressPercent: 70,
      parserVersion: "cad-core/1"
    };
    const selectedRegions = {
      ...multipleRegions,
      selectionStatus: "selected" as const,
      selectedRegionId: firstRegion.regionId
    };
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: regionJob });
    cadRegionApi.listFloorImportRegions
      .mockResolvedValueOnce(multipleRegions)
      .mockResolvedValueOnce(selectedRegions);
    cadRegionApi.selectFloorImportRegion.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob,
      status,
      stage,
      progressPercent,
      parserVersion: "cad-core/1"
    });
    if (status === "review_required") {
      floorEditorApi.listFloorImportCandidates.mockReturnValueOnce(new Promise(() => {}));
    }
    renderPanel();

    await screen.findByRole("radiogroup", { name: "가져올 도면 영역" });
    fireEvent.click(screen.getByRole("radio", { name: /도면 영역 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택 영역으로 장면 만들기" }));

    await waitFor(() => expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(expectedProgress));
    expect(screen.queryByRole("radiogroup", { name: "가져올 도면 영역" })).not.toBeInTheDocument();
  });

  it.each([
    ["response loss", new TypeError("Failed to fetch")],
    ["duplicate conflict", new ApiError("conflict", 409, null)]
  ])("reconciles a committed cancellation after %s", async (_label, cancelError) => {
    const regionJob = {
      ...queuedJob,
      status: "region_selection_required" as const,
      stage: "region_selection_required",
      progressPercent: 70,
      parserVersion: "cad-core/1"
    };
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: regionJob });
    cadRegionApi.listFloorImportRegions.mockResolvedValueOnce(multipleRegions);
    floorEditorApi.cancelFloorImportJob.mockRejectedValueOnce(cancelError);
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...regionJob,
      status: "cancelled",
      stage: "cancelled",
      cancelledAt: "2026-09-19T00:00:00.000Z"
    });
    renderPanel();

    await screen.findByRole("radiogroup", { name: "가져올 도면 영역" });
    fireEvent.click(screen.getByRole("button", { name: "가져오기 취소" }));

    await waitFor(() => expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledWith("floor-1", queuedJob.jobId));
    expect(cadRegionApi.listFloorImportRegions).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
    expect(screen.queryByText("CAD 가져오기를 취소하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("uses the canonical cancelled job even when regions are not ready yet", async () => {
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: queuedJob });
    floorEditorApi.cancelFloorImportJob.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob,
      status: "cancelled",
      stage: "cancelled",
      cancelledAt: "2026-09-19T00:00:00.000Z"
    });
    cadRegionApi.listFloorImportRegions.mockReturnValueOnce(new Promise(() => {}));
    renderPanel();

    expect(await screen.findByText("가져오기 대기 중")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "가져오기 취소" }));

    await waitFor(() => expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument());
    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledWith("floor-1", queuedJob.jobId);
    expect(cadRegionApi.listFloorImportRegions).not.toHaveBeenCalled();
    expect(screen.getByText("CAD 가져오기가 취소되었습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/아직 취소되지 않았습니다/)).not.toBeInTheDocument();
  });

  it("keeps the canonical failed message during cancel recovery without requesting regions", async () => {
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: queuedJob });
    floorEditorApi.cancelFloorImportJob.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob,
      status: "failed",
      stage: "failed",
      failureCode: "conversion_failed",
      failedAt: "2026-09-19T00:00:00.000Z"
    });
    renderPanel();

    expect(await screen.findByText("가져오기 대기 중")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "가져오기 취소" }));

    expect(await screen.findByText("CAD 가져오기에 실패했습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/아직 취소되지 않았습니다/)).not.toBeInTheDocument();
    expect(cadRegionApi.listFloorImportRegions).not.toHaveBeenCalled();
  });

  it("restores the latest map immediately when cancel recovery finds a completed job", async () => {
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: queuedJob });
    floorEditorApi.cancelFloorImportJob.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob,
      status: "completed",
      stage: "completed",
      progressPercent: 100,
      completedAt: "2026-09-19T00:00:00.000Z"
    });
    const { onApplied, onReviewChange } = renderPanel();

    expect(await screen.findByText("가져오기 대기 중")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "가져오기 취소" }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(null));
    expect(onReviewChange).toHaveBeenCalledWith(null);
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
    expect(screen.queryByText(/아직 취소되지 않았습니다/)).not.toBeInTheDocument();
    expect(cadRegionApi.listFloorImportRegions).not.toHaveBeenCalled();
  });

  it("shows the canonical selected build state before a bounded region recovery aborts", async () => {
    vi.useFakeTimers();
    let resolveRetry!: (value: typeof autoSelectedRegion) => void;
    const regionJob = {
      ...queuedJob,
      status: "region_selection_required" as const,
      stage: "region_selection_required",
      progressPercent: 70,
      parserVersion: "cad-core/1"
    };
    const canonicalJob = {
      ...queuedJob,
      status: "processing" as const,
      stage: "compiling_scene",
      progressPercent: 81,
      parserVersion: "cad-core/1"
    };
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: regionJob });
    cadRegionApi.listFloorImportRegions
      .mockResolvedValueOnce(multipleRegions)
      .mockImplementationOnce((_floorId: string, _jobId: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveRetry = resolve;
      }));
    cadRegionApi.selectFloorImportRegion.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce(canonicalJob);
    renderPanel();

    await act(async () => { await flushPromises(); });
    fireEvent.click(screen.getByRole("radio", { name: /도면 영역 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택 영역으로 장면 만들기" }));
    await act(async () => { await flushPromises(); });

    expect(screen.queryByRole("radiogroup", { name: "가져올 도면 영역" })).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(81);
    const recoveryCall = cadRegionApi.listFloorImportRegions.mock.calls[1];
    expect(recoveryCall?.[2]?.signal.aborted).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(recoveryCall?.[2]?.signal.aborted).toBe(true);
    expect(screen.getByText("선택 상태는 확인했지만 도면 영역 정보를 불러오지 못했습니다.")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "도면 영역 다시 확인" });
    expect(retryButton).toBeEnabled();

    fireEvent.click(retryButton);

    expect(screen.getByText("선택 상태는 확인했지만 도면 영역 정보를 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "도면 영역 확인 중" })).toBeDisabled();

    resolveRetry(autoSelectedRegion);
    await act(async () => { await flushPromises(); });

    expect(screen.queryByText("선택 상태는 확인했지만 도면 영역 정보를 불러오지 못했습니다.")).not.toBeInTheDocument();
    expect(cadRegionApi.listFloorImportRegions).toHaveBeenCalledTimes(3);
  });

  it("shows an auto-selected single region and its scene review statistics", async () => {
    const reviewJob = {
      ...queuedJob,
      status: "review_required" as const,
      stage: "review_required",
      progressPercent: 100,
      parserVersion: "cad-core/1"
    };
    cadRegionApi.listFloorImportRegions.mockResolvedValueOnce(autoSelectedRegion);
    renderPanel({
      review: {
        job: reviewJob,
        candidates: [candidate],
        acceptedCandidateIds: [candidate.id]
      }
    });

    expect(await screen.findByText("도면 영역 1개를 자동 선택했습니다.")).toBeInTheDocument();
    expect(screen.getByText("도형 1,200개")).toBeInTheDocument();
    expect(screen.getByText("조명 후보 12개")).toBeInTheDocument();
    expect(screen.getByText("제외 요소 3개")).toBeInTheDocument();
    expect(screen.getByText("새 맵 16,384 × 8,192")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "선택한 도면 영역 미리보기" })).toHaveAttribute(
      "src",
      `/api/floors/floor-1/assets/${firstRegion.preview.assetId}/content`
    );
  });

  it("keeps progress monotonic after region selection and restores the selected build stage after refresh", async () => {
    vi.useFakeTimers();
    const selectedRegions = {
      ...multipleRegions,
      selectionStatus: "selected" as const,
      selectedRegionId: firstRegion.regionId
    };
    const resumedJob = {
      ...queuedJob,
      status: "queued" as const,
      stage: "queued",
      progressPercent: 0,
      parserVersion: "cad-core/1"
    };
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: resumedJob });
    cadRegionApi.listFloorImportRegions.mockResolvedValueOnce(selectedRegions);
    floorEditorApi.getFloorImportJob
      .mockResolvedValueOnce({ ...resumedJob, status: "processing", stage: "converting", progressPercent: 15 })
      .mockResolvedValueOnce({ ...resumedJob, status: "processing", stage: "compiling_scene", progressPercent: 70 });
    renderPanel();
    await flushPromises();

    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(72);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(74);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(80);
  });

  it("shows persisted post-selection progress while region hydration is still pending", async () => {
    const resumedJob = {
      ...queuedJob,
      status: "queued" as const,
      stage: "queued",
      progressPercent: 0,
      parserVersion: "cad-core/1"
    };
    let resolveRegions!: (value: typeof autoSelectedRegion) => void;
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: resumedJob });
    cadRegionApi.listFloorImportRegions.mockReturnValueOnce(new Promise((resolve) => {
      resolveRegions = resolve;
    }));
    renderPanel();

    expect(await screen.findByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(72);
    expect(screen.getByText("선택한 영역을 복원하는 중")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).not.toHaveValue(0);

    resolveRegions(autoSelectedRegion);
    await waitFor(() => expect(screen.getByText("선택 영역의 CAD 장면을 준비하는 중")).toBeInTheDocument());
    expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(72);
  });

  it("retries region hydration after a transient failure without losing the active job", async () => {
    const regionJob = {
      ...queuedJob,
      status: "region_selection_required" as const,
      stage: "region_selection_required",
      progressPercent: 70,
      parserVersion: "cad-core/1"
    };
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: regionJob });
    cadRegionApi.listFloorImportRegions
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(multipleRegions);
    renderPanel();

    expect(await screen.findByText("도면 영역을 불러오지 못했습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));

    expect(await screen.findByRole("radiogroup", { name: "가져올 도면 영역" })).toBeInTheDocument();
    expect(cadRegionApi.listFloorImportRegions).toHaveBeenCalledTimes(2);
  });

  it("keeps an unsupported extreme region selectable for preview but blocks scene compilation", async () => {
    const regionJob = {
      ...queuedJob,
      status: "region_selection_required" as const,
      stage: "region_selection_required",
      progressPercent: 70,
      parserVersion: "cad-core/1"
    };
    const extremeRegion = {
      ...firstRegion,
      bounds: { minX: 0, minY: 0, maxX: 100_000, maxY: 1 },
      area: 100_000
    };
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: regionJob });
    cadRegionApi.listFloorImportRegions.mockResolvedValueOnce({
      ...multipleRegions,
      regions: [extremeRegion, secondRegion]
    });
    renderPanel();

    await screen.findByRole("radiogroup", { name: "가져올 도면 영역" });
    fireEvent.click(screen.getByRole("radio", { name: /도면 영역 1/ }));

    expect(screen.getByText("지원 맵 비율을 초과했습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "선택 영역으로 장면 만들기" })).toBeDisabled();
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
        resetSummary={{ fixtureCount: 4, objectCount: 2, slotCount: 3 }}
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
        resetSummary={{ fixtureCount: 4, objectCount: 2, slotCount: 3 }}
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
      resetSummary={{ fixtureCount: 4, objectCount: 2, slotCount: 3 }}
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
      resetSummary={{ fixtureCount: 4, objectCount: 2, slotCount: 3 }}
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

  it.each([
    ["CAD_IMPORT_SOURCE_INVALID", /원본 CAD 파일을 확인하거나 읽는 단계/, /파일.*다시 선택/],
    ["CAD_IMPORT_CONVERSION_FAILED", /CAD 파일을 변환하는 단계/, /다시 저장.*가져오세요/],
    ["CAD_IMPORT_PARSE_FAILED", /CAD 도면 분석 단계/, /파일을 다시 선택해 가져오세요/],
    ["CAD_IMPORT_DETECTION_FAILED", /도면 영역이나 조명 후보를 찾는 단계/, /다시.*가져오세요/],
    ["CAD_IMPORT_RENDER_FAILED", /도면 미리보기나 장면을 만드는 단계/, /다시.*가져오세요/],
    ["CAD_IMPORT_STORAGE_FAILED", /가져오기 결과 파일을 저장하는 단계/, /잠시 후.*가져오세요/],
    ["CAD_IMPORT_PERSIST_FAILED", /가져오기 결과 정보를 저장하는 단계/, /잠시 후.*가져오세요/],
    ["CAD_IMPORT_ATTEMPTS_EXHAUSTED", /자동 재시도 횟수를 모두 사용/, /잠시 후.*가져오세요/]
  ])("explains terminal %s with safe phase and retry guidance", async (failureCode, phase, guidance) => {
    vi.useFakeTimers();
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: queuedJob });
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob, status: "failed", stage: "failed", failureCode,
      failureMessage: "private /tmp/customer.dxf SQL password=secret <script>unsafe</script>"
    });
    renderPanel();
    await flushPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const feedback = screen.getByRole("alert");
    expect(within(feedback).getByText("CAD 가져오기에 실패했습니다.")).toBeInTheDocument();
    expect(feedback).toHaveTextContent(phase);
    expect(feedback).toHaveTextContent(guidance);
    expect(feedback).not.toHaveTextContent(/private|customer\.dxf|password|unsafe|CAD_IMPORT_/);
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();

    selectCad("retry.dxf");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([null, "CAD_IMPORT_FUTURE_FAILURE", "__proto__", "constructor", "private /tmp/secret"])(
    "keeps unknown failure code %s generic without exposing raw diagnostics", async failureCode => {
      vi.useFakeTimers();
      floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: queuedJob });
      floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
        ...queuedJob, status: "failed", stage: "failed", failureCode,
        failureMessage: "private /tmp/customer.dxf SQL password=secret <script>unsafe</script>"
      });
      renderPanel();
      await flushPromises();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

      const feedback = screen.getByRole("alert");
      expect(within(feedback).getByText("CAD 가져오기에 실패했습니다.")).toBeInTheDocument();
      expect(feedback).toHaveTextContent("파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.");
      expect(feedback).not.toHaveTextContent(/private|customer\.dxf|password|unsafe|CAD_IMPORT_|__proto__|constructor/);
    }
  );

  it("preserves safe failure guidance when an apply response is reconciled", async () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate], acceptedCandidateIds: [candidate.id]
    };
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob, status: "failed", stage: "failed", failureCode: "CAD_IMPORT_PERSIST_FAILED"
    });
    renderPanel({ review });
    openAndConfirmApply();

    expect(await screen.findByRole("alert")).toHaveTextContent(/가져오기 결과 정보를 저장하는 단계/);
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
  });

  it("preserves safe failure guidance when region selection is reconciled", async () => {
    floorEditorApi.getActiveFloorImportJob.mockResolvedValueOnce({ job: {
      ...queuedJob, status: "region_selection_required", stage: "region_selection_required", parserVersion: "cad-core/1"
    } });
    cadRegionApi.listFloorImportRegions.mockResolvedValueOnce(multipleRegions);
    cadRegionApi.selectFloorImportRegion.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    floorEditorApi.getFloorImportJob.mockResolvedValueOnce({
      ...queuedJob, status: "failed", stage: "failed", failureCode: "CAD_IMPORT_RENDER_FAILED"
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("radio", { name: /도면 영역 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택 영역으로 장면 만들기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/도면 미리보기나 장면을 만드는 단계/);
    expect(screen.getByLabelText("CAD 파일")).toBeInTheDocument();
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

  it("shows exact reset counts and cancels without applying, then returns focus to the trigger", async () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    renderPanel({ review, resetSummary: { fixtureCount: 4, objectCount: 2, slotCount: 3 } });
    const trigger = screen.getByRole("button", { name: "선택한 후보와 배경 적용" });

    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
    expect(dialog).toHaveTextContent("조명 4개가 미배치 상태로 변경");
    expect(dialog).toHaveTextContent("수동 도형 2개가 삭제");
    expect(dialog).toHaveTextContent("기존 CAD 슬롯 3개가 삭제");
    expect(dialog).toHaveTextContent("선택한 조명 위치 슬롯 1개가 생성");
    expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));

    expect(floorEditorApi.applyFloorImportJob).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("dismisses the reset warning with Escape without applying", async () => {
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    renderPanel({ review });
    const trigger = screen.getByRole("button", { name: "선택한 후보와 배경 적용" });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" }), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" })).not.toBeInTheDocument());
    expect(floorEditorApi.applyFloorImportJob).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
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
      renderedAssetId: "00000000-0000-4000-8000-000000000040",
      deletedObjectCount: 0,
      unplacedFixtureCount: 0,
      deletedSlotCount: 0,
      createdSlotCount: 2_000,
      floorPlan: {
        imageUrl: "/api/floors/floor-1/assets/rendered-1/content",
        sourceType: "image",
        originalFileUrl: asset.accessPath,
        renderedImageUrl: "/api/floors/floor-1/assets/rendered-1/content",
        width: 640,
        height: 480,
        gridSize: 10
      }
    } satisfies FloorImportApplyResult);
    const { onApplied } = renderPanel({ review });

    openAndConfirmApply();

    await waitFor(() => expect(floorEditorApi.applyFloorImportJob).toHaveBeenCalledWith(
      "floor-1",
      queuedJob.jobId,
      { expectedRevision: 7, leaseToken: "lease-token", leaseFence: 9, confirmMapReset: true, candidateIds: acceptedIds }
    ));
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ revision: 8 }));
  });

  it("moves focus to the persistent CAD region when successful apply removes its opener", async () => {
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
      renderedAssetId: "00000000-0000-4000-8000-000000000040",
      deletedObjectCount: 2,
      unplacedFixtureCount: 4,
      deletedSlotCount: 3,
      createdSlotCount: 1,
      floorPlan: {
        imageUrl: "/api/floors/floor-1/assets/rendered-1/content",
        sourceType: "image",
        originalFileUrl: asset.accessPath,
        renderedImageUrl: "/api/floors/floor-1/assets/rendered-1/content",
        width: 640,
        height: 480,
        gridSize: 10
      }
    } satisfies FloorImportApplyResult);
    renderPanel({ review });
    const region = screen.getByRole("region", { name: "CAD 가져오기" });

    openAndConfirmApply();

    await waitFor(() => expect(screen.queryByRole("button", { name: "선택한 후보와 배경 적용" })).not.toBeInTheDocument());
    await waitFor(() => expect(region).toHaveFocus());
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
    openAndConfirmApply();

    await waitFor(() => expect(onConflict).toHaveBeenCalledOnce());
    expect(floorEditorApi.getFloorImportJob).toHaveBeenCalledWith("floor-1", queuedJob.jobId);
    expect(screen.getByText(/최신 버전을 다시 불러온 뒤/)).toBeInTheDocument();
  });

  it("requires cancelling and re-importing a legacy review job before destructive apply", async () => {
    const onConflict = vi.fn();
    const review: CadImportReviewState = {
      job: { ...queuedJob, status: "review_required", progressPercent: 100 },
      candidates: [candidate],
      acceptedCandidateIds: [candidate.id]
    };
    floorEditorApi.applyFloorImportJob.mockRejectedValueOnce(new ApiError("conflict", 409, {
      message: "CAD region exclusion metadata is unavailable; re-import required"
    }));
    renderPanel({ review, onConflict });

    openAndConfirmApply();

    expect(await screen.findByText("기존 CAD 가져오기 정보가 부족합니다. 가져오기를 취소한 뒤 파일을 다시 가져오세요."))
      .toBeInTheDocument();
    expect(floorEditorApi.getFloorImportJob).not.toHaveBeenCalled();
    expect(onConflict).not.toHaveBeenCalled();
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

    openAndConfirmApply();

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

    openAndConfirmApply();

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
    openAndConfirmApply();

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
    openAndConfirmApply();

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
    openAndConfirmApply();

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
