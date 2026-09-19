import { ChevronLeft, ChevronRight, CircleCheck, FileCog, RotateCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CadImportMimeType,
  type CadImportSourceFormat,
  type CadRegion,
  type FloorImportRegionListResponse
} from "@led-control/shared";
import { normalizeCadMapSize } from "@led-control/shared/cad-scene-contracts";
import { cadImportStageLabel } from "@led-control/shared/cad-import-contracts";
import {
  applyFloorImportJob,
  cancelFloorImportJob,
  createFloorImportJob,
  getActiveFloorImportJob,
  getFloorImportJob,
  listFloorImportCandidates,
  uploadFloorAsset
} from "../../api/floor-editor";
import { listFloorImportRegions, selectFloorImportRegion } from "../../api/queries";
import { ApiError } from "../../api/client";
import { Button, Checkbox, ConfirmDialog, FeedbackState, FileField, Heading, IconButton, PaginationBar, Text, type PaginationPageSize } from "../../components/ui";
import type {
  CadImportReviewState,
  CadMapResetSummary,
  FloorImportApplyResult,
  FloorImportJob
} from "./editor-types";

const MAX_CAD_BYTES = 50 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_000;
const REGION_RECOVERY_TIMEOUT_MS = 3_000;
// Keep these values aligned with cadImportFileTypeSchema.
const CAD_MIME_TYPES = {
  dwg: [
    "application/acad",
    "application/x-acad",
    "application/autocad",
    "application/dwg",
    "application/x-dwg",
    "application/vnd.autodesk.autocad.dwg",
    "image/vnd.dwg",
    "image/x-dwg"
  ],
  dxf: [
    "application/dxf",
    "application/x-dxf",
    "application/vnd.autodesk.autocad.dxf",
    "image/vnd.dxf",
    "image/x-dxf"
  ]
} as const satisfies Record<CadImportSourceFormat, readonly CadImportMimeType[]>;
const CAD_FILE_ACCEPT = [".dwg", ".dxf", ...CAD_MIME_TYPES.dwg, ...CAD_MIME_TYPES.dxf].join(",");
const POLLING_STATUSES = new Set(["queued", "processing"]);

interface CadImportPanelProps {
  floorId: string;
  expectedRevision: number;
  leaseToken?: string;
  leaseFence?: number;
  disabled?: boolean;
  isDirty?: boolean;
  resetSummary: CadMapResetSummary;
  review: CadImportReviewState | null;
  focusedCandidateId?: string | null;
  onReviewChange: (review: CadImportReviewState | null) => void;
  onFocusedCandidateChange?: (candidateId: string | null) => void;
  onBusyChange: (busy: boolean) => void;
  onApplied: (result: FloorImportApplyResult | null) => void | Promise<void>;
  onConflict?: () => void;
}

export function CadImportPanel({
  floorId,
  expectedRevision,
  leaseToken,
  leaseFence,
  disabled = false,
  isDirty = false,
  resetSummary,
  review,
  focusedCandidateId,
  onReviewChange,
  onFocusedCandidateChange,
  onBusyChange,
  onApplied,
  onConflict
}: CadImportPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<FloorImportJob | null>(null);
  const [action, setAction] = useState<"idle" | "starting" | "selecting" | "applying" | "cancelling" | "checking">("idle");
  const [error, setErrorState] = useState<{ title: string; description?: string } | null>(null);
  const [regionRecoveryError, setRegionRecoveryError] = useState<string | null>(null);
  const [reviewCursor, setReviewCursor] = useState(0);
  const [suppressedReviewJobId, setSuppressedReviewJobId] = useState<string | null>(null);
  const [refreshRecoveryJob, setRefreshRecoveryJob] = useState<FloorImportJob | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [regions, setRegions] = useState<FloorImportRegionListResponse | null>(null);
  const [regionPage, setRegionPage] = useState(1);
  const [regionPageSize, setRegionPageSize] = useState<PaginationPageSize>(20);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [activePreviewRegionId, setActivePreviewRegionId] = useState<string | null>(null);
  const [progressHighWater, setProgressHighWater] = useState(0);
  const loadedReviewJobId = useRef<string | null>(null);
  const loadedRegionJobId = useRef<string | null>(null);
  const progressJobId = useRef<string | null>(null);
  const applyFocusFallback = useRef<HTMLElement>(null);
  const importHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusProgressAfterRegionSelection = useRef(false);
  const requestLock = useRef(false);
  const busy = useRef(false);
  const reviewChange = useRef(onReviewChange);
  const focusedCandidateChange = useRef(onFocusedCandidateChange);
  reviewChange.current = onReviewChange;
  focusedCandidateChange.current = onFocusedCandidateChange;
  const activeReview = review?.job.jobId === suppressedReviewJobId ? null : review;
  const activeJob = activeReview?.job ?? job;
  const isReviewLoading = activeJob?.status === "review_required" && !activeReview && !error;
  const focusedIndex = useMemo(() => {
    if (!activeReview?.candidates.length) return 0;
    const index = focusedCandidateId
      ? activeReview.candidates.findIndex((candidate) => candidate.id === focusedCandidateId)
      : -1;
    return index >= 0 ? index : Math.min(reviewCursor, activeReview.candidates.length - 1);
  }, [focusedCandidateId, activeReview?.candidates, reviewCursor]);
  const focusedCandidate = activeReview?.candidates[focusedIndex] ?? null;
  const selectedRegion = regions?.regions.find((region) => region.regionId === selectedRegionId) ?? null;
  const rankedRegions = useMemo(() => [...(regions?.regions ?? [])].sort((a, b) =>
    b.lightCandidateCount - a.lightCandidateCount || b.primitiveCount - a.primitiveCount), [regions]);
  const currentRegionPage = Math.min(regionPage, Math.max(1, Math.ceil(rankedRegions.length / regionPageSize)));
  const regionOffset = (currentRegionPage - 1) * regionPageSize;
  const pageRegions = rankedRegions.slice(regionOffset, regionOffset + regionPageSize);
  const pagePreviewId = pageRegions.some(region => region.regionId === activePreviewRegionId)
    ? activePreviewRegionId : pageRegions[0]?.regionId;
  useEffect(() => { setRegionPage(1); }, [regions?.jobId]);
  const regionMetrics = regions && selectedRegion ? summarizeRegion(regions, selectedRegion) : null;
  const isPostSelectionHydrating = Boolean(
    activeJob && regions === null && activeJob.parserVersion !== null && POLLING_STATUSES.has(activeJob.status)
  );
  const selectedRegionPhase = Boolean(regions?.selectedRegionId) || isPostSelectionHydrating;
  const effectiveProgress = activeJob
    ? Math.max(progressHighWater, stageProgress(activeJob, selectedRegionPhase))
    : action === "starting" ? 5 : action === "applying" ? 100 : 0;

  function setError(title: string | null, description?: string) {
    setErrorState(title === null ? null : { title, description });
  }

  function setTerminalError(terminalJob: FloorImportJob) {
    setError(statusText(terminalJob), terminalJob.status === "failed"
      ? importFailureDescription(terminalJob.failureCode) : undefined);
  }

  function setBusy(next: boolean) {
    if (busy.current === next) return;
    busy.current = next;
    onBusyChange(next);
  }

  function clearRegionContext() {
    setRegions(null);
    setSelectedRegionId(null);
    setActivePreviewRegionId(null);
    setProgressHighWater(0);
    setRegionRecoveryError(null);
    loadedRegionJobId.current = null;
    progressJobId.current = null;
  }

  useEffect(() => {
    setFile(null);
    setJob(null);
    setError(null);
    setRegionRecoveryError(null);
    setSuppressedReviewJobId(null);
    setRefreshRecoveryJob(null);
    setConfirmApply(false);
    setRegions(null);
    setSelectedRegionId(null);
    setActivePreviewRegionId(null);
    setProgressHighWater(0);
    loadedReviewJobId.current = null;
    loadedRegionJobId.current = null;
    progressJobId.current = null;
    reviewChange.current(null);
    setBusy(false);
    let active = true;
    void getActiveFloorImportJob(floorId).then(({ job: durableJob }) => {
      if (!active || !durableJob) return;
      if (durableJob.status === "applying") {
        setError("이전 CAD 적용 상태를 서버에서 정리하고 있습니다. 잠시 후 다시 시도하세요.");
        return;
      }
      setJob(durableJob);
    }).catch(() => {
      if (active) setError("진행 중인 CAD 가져오기를 확인하지 못했습니다.");
    });
    return () => { active = false; };
  }, [floorId]);

  useEffect(() => {
    if (!activeJob) return;
    const next = stageProgress(activeJob, Boolean(regions?.selectedRegionId));
    if (progressJobId.current !== activeJob.jobId) {
      progressJobId.current = activeJob.jobId;
      setProgressHighWater(next);
      return;
    }
    setProgressHighWater((current) => Math.max(current, next));
  }, [activeJob?.jobId, activeJob?.progressPercent, activeJob?.stage, regions?.selectedRegionId]);

  useEffect(() => {
    if (!activeJob || error || !shouldLoadRegions(activeJob) || loadedRegionJobId.current === activeJob.jobId) return;
    loadedRegionJobId.current = activeJob.jobId;
    let active = true;
    void listFloorImportRegionsBounded(floorId, activeJob.jobId).then((response) => {
      if (!active) return;
      setRegions(response);
      setSelectedRegionId(response.selectedRegionId);
      setActivePreviewRegionId(response.selectedRegionId ?? response.regions[0]?.regionId ?? null);
      setRegionRecoveryError(null);
    }).catch(() => {
      if (!active) return;
      loadedRegionJobId.current = null;
      setError("도면 영역을 불러오지 못했습니다.");
    });
    return () => { active = false; };
  }, [activeJob?.jobId, activeJob?.status, activeJob?.parserVersion, error, floorId]);

  useEffect(() => {
    if (!focusProgressAfterRegionSelection.current || !importHeadingRef.current) return;
    focusProgressAfterRegionSelection.current = false;
    importHeadingRef.current.focus();
  }, [activeJob?.status, regions?.selectedRegionId]);

  useEffect(() => {
    if (!activeJob || !POLLING_STATUSES.has(activeJob.status) || error) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await getFloorImportJob(floorId, activeJob.jobId);
        if (!active) return;
        if (["failed", "cancelled"].includes(next.status)) {
          setSuppressedReviewJobId(next.jobId);
          setJob(null);
          clearRegionContext();
          reviewChange.current(null);
          setBusy(false);
          setTerminalError(next);
        } else {
          setJob(next);
        }
      } catch {
        if (active) setError("가져오기 진행 상태를 확인하지 못했습니다.");
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeJob?.jobId, activeJob?.status, error, floorId]);

  useEffect(() => {
    if (!activeJob || activeJob.status !== "review_required" || review?.job.jobId === activeJob.jobId
      || loadedReviewJobId.current === activeJob.jobId || error) return;
    loadedReviewJobId.current = activeJob.jobId;
    let active = true;
    void listFloorImportCandidates(floorId, activeJob.jobId).then((response) => {
      if (!active) return;
      reviewChange.current({
        job: activeJob,
        candidates: response.candidates,
        acceptedCandidateIds: response.candidates.map((candidate) => candidate.id)
      });
      setSuppressedReviewJobId(null);
      setReviewCursor(0);
      focusedCandidateChange.current?.(response.candidates[0]?.id ?? null);
    }).catch(() => {
      if (!active) return;
      loadedReviewJobId.current = null;
      setError("조명 위치 후보를 불러오지 못했습니다.");
    });
    return () => { active = false; };
  }, [activeJob?.jobId, activeJob?.status, error, floorId, review?.job.jobId]);

  useEffect(() => {
    if (!activeJob) return;
    if (POLLING_STATUSES.has(activeJob.status) || activeJob.status === "region_selection_required" || activeJob.status === "review_required") setBusy(true);
    else setBusy(false);
  }, [activeJob?.status]);

  async function handleStart() {
    if (!file || disabled || isDirty || requestLock.current) return;
    const sourceFormat = extensionOf(file.name);
    if (!sourceFormat) return;
    requestLock.current = true;
    setAction("starting");
    setError(null);
    setRegionRecoveryError(null);
    clearRegionContext();
    setBusy(true);
    try {
      const source = await uploadFloorAsset(floorId, normalizeCadFile(file, sourceFormat));
      if (source.status !== "ready") throw new Error("CAD source asset is not ready");
      const created = await createFloorImportJob(floorId, {
        sourceAssetId: source.id, sourceFormat
      });
      setJob(created);
      setFile(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        try {
          const { job: durableJob } = await getActiveFloorImportJob(floorId);
          if (durableJob) {
            setJob(durableJob);
            setFile(null);
            return;
          }
        } catch {
          // Fall through to a stable recovery message.
        }
      }
      setError("CAD 가져오기를 시작하지 못했습니다.");
      setBusy(false);
    } finally {
      requestLock.current = false;
      setAction("idle");
    }
  }

  async function handleApply() {
    if (!activeReview || disabled || isDirty || requestLock.current || !leaseToken || !leaseFence) return;
    requestLock.current = true;
    setAction("applying");
    setError(null);
    try {
      const result = await applyFloorImportJob(floorId, activeReview.job.jobId, {
        expectedRevision,
        leaseToken,
        leaseFence,
        confirmMapReset: true,
        candidateIds: activeReview.acceptedCandidateIds
      });
      await onApplied(result);
      setSuppressedReviewJobId(activeReview.job.jobId);
      setJob(null);
      clearRegionContext();
      onReviewChange(null);
      setBusy(false);
    } catch (caught) {
      const isConflict = caught instanceof ApiError && caught.status === 409;
      if (isConflict && JSON.stringify(caught.body).includes("re-import required")) {
        setError("기존 CAD 가져오기 정보가 부족합니다. 가져오기를 취소한 뒤 파일을 다시 가져오세요.");
        return;
      }
      const reconciledStatus = await reconcileJob(activeReview.job.jobId, true);
      if (isConflict && reconciledStatus === "review_required") {
        onConflict?.();
        setError("최신 버전을 다시 불러온 뒤 CAD 적용을 다시 확인하세요.");
      }
    } finally {
      requestLock.current = false;
      setAction("idle");
      setConfirmApply(false);
    }
  }

  async function handleRegionSelect() {
    if (!activeJob || !regions || regions.selectionStatus !== "selection_required" || !selectedRegionId ||
        disabled || isDirty || requestLock.current) return;
    requestLock.current = true;
    setAction("selecting");
    setError(null);
    setRegionRecoveryError(null);
    try {
      const response = await selectFloorImportRegion(floorId, activeJob.jobId, selectedRegionId);
      focusProgressAfterRegionSelection.current = true;
      setRegions(response);
      setSelectedRegionId(response.selectedRegionId);
      setActivePreviewRegionId(response.selectedRegionId);
      setProgressHighWater((current) => Math.max(current, 72));
      setJob({
        ...activeJob,
        status: "queued",
        stage: "queued",
        progressPercent: 0,
        attemptCount: 0
      });
    } catch {
      const canonical = await reconcileMutationState(activeJob.jobId);
      if (canonical?.regions?.selectedRegionId) {
        focusProgressAfterRegionSelection.current = true;
      } else if (canonical?.regionLookupFailed) {
        // The canonical job state is already applied. Region recovery has its own bounded retry UI.
      } else if (canonical?.job.status === "region_selection_required") {
        setError("도면 영역 선택이 반영되지 않았습니다. 다시 시도하세요.");
      } else if (!canonical) {
        setError("도면 영역 선택 결과를 확인하지 못했습니다. 다시 시도하세요.");
      }
    } finally {
      requestLock.current = false;
      setAction("idle");
    }
  }

  async function reconcileMutationState(jobId: string) {
    try {
      const nextJob = await getFloorImportJob(floorId, jobId);
      if (nextJob.status === "completed") {
        setSuppressedReviewJobId(nextJob.jobId);
        setRefreshRecoveryJob(nextJob);
        setJob(null);
        clearRegionContext();
        setBusy(false);
        try {
          await onApplied(null);
          reviewChange.current(null);
          setRefreshRecoveryJob(null);
          setError(null);
        } catch {
          setError("CAD 적용은 완료되었지만 최신 맵을 불러오지 못했습니다. 다시 불러오세요.");
        }
        return { job: nextJob, regions: null, regionLookupFailed: false, terminalHandled: true };
      }
      if (["cancelled", "failed"].includes(nextJob.status)) {
        setSuppressedReviewJobId(nextJob.jobId);
        setJob(null);
        clearRegionContext();
        reviewChange.current(null);
        setBusy(false);
        setTerminalError(nextJob);
        return { job: nextJob, regions: null, regionLookupFailed: false, terminalHandled: true };
      }

      setJob(nextJob);
      setError(null);
      if (!shouldLoadRegions(nextJob)) {
        return { job: nextJob, regions: null, regionLookupFailed: false, terminalHandled: false };
      }

      loadedRegionJobId.current = nextJob.jobId;
      let nextRegions: FloorImportRegionListResponse;
      try {
        nextRegions = await listFloorImportRegionsBounded(floorId, jobId);
      } catch {
        setRegionRecoveryError("선택 상태는 확인했지만 도면 영역 정보를 불러오지 못했습니다.");
        return { job: nextJob, regions: null, regionLookupFailed: true, terminalHandled: false };
      }

      applyRegionResponse(nextRegions);
      setRegionRecoveryError(null);
      return { job: nextJob, regions: nextRegions, regionLookupFailed: false, terminalHandled: false };
    } catch {
      return null;
    }
  }

  function applyRegionResponse(response: FloorImportRegionListResponse) {
    setRegions(response);
    setSelectedRegionId(response.selectedRegionId);
    setActivePreviewRegionId(response.selectedRegionId ?? response.regions[0]?.regionId ?? null);
    if (response.selectedRegionId) setProgressHighWater((current) => Math.max(current, 72));
  }

  async function handleRegionRecovery() {
    if (!activeJob || requestLock.current || !shouldLoadRegions(activeJob)) return;
    requestLock.current = true;
    setAction("checking");
    try {
      const response = await listFloorImportRegionsBounded(floorId, activeJob.jobId);
      loadedRegionJobId.current = activeJob.jobId;
      applyRegionResponse(response);
      setRegionRecoveryError(null);
    } catch {
      setRegionRecoveryError("선택 상태는 확인했지만 도면 영역 정보를 불러오지 못했습니다.");
    } finally {
      requestLock.current = false;
      setAction("idle");
    }
  }

  async function reconcileJob(jobId: string, unknownApplyResult = false): Promise<FloorImportJob["status"] | null> {
    try {
      const next = await getFloorImportJob(floorId, jobId);
      if (next.status === "completed") {
        setSuppressedReviewJobId(next.jobId);
        setRefreshRecoveryJob(next);
        setJob(null);
        setBusy(false);
        try {
          await onApplied(null);
          onReviewChange(null);
          setRefreshRecoveryJob(null);
          setError(null);
        } catch {
          setError("CAD 적용은 완료되었지만 최신 맵을 불러오지 못했습니다. 다시 불러오세요.");
        }
        return next.status;
      }
      if (next.status === "review_required") {
        setJob(next);
        if (review?.job.jobId === next.jobId) onReviewChange({ ...review, job: next });
        setError(unknownApplyResult ? "서버 적용이 완료되지 않았습니다. 후보 선택을 확인한 뒤 다시 시도하세요." : null);
        return next.status;
      }
      if (next.status === "applying") {
        setSuppressedReviewJobId(next.jobId);
        setJob(null);
        onReviewChange(null);
        setBusy(false);
        setError("이전 CAD 적용 상태를 서버에서 정리하고 있습니다. 잠시 후 다시 시도하세요.");
        return next.status;
      }
      if (["failed", "cancelled"].includes(next.status)) {
        setSuppressedReviewJobId(next.jobId);
        setJob(null);
        clearRegionContext();
        onReviewChange(null);
        setBusy(false);
        setTerminalError(next);
        return next.status;
      }
      setJob(next);
      setError(unknownApplyResult ? `적용 결과를 확인했습니다. ${statusText(next)}` : null);
      return next.status;
    } catch {
      setError("적용 결과를 확인하지 못했습니다. 다시 확인한 뒤 재시도하세요.");
      return null;
    }
  }

  async function handleRefreshRecovery() {
    if (!refreshRecoveryJob || requestLock.current) return;
    requestLock.current = true;
    setAction("checking");
    try {
      await onApplied(null);
      onReviewChange(null);
      setRefreshRecoveryJob(null);
      setError(null);
    } catch {
      setError("CAD 적용은 완료되었지만 최신 맵을 불러오지 못했습니다. 다시 불러오세요.");
    } finally {
      requestLock.current = false;
      setAction("idle");
    }
  }

  async function handleCancel() {
    if (!activeJob || disabled || requestLock.current) return;
    requestLock.current = true;
    setAction("cancelling");
    setError(null);
    setRegionRecoveryError(null);
    try {
      await cancelFloorImportJob(floorId, activeJob.jobId);
      setSuppressedReviewJobId(activeJob.jobId);
      setJob(null);
      clearRegionContext();
      onReviewChange(null);
      setBusy(false);
    } catch {
      const canonical = await reconcileMutationState(activeJob.jobId);
      if (!canonical) setError("CAD 가져오기 취소 결과를 확인하지 못했습니다. 다시 시도하세요.");
      else if (!canonical.terminalHandled) {
        setError("서버에서 가져오기가 아직 취소되지 않았습니다. 다시 시도하세요.");
      }
    } finally {
      requestLock.current = false;
      setAction("idle");
    }
  }

  function moveCandidate(delta: number) {
    if (!activeReview?.candidates.length) return;
    const next = Math.max(0, Math.min(activeReview.candidates.length - 1, focusedIndex + delta));
    setReviewCursor(next);
    onFocusedCandidateChange?.(activeReview.candidates[next].id);
  }

  function toggleFocusedCandidate() {
    if (!activeReview || !focusedCandidate) return;
    const accepted = new Set(activeReview.acceptedCandidateIds);
    if (accepted.has(focusedCandidate.id)) accepted.delete(focusedCandidate.id);
    else accepted.add(focusedCandidate.id);
    onReviewChange({ ...activeReview, acceptedCandidateIds: [...accepted] });
  }

  const status = activeJob
    ? isReviewLoading
      ? `${cadImportStageLabel(activeJob.stage)} · 조명 위치 후보를 불러오는 중`
      : isPostSelectionHydrating
        ? "선택한 영역을 복원하는 중"
        : sceneBuildStatus(activeJob, selectedRegionPhase)
    : null;
  return (
    <section ref={applyFocusFallback} tabIndex={-1} className="grid gap-3 border-t border-border-subtle p-3" aria-label="CAD 가져오기">
      <div className="grid gap-1">
        <Text variant="overline" tone="secondary">CAD</Text>
        <Heading ref={importHeadingRef} tabIndex={-1} as="h3" variant="card-title">DWG/DXF 가져오기</Heading>
      </div>

      {!activeJob && !refreshRecoveryJob ? <>
        <FileField
          label="CAD 파일"
          description="DWG 또는 DXF · 최대 50 MB"
          accept={CAD_FILE_ACCEPT}
          isDisabled={disabled || action !== "idle"}
          isInvalid={Boolean(error)}
          onChange={(files) => {
            const selected = files?.[0] ?? null;
            const validationError = selected ? validateCadFile(selected) : null;
            setFile(validationError ? null : selected);
            setError(validationError);
          }}
        />
        {file ? <Text variant="body-sm" tone="secondary">{file.name}</Text> : null}
        <Button
          variant="secondary"
          disabled={!file || disabled || isDirty}
          isLoading={action === "starting"}
          loadingLabel="가져오기 시작 중"
          onClick={() => void handleStart()}
        >
          <FileCog size={16} aria-hidden="true" />
          CAD 가져오기
        </Button>
      </> : null}

      {isDirty ? <FeedbackState
        tone="warning"
        icon={TriangleAlert}
        title="저장하지 않은 맵 변경사항이 있습니다."
        description="CAD 가져오기 또는 적용 전에 먼저 저장하거나 취소해 변경사항을 폐기하세요."
      /> : null}

      {(activeJob && (activeJob.status !== "review_required" || isReviewLoading)) || action === "starting" || action === "applying"
        ? <div
          className="grid gap-2"
          role="status"
          aria-label="CAD 가져오기 상태"
          tabIndex={-1}
        >
        <div className="flex items-center justify-between gap-2">
          <Text variant="body-sm" weight="semibold">{action === "starting"
            ? "CAD 파일을 업로드하는 중"
            : action === "applying" ? "검토한 맵을 적용하는 중" : status}</Text>
          <Text variant="caption" tone="secondary">{effectiveProgress}%</Text>
        </div>
        <progress className="h-2 w-full" max={100} value={effectiveProgress} aria-label="CAD 가져오기 진행률" />
      </div> : null}

      {activeJob?.status === "region_selection_required" && regions?.selectionStatus === "selection_required" ? <>
        <FeedbackState
          tone="warning"
          icon={TriangleAlert}
          title={`${regions.regions.length.toLocaleString("ko-KR")}개의 도면 영역을 찾았습니다.`}
          description="한 층으로 사용할 영역을 선택하세요. 선택하지 않은 영역은 새 맵에서 제외됩니다."
        />
        <div className="grid max-h-[28rem] gap-2 overflow-y-auto pr-1" role="radiogroup" aria-label="가져올 도면 영역">
          {pageRegions.map((region, pageIndex) => {
            const index = regionOffset + pageIndex;
            const checked = selectedRegionId === region.regionId;
            const previewActive = pagePreviewId === region.regionId;
            return <div
              key={region.regionId}
              className={`grid gap-2 border p-2 ${checked ? "border-action-primary bg-action-primary-soft" : "border-border-subtle bg-surface-panel"}`}
            >
              <label className="grid cursor-pointer gap-1">
                <input
                  type="radio"
                  name={`cad-region-${activeJob.jobId}`}
                  checked={checked}
                  disabled={disabled || isDirty || action !== "idle"}
                  onChange={() => {
                    setSelectedRegionId(region.regionId);
                    setActivePreviewRegionId(region.regionId);
                  }}
                  aria-label={`도면 영역 ${index + 1} · 도형 ${region.primitiveCount.toLocaleString("ko-KR")}개`}
                />
                <Text variant="body-sm" weight="semibold">도면 영역 {index + 1}</Text>
                <Text variant="caption" tone="secondary">
                  도형 {region.primitiveCount.toLocaleString("ko-KR")}개 · 문자 {region.textCount.toLocaleString("ko-KR")}개 · 조명 후보 {region.lightCandidateCount.toLocaleString("ko-KR")}개
                </Text>
              </label>
              {previewActive ? <img
                className="h-32 w-full border border-border-subtle bg-surface-canvas object-contain"
                src={regionPreviewPath(floorId, region.preview.assetId)}
                alt={`도면 영역 ${index + 1} 미리보기`}
                width={region.preview.width}
                height={region.preview.height}
                loading="lazy"
                decoding="async"
              /> : <Button
                size="sm"
                variant="ghost"
                onClick={() => setActivePreviewRegionId(region.regionId)}
              >도면 영역 {index + 1} 미리보기 보기</Button>}
            </div>;
          })}
        </div>
        {rankedRegions.length > 20 ? <PaginationBar page={currentRegionPage} pageSize={regionPageSize}
          totalCount={rankedRegions.length} hasPrevious={currentRegionPage > 1}
          hasNext={regionOffset + regionPageSize < rankedRegions.length}
          onPrevious={() => setRegionPage(currentRegionPage - 1)} onNext={() => setRegionPage(currentRegionPage + 1)}
          onPageSizeChange={size => { setRegionPageSize(size); setRegionPage(1); }} /> : null}
        {regionMetrics ? <RegionStatistics metrics={regionMetrics} /> : null}
        <Button
          variant="primary"
          disabled={!selectedRegionId || regionMetrics?.mapSupported === false || disabled || isDirty || action !== "idle"}
          isLoading={action === "selecting"}
          loadingLabel="선택 영역 처리 중"
          onClick={() => void handleRegionSelect()}
        >
          <FileCog size={16} aria-hidden="true" />
          선택 영역으로 장면 만들기
        </Button>
      </> : null}

      {refreshRecoveryJob && error ? <Button
        variant="secondary"
        isLoading={action === "checking"}
        loadingLabel="최신 맵 불러오는 중"
        onClick={() => void handleRefreshRecovery()}
      >
        <RotateCw size={16} aria-hidden="true" />
        최신 맵 다시 불러오기
      </Button> : null}

      {activeReview && activeReview.job.status === "review_required" ? <>
        {regions && selectedRegion && regionMetrics ? <div className="grid gap-2">
          <FeedbackState
            tone="success"
            icon={CircleCheck}
            title={regions.selectionStatus === "auto_selected"
              ? "도면 영역 1개를 자동 선택했습니다."
              : "선택한 도면 영역의 장면 생성이 완료되었습니다."}
          />
          <img
            className="h-40 w-full border border-border-subtle bg-surface-canvas object-contain"
            src={regionPreviewPath(floorId, selectedRegion.preview.assetId)}
            alt="선택한 도면 영역 미리보기"
            width={selectedRegion.preview.width}
            height={selectedRegion.preview.height}
          />
          <RegionStatistics metrics={regionMetrics} />
        </div> : null}
        <FeedbackState
          tone="success"
          icon={CircleCheck}
          title={`조명 위치 후보 ${activeReview.candidates.length.toLocaleString("ko-KR")}개를 찾았습니다.`}
          description={`적용 후보 ${activeReview.acceptedCandidateIds.length.toLocaleString("ko-KR")}개 · 후보는 실제 조명으로 자동 등록되지 않습니다.`}
        />
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || activeReview.acceptedCandidateIds.length === activeReview.candidates.length}
            onClick={() => onReviewChange({ ...activeReview, acceptedCandidateIds: activeReview.candidates.map((candidate) => candidate.id) })}
          >전체 선택</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || activeReview.acceptedCandidateIds.length === 0}
            onClick={() => onReviewChange({ ...activeReview, acceptedCandidateIds: [] })}
          >선택 해제</Button>
        </div>
        {focusedCandidate ? <div className="grid gap-2 border-t border-border-subtle pt-2" aria-label="개별 후보 검토">
          <div className="flex items-center justify-between gap-2">
            <IconButton
              size="sm"
              variant="ghost"
              aria-label="이전 후보"
              disabled={focusedIndex === 0}
              onClick={() => moveCandidate(-1)}
            ><ChevronLeft size={16} aria-hidden="true" /></IconButton>
            <Text variant="caption" tone="secondary">{focusedIndex + 1} / {activeReview.candidates.length.toLocaleString("ko-KR")}</Text>
            <IconButton
              size="sm"
              variant="ghost"
              aria-label="다음 후보"
              disabled={focusedIndex >= activeReview.candidates.length - 1}
              onClick={() => moveCandidate(1)}
            ><ChevronRight size={16} aria-hidden="true" /></IconButton>
          </div>
          <Checkbox
            label={`후보 ${focusedIndex + 1}/${activeReview.candidates.length.toLocaleString("ko-KR")} · ${focusedCandidate.layerName} · ${focusedCandidate.blockName ?? "블록 없음"} · 신뢰도 ${Math.round(focusedCandidate.confidence * 100)}%`}
            isSelected={activeReview.acceptedCandidateIds.includes(focusedCandidate.id)}
            isDisabled={disabled || isDirty}
            onChange={() => toggleFocusedCandidate()}
          />
        </div> : null}
        <Button
          variant="primary"
          disabled={disabled || isDirty || !leaseToken || !leaseFence}
          isLoading={action === "applying"}
          loadingLabel="맵에 적용 중"
          onClick={() => setConfirmApply(true)}
        >
          <CircleCheck size={16} aria-hidden="true" />
          선택한 후보와 배경 적용
        </Button>
      </> : null}

      {activeJob && ["queued", "processing", "region_selection_required", "review_required"].includes(activeJob.status) ? <Button
        variant="ghost"
        disabled={disabled || action !== "idle"}
        isLoading={action === "cancelling"}
        loadingLabel="취소 중"
        onClick={() => void handleCancel()}
      >
        <X size={16} aria-hidden="true" />
        가져오기 취소
      </Button> : null}

      {error ? <FeedbackState
        tone="danger"
        icon={TriangleAlert}
        title={error.title}
        description={error.description}
        action={activeJob && (POLLING_STATUSES.has(activeJob.status) || activeJob.status === "region_selection_required" || activeJob.status === "review_required")
          ? <Button variant="secondary" onClick={() => setError(null)}><RotateCw size={16} aria-hidden="true" />다시 확인</Button>
          : undefined}
      /> : null}
      {regionRecoveryError ? <FeedbackState
        tone="warning"
        icon={TriangleAlert}
        title={regionRecoveryError}
        action={<Button
          variant="secondary"
          isLoading={action === "checking"}
          loadingLabel="도면 영역 확인 중"
          onClick={() => void handleRegionRecovery()}
        ><RotateCw size={16} aria-hidden="true" />도면 영역 다시 확인</Button>}
      /> : null}
      {confirmApply && activeReview ? <ConfirmDialog
        title="새 CAD 도면으로 맵을 교체할까요?"
        confirmLabel="교체 후 적용"
        destructive
        isPending={action === "applying"}
        fallbackFocusRef={applyFocusFallback}
        onCancel={() => setConfirmApply(false)}
        onConfirm={() => void handleApply()}
      >
        <div className="grid gap-1.5">
          <Text>조명 {resetSummary.fixtureCount.toLocaleString("ko-KR")}개가 미배치 상태로 변경됩니다.</Text>
          <Text>수동 도형 {resetSummary.objectCount.toLocaleString("ko-KR")}개가 삭제됩니다.</Text>
          <Text>기존 CAD 슬롯 {resetSummary.slotCount.toLocaleString("ko-KR")}개가 삭제됩니다.</Text>
          <Text>선택한 조명 위치 슬롯 {activeReview.acceptedCandidateIds.length.toLocaleString("ko-KR")}개가 생성됩니다.</Text>
        </div>
      </ConfirmDialog> : null}
    </section>
  );
}

function extensionOf(name: string): CadImportSourceFormat | null {
  const extension = name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return extension === "dwg" || extension === "dxf" ? extension : null;
}

function validateCadFile(file: File): string | null {
  if (file.size === 0) return "빈 파일은 가져올 수 없습니다.";
  if (file.size > MAX_CAD_BYTES) return "파일 크기는 50 MB 이하여야 합니다.";
  const extension = extensionOf(file.name);
  if (!extension) return "DWG, DXF 파일만 가져올 수 있습니다.";
  if (file.type && !(CAD_MIME_TYPES[extension] as readonly string[]).includes(file.type)) {
    return "파일 형식과 확장자가 일치하지 않습니다.";
  }
  return null;
}

function normalizeCadFile(file: File, sourceFormat: CadImportSourceFormat) {
  if (file.type) return file;
  const type = sourceFormat === "dwg" ? "application/dwg" : "application/dxf";
  return new File([file], file.name, { type, lastModified: file.lastModified });
}

function importFailureDescription(code: string | null): string {
  // Only existing worker phase codes select public copy. Raw diagnostics may
  // contain paths or infrastructure details and must never reach this panel.
  switch (code) {
    case "CAD_IMPORT_SOURCE_INVALID":
      return "원본 CAD 파일을 확인하거나 읽는 단계에서 실패했습니다. 파일이 CAD 프로그램에서 열리는지 확인한 뒤 파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
    case "CAD_IMPORT_CONVERSION_FAILED":
      return "CAD 파일을 변환하는 단계에서 실패했습니다. CAD 프로그램에서 DWG 또는 DXF로 다시 저장한 뒤 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
    case "CAD_IMPORT_PARSE_FAILED":
      return "CAD 도면 분석 단계에서 실패했습니다. 파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
    case "CAD_IMPORT_DETECTION_FAILED":
      return "도면 영역이나 조명 후보를 찾는 단계에서 실패했습니다. 파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
    case "CAD_IMPORT_RENDER_FAILED":
      return "도면 미리보기나 장면을 만드는 단계에서 실패했습니다. 파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
    case "CAD_IMPORT_STORAGE_FAILED":
      return "가져오기 결과 파일을 저장하는 단계에서 실패했습니다. 잠시 후 파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
    case "CAD_IMPORT_PERSIST_FAILED":
      return "가져오기 결과 정보를 저장하는 단계에서 실패했습니다. 잠시 후 파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
    case "CAD_IMPORT_ATTEMPTS_EXHAUSTED":
      return "자동 재시도 횟수를 모두 사용해 가져오기가 중단되었습니다. 잠시 후 파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
    default:
      return "파일을 다시 선택해 가져오세요. 문제가 반복되면 관리자에게 문의하세요.";
  }
}

function statusText(job: FloorImportJob) {
  if (job.status === "queued") return "가져오기 대기 중";
  if (job.status === "processing") return "CAD 도면을 분석하는 중";
  if (job.status === "failed") return "CAD 가져오기에 실패했습니다.";
  if (job.status === "cancelled") return "CAD 가져오기가 취소되었습니다.";
  if (job.status === "completed") return "CAD 도면을 적용했습니다.";
  return "CAD 도면을 적용하는 중";
}

function shouldLoadRegions(job: FloorImportJob) {
  return job.status === "region_selection_required" || job.status === "review_required" || job.parserVersion !== null;
}

async function listFloorImportRegionsBounded(floorId: string, jobId: string) {
  const controller = new AbortController();
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      listFloorImportRegions(floorId, jobId, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => {
          controller.abort();
          reject(new DOMException("CAD region recovery timed out", "TimeoutError"));
        }, REGION_RECOVERY_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function stageProgress(job: FloorImportJob, selectedRegion: boolean) {
  if (job.status === "review_required" || job.status === "completed") return 100;
  if (job.status === "region_selection_required") return Math.max(job.progressPercent, 70);
  if (!selectedRegion) return job.progressPercent;
  const minimumByStage: Record<string, number> = {
    queued: 72,
    downloading: 72,
    converting: 74,
    parsing: 76,
    detecting_regions: 78,
    compiling_scene: 80,
    rendering: 88,
    persisting: 94,
    applying: 100
  };
  return Math.max(job.progressPercent, minimumByStage[job.stage] ?? 72);
}

function sceneBuildStatus(job: FloorImportJob, selectedRegion: boolean) {
  if (!selectedRegion) return cadImportStageLabel(job.stage);
  if (job.stage === "queued" || job.stage === "downloading" || job.stage === "compiling_scene") {
    return "선택 영역의 CAD 장면을 준비하는 중";
  }
  if (["converting", "parsing", "detecting_regions"].includes(job.stage)) {
    return "선택 영역을 장면 요소로 변환하는 중";
  }
  return cadImportStageLabel(job.stage);
}

function regionPreviewPath(floorId: string, assetId: string) {
  return `/api/floors/${encodeURIComponent(floorId)}/assets/${encodeURIComponent(assetId)}/content`;
}

function summarizeRegion(response: FloorImportRegionListResponse, selected: CadRegion) {
  let mapSize: { width: number; height: number } | null = null;
  try {
    mapSize = normalizeCadMapSize(selected.bounds);
  } catch {
    // The backend enforces the same supported aspect ratio while compiling the scene.
  }
  return {
    primitiveCount: selected.primitiveCount,
    lightCandidateCount: selected.lightCandidateCount,
    excludedPrimitiveCount: response.excludedRegionPrimitiveCount,
    mapSupported: mapSize !== null,
    width: mapSize?.width ?? null,
    height: mapSize?.height ?? null
  };
}

function RegionStatistics({ metrics }: { metrics: ReturnType<typeof summarizeRegion> }) {
  const mapSize = metrics.width !== null && metrics.height !== null
    ? `새 맵 ${metrics.width.toLocaleString("ko-KR")} × ${metrics.height.toLocaleString("ko-KR")}`
    : "지원 맵 비율을 초과했습니다.";
  return <dl className="grid grid-cols-2 gap-2 border-y border-border-subtle py-2">
    <div><dt className="text-caption text-content-secondary">선택 도형</dt><dd className="m-0 text-body-sm font-semibold">도형 {metrics.primitiveCount.toLocaleString("ko-KR")}개</dd></div>
    <div><dt className="text-caption text-content-secondary">조명 위치</dt><dd className="m-0 text-body-sm font-semibold">조명 후보 {metrics.lightCandidateCount.toLocaleString("ko-KR")}개</dd></div>
    <div><dt className="text-caption text-content-secondary">제외 범위</dt><dd className="m-0 text-body-sm font-semibold">제외 요소 {metrics.excludedPrimitiveCount.toLocaleString("ko-KR")}개</dd></div>
    <div><dt className="text-caption text-content-secondary">정규화 크기</dt><dd className="m-0 text-body-sm font-semibold">{mapSize}</dd></div>
  </dl>;
}
