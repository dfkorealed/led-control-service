import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import { CheckCircle2, CircleAlert, Clock3, FileWarning, LoaderCircle } from "lucide-react";
import { Button, Card, FeedbackState, StatusBadge, Text } from "../../../components/ui";

export function ReportJobList({
  reports,
  isLoading,
  isError,
  retryingReportId,
  onRetry,
  onRegenerate,
  onDownload
}: {
  reports?: EnergyReportJob[];
  isLoading: boolean;
  isError: boolean;
  retryingReportId?: string;
  onRetry: () => void;
  onRegenerate: (job: EnergyReportJob) => void;
  onDownload: (job: EnergyReportJob) => void;
}) {
  if (isLoading) return <FeedbackState icon={LoaderCircle} title="보고서 목록을 불러오는 중" />;
  if (isError) return <FeedbackState tone="danger" icon={CircleAlert} title="보고서 목록을 불러오지 못했습니다." action={<Button variant="secondary" onClick={onRetry}>다시 시도</Button>} />;
  if (!reports?.length) return <FeedbackState icon={FileWarning} title="요청한 보고서가 없습니다." description="기간과 범위를 선택해 표준 에너지 사용량 보고서를 요청하세요." />;

  return <section className="grid min-w-0 gap-3" aria-label="요청한 보고서">
    {reports.map((job) => {
      const state = statusPresentation(job);
      const jobLabel = `${job.target.label} 보고서`;
      return <Card key={job.reportId} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 p-4 max-compact:grid-cols-1" role="article" aria-label={jobLabel}>
        <div className="flex min-w-0 items-start justify-between gap-3 max-compact:flex-wrap"><div className="grid min-w-0 gap-1"><Text as="strong" weight="bold" className="wrap-anywhere">{job.target.label}</Text><Text as="span" variant="body-sm" tone="secondary" className="tabular-nums">{scopeLabel(job.request.scope)} 보고서 · {job.request.from} ~ {job.request.to}</Text></div><StatusBadge tone={state.tone} icon={state.icon}>{state.label}</StatusBadge></div>
        <dl className="col-start-1 flex flex-wrap gap-x-4 gap-y-2 text-caption text-content-muted" role="group" aria-label="보고서 메타데이터">
          <div className="flex min-w-0 flex-wrap gap-1"><dt className="font-bold">형식</dt><dd className="m-0 wrap-anywhere text-content-primary tabular-nums">{job.request.format.toUpperCase()}</dd></div>
          <div className="flex min-w-0 flex-wrap gap-1"><dt className="font-bold">범위</dt><dd className="m-0 wrap-anywhere text-content-primary">{scopeLabel(job.request.scope)}</dd></div>
          <div className="flex min-w-0 flex-wrap gap-1"><dt className="font-bold">요청 시각</dt><dd className="m-0 wrap-anywhere text-content-primary tabular-nums"><ReportTime timestamp={job.requestedAt} /></dd></div>
          {job.expiresAt ? <div className="flex min-w-0 flex-wrap gap-1"><dt className="font-bold">파일 만료 시각</dt><dd className="m-0 wrap-anywhere text-content-primary tabular-nums"><ReportTime timestamp={job.expiresAt} /></dd></div> : null}
          {job.status === "processing" ? <div className="flex min-w-0 flex-wrap gap-1"><dt className="font-bold">진행률</dt><dd className="m-0 text-content-primary tabular-nums">{job.progressPercent}%</dd></div> : null}
        </dl>
        {job.status === "failed" && job.failure ? (
          <div className="col-start-1 grid gap-1 rounded-control bg-status-danger-background p-3 text-body-sm text-status-danger-foreground wrap-anywhere" role="region" aria-label={`${job.target.label} 실패 안내`}>
            <strong>{job.failure.message}</strong><span>{job.failure.action}</span>
          </div>
        ) : null}
        {(job.status === "completed" || job.status === "failed" || job.status === "expired") ? (
          <div className="col-start-2 row-span-3 row-start-1 flex self-center max-compact:col-start-1 max-compact:row-auto max-compact:w-full [&_.ui-button]:min-w-28 max-compact:[&_.ui-button]:w-full" role="group" aria-label="보고서 작업">
            {job.status === "completed" ? <Button variant="primary" aria-label={`${jobLabel} 다운로드`} onClick={() => onDownload(job)}>다운로드</Button> : null}
            {(job.status === "failed" || job.status === "expired") ? <Button variant="secondary" aria-label={`${jobLabel} 다시 생성`} disabled={Boolean(retryingReportId)} isLoading={retryingReportId === job.reportId} loadingLabel="다시 생성 중" onClick={() => onRegenerate(job)}>다시 생성</Button> : null}
          </div>
        ) : null}
      </Card>;
    })}
  </section>;
}

function ReportTime({ timestamp }: { timestamp: string }) {
  return <Text as="time" variant="caption" dateTime={timestamp} title={timestamp}>{new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium", timeStyle: "short"
  }).format(new Date(timestamp))}</Text>;
}

function statusPresentation(job: EnergyReportJob) {
  if (job.status === "queued") return { label: "대기 중", tone: "neutral" as const, icon: Clock3 };
  if (job.status === "processing") return { label: `생성 중 ${job.progressPercent}%`, tone: "info" as const, icon: LoaderCircle };
  if (job.status === "completed") return { label: "완료", tone: "success" as const, icon: CheckCircle2 };
  if (job.status === "failed") return { label: "생성 실패", tone: "danger" as const, icon: CircleAlert };
  return { label: "만료됨", tone: "warning" as const, icon: FileWarning };
}

function scopeLabel(scope: EnergyReportJob["request"]["scope"]) {
  return ({ site: "현장", fixture: "조명", floor: "층", group: "그룹" })[scope];
}
