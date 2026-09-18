import { ChevronLeft, ChevronRight, CircleCheck, FileCog, RotateCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CadImportMimeType, CadImportSourceFormat } from "@led-control/shared";
import { cadImportStageLabel } from "../../../../../packages/shared/src/cad-import-contracts";
import {
  applyFloorImportJob,
  cancelFloorImportJob,
  createFloorImportJob,
  getActiveFloorImportJob,
  getFloorImportJob,
  listFloorImportCandidates,
  uploadFloorAsset
} from "../../api/floor-editor";
import { ApiError } from "../../api/client";
import { Button, Checkbox, ConfirmDialog, FeedbackState, FileField, Heading, IconButton, Text } from "../../components/ui";
import type {
  CadImportReviewState,
  CadMapResetSummary,
  FloorImportApplyResult,
  FloorImportJob
} from "./editor-types";

const MAX_CAD_BYTES = 50 * 1024 * 1024;
const POLL_INTERVAL_MS = 1_000;
// Keep these values aligned with cadImportFileTypeSchema. The shared package's
// root CommonJS entry is type-safe in Vite but cannot expose new runtime names.
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
  const [action, setAction] = useState<"idle" | "starting" | "applying" | "cancelling" | "checking">("idle");
  const [error, setError] = useState<string | null>(null);
  const [reviewCursor, setReviewCursor] = useState(0);
  const [suppressedReviewJobId, setSuppressedReviewJobId] = useState<string | null>(null);
  const [refreshRecoveryJob, setRefreshRecoveryJob] = useState<FloorImportJob | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const loadedReviewJobId = useRef<string | null>(null);
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

  function setBusy(next: boolean) {
    if (busy.current === next) return;
    busy.current = next;
    onBusyChange(next);
  }

  useEffect(() => {
    setFile(null);
    setJob(null);
    setError(null);
    setSuppressedReviewJobId(null);
    setRefreshRecoveryJob(null);
    setConfirmApply(false);
    loadedReviewJobId.current = null;
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
          reviewChange.current(null);
          setBusy(false);
          setError(statusText(next));
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
    if (POLLING_STATUSES.has(activeJob.status) || activeJob.status === "review_required") setBusy(true);
    else setBusy(false);
  }, [activeJob?.status]);

  async function handleStart() {
    if (!file || disabled || isDirty || requestLock.current) return;
    const sourceFormat = extensionOf(file.name);
    if (!sourceFormat) return;
    requestLock.current = true;
    setAction("starting");
    setError(null);
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
      onReviewChange(null);
      setBusy(false);
    } catch (caught) {
      const isConflict = caught instanceof ApiError && caught.status === 409;
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
        onReviewChange(null);
        setBusy(false);
        setError(statusText(next));
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
    try {
      await cancelFloorImportJob(floorId, activeJob.jobId);
      setSuppressedReviewJobId(activeJob.jobId);
      setJob(null);
      onReviewChange(null);
      setBusy(false);
    } catch {
      setError("CAD 가져오기를 취소하지 못했습니다.");
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
      : cadImportStageLabel(activeJob.stage)
    : null;
  return (
    <section className="grid gap-3 border-t border-border-subtle p-3" aria-label="CAD 가져오기">
      <div className="grid gap-1">
        <Text variant="overline" tone="secondary">CAD</Text>
        <Heading as="h3" variant="card-title">DWG/DXF 가져오기</Heading>
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

      {activeJob && (activeJob.status !== "review_required" || isReviewLoading)
        ? <div className="grid gap-2" role="status">
        <div className="flex items-center justify-between gap-2">
          <Text variant="body-sm" weight="semibold">{status}</Text>
          <Text variant="caption" tone="secondary">{activeJob.progressPercent}%</Text>
        </div>
        <progress className="h-2 w-full" max={100} value={activeJob.progressPercent} aria-label="CAD 가져오기 진행률" />
      </div> : null}

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

      {activeJob && ["queued", "processing", "review_required"].includes(activeJob.status) ? <Button
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
        title={error}
        action={activeJob && (POLLING_STATUSES.has(activeJob.status) || activeJob.status === "review_required")
          ? <Button variant="secondary" onClick={() => setError(null)}><RotateCw size={16} aria-hidden="true" />다시 확인</Button>
          : undefined}
      /> : null}
      {confirmApply && activeReview ? <ConfirmDialog
        title="새 CAD 도면으로 맵을 교체할까요?"
        confirmLabel="교체 후 적용"
        destructive
        isPending={action === "applying"}
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

function statusText(job: FloorImportJob) {
  if (job.status === "queued") return "가져오기 대기 중";
  if (job.status === "processing") return "CAD 도면을 분석하는 중";
  if (job.status === "failed") return "CAD 가져오기에 실패했습니다.";
  if (job.status === "cancelled") return "CAD 가져오기가 취소되었습니다.";
  if (job.status === "completed") return "CAD 도면을 적용했습니다.";
  return "CAD 도면을 적용하는 중";
}
