import { CircleCheck, FileCog, RotateCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CadImportMimeType, CadImportSourceFormat } from "@led-control/shared";
import {
  applyFloorImportJob,
  cancelFloorImportJob,
  createFloorImportJob,
  getFloorImportJob,
  listFloorImportCandidates,
  uploadFloorAsset
} from "../../api/floor-editor";
import { Button, FeedbackState, FileField, Heading, Text } from "../../components/ui";
import type {
  CadImportReviewState,
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
  review: CadImportReviewState | null;
  onReviewChange: (review: CadImportReviewState | null) => void;
  onBusyChange: (busy: boolean) => void;
  onApplied: (result: FloorImportApplyResult) => void | Promise<void>;
}

export function CadImportPanel({
  floorId,
  expectedRevision,
  leaseToken,
  leaseFence,
  disabled = false,
  review,
  onReviewChange,
  onBusyChange,
  onApplied
}: CadImportPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<FloorImportJob | null>(null);
  const [action, setAction] = useState<"idle" | "starting" | "applying" | "cancelling">("idle");
  const [error, setError] = useState<string | null>(null);
  const loadedReviewJobId = useRef<string | null>(null);
  const requestLock = useRef(false);
  const busy = useRef(false);
  const activeJob = review?.job ?? job;

  function setBusy(next: boolean) {
    if (busy.current === next) return;
    busy.current = next;
    onBusyChange(next);
  }

  useEffect(() => {
    setFile(null);
    setJob(null);
    setError(null);
    loadedReviewJobId.current = null;
    onReviewChange(null);
    setBusy(false);
  }, [floorId]);

  useEffect(() => {
    if (!activeJob || !POLLING_STATUSES.has(activeJob.status) || error) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const next = await getFloorImportJob(floorId, activeJob.jobId);
        if (active) setJob(next);
      } catch {
        if (active) setError("가져오기 진행 상태를 확인하지 못했습니다.");
      }
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [activeJob?.jobId, activeJob?.status, activeJob?.updatedAt, error, floorId]);

  useEffect(() => {
    if (!activeJob || activeJob.status !== "review_required" || review?.job.jobId === activeJob.jobId
      || loadedReviewJobId.current === activeJob.jobId) return;
    loadedReviewJobId.current = activeJob.jobId;
    let active = true;
    void listFloorImportCandidates(floorId, activeJob.jobId).then((response) => {
      if (!active) return;
      onReviewChange({
        job: activeJob,
        candidates: response.candidates,
        acceptedCandidateIds: response.candidates.map((candidate) => candidate.id)
      });
    }).catch(() => {
      if (!active) return;
      loadedReviewJobId.current = null;
      setError("조명 위치 후보를 불러오지 못했습니다.");
    });
    return () => { active = false; };
  }, [activeJob?.jobId, activeJob?.status, floorId, onReviewChange]);

  useEffect(() => {
    if (!activeJob) return;
    if (POLLING_STATUSES.has(activeJob.status) || activeJob.status === "review_required") setBusy(true);
    else setBusy(false);
  }, [activeJob?.status]);

  async function handleStart() {
    if (!file || disabled || requestLock.current) return;
    const sourceFormat = extensionOf(file.name);
    if (!sourceFormat) return;
    requestLock.current = true;
    setAction("starting");
    setError(null);
    setBusy(true);
    try {
      const source = await uploadFloorAsset(floorId, file);
      if (source.status !== "ready") throw new Error("CAD source asset is not ready");
      const created = await createFloorImportJob(floorId, { sourceAssetId: source.id, sourceFormat });
      setJob(created);
      setFile(null);
    } catch {
      setError("CAD 가져오기를 시작하지 못했습니다.");
      setBusy(false);
    } finally {
      requestLock.current = false;
      setAction("idle");
    }
  }

  async function handleApply() {
    if (!review || disabled || requestLock.current || !leaseToken || !leaseFence) return;
    requestLock.current = true;
    setAction("applying");
    setError(null);
    try {
      const result = await applyFloorImportJob(floorId, review.job.jobId, {
        expectedRevision,
        leaseToken,
        leaseFence,
        candidateIds: review.acceptedCandidateIds
      });
      await onApplied(result);
      setJob(null);
      onReviewChange(null);
      setBusy(false);
    } catch {
      setError("CAD 도면을 맵에 적용하지 못했습니다. 최신 리비전과 편집 권한을 확인하세요.");
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

  const status = activeJob ? statusText(activeJob) : null;
  return (
    <section className="grid gap-3 border-t border-border-subtle p-3" aria-label="CAD 가져오기">
      <div className="grid gap-1">
        <Text variant="overline" tone="secondary">CAD</Text>
        <Heading as="h3" variant="card-title">DWG/DXF 가져오기</Heading>
      </div>

      {!activeJob ? <>
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
          disabled={!file || disabled}
          isLoading={action === "starting"}
          loadingLabel="가져오기 시작 중"
          onClick={() => void handleStart()}
        >
          <FileCog size={16} aria-hidden="true" />
          CAD 가져오기
        </Button>
      </> : null}

      {activeJob && activeJob.status !== "review_required" ? <div className="grid gap-2" role="status">
        <div className="flex items-center justify-between gap-2">
          <Text variant="body-sm" weight="semibold">{status}</Text>
          <Text variant="caption" tone="secondary">{activeJob.progressPercent}%</Text>
        </div>
        <progress className="h-2 w-full" max={100} value={activeJob.progressPercent} aria-label="CAD 가져오기 진행률" />
      </div> : null}

      {review ? <>
        <FeedbackState
          tone="success"
          icon={CircleCheck}
          title={`조명 위치 후보 ${review.candidates.length.toLocaleString("ko-KR")}개를 찾았습니다.`}
          description={`적용 후보 ${review.acceptedCandidateIds.length.toLocaleString("ko-KR")}개 · 후보는 실제 조명으로 자동 등록되지 않습니다.`}
        />
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || review.acceptedCandidateIds.length === review.candidates.length}
            onClick={() => onReviewChange({ ...review, acceptedCandidateIds: review.candidates.map((candidate) => candidate.id) })}
          >전체 선택</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || review.acceptedCandidateIds.length === 0}
            onClick={() => onReviewChange({ ...review, acceptedCandidateIds: [] })}
          >선택 해제</Button>
        </div>
        <Button
          variant="primary"
          disabled={disabled || !leaseToken || !leaseFence}
          isLoading={action === "applying"}
          loadingLabel="맵에 적용 중"
          onClick={() => void handleApply()}
        >
          <CircleCheck size={16} aria-hidden="true" />
          선택한 후보와 배경 적용
        </Button>
      </> : null}

      {activeJob ? <Button
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
        action={activeJob && POLLING_STATUSES.has(activeJob.status)
          ? <Button variant="secondary" onClick={() => setError(null)}><RotateCw size={16} aria-hidden="true" />다시 확인</Button>
          : undefined}
      /> : null}
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
  if (!(CAD_MIME_TYPES[extension] as readonly string[]).includes(file.type)) {
    return "파일 형식과 확장자가 일치하지 않습니다.";
  }
  return null;
}

function statusText(job: FloorImportJob) {
  if (job.status === "queued") return "가져오기 대기 중";
  if (job.status === "processing") return "CAD 도면을 분석하는 중";
  if (job.status === "failed") return "CAD 가져오기에 실패했습니다.";
  if (job.status === "cancelled") return "CAD 가져오기가 취소되었습니다.";
  if (job.status === "completed") return "CAD 도면을 적용했습니다.";
  return "CAD 도면을 적용하는 중";
}
