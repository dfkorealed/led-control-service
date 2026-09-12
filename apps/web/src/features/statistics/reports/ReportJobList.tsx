import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import { CheckCircle2, CircleAlert, Clock3, FileWarning, LoaderCircle } from "lucide-react";
import { Button, Card, FeedbackState, StatusBadge } from "../../../components/ui";

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

  return <section className="statistics-report-list" aria-label="요청한 보고서">
    {reports.map((job) => {
      const state = statusPresentation(job);
      const jobLabel = `${job.target.label} 보고서`;
      return <Card key={job.reportId} className="statistics-report-job" role="article" aria-label={jobLabel}>
        <div className="statistics-report-job-copy"><div><strong>{job.target.label}</strong><span>{scopeLabel(job.request.scope)} 보고서 · {job.request.from} ~ {job.request.to}</span></div><StatusBadge tone={state.tone} icon={state.icon}>{state.label}</StatusBadge></div>
        <dl className="statistics-report-job-meta" role="group" aria-label="보고서 메타데이터">
          <div><dt>형식</dt><dd>{job.request.format.toUpperCase()}</dd></div>
          <div><dt>범위</dt><dd>{scopeLabel(job.request.scope)}</dd></div>
          <div><dt>요청 시각</dt><dd><ReportTime timestamp={job.requestedAt} /></dd></div>
          {job.expiresAt ? <div><dt>파일 만료 시각</dt><dd><ReportTime timestamp={job.expiresAt} /></dd></div> : null}
          {job.status === "processing" ? <div><dt>진행률</dt><dd>{job.progressPercent}%</dd></div> : null}
        </dl>
        {job.status === "failed" && job.failure ? (
          <div className="statistics-report-job-failure" role="region" aria-label={`${job.target.label} 실패 안내`}>
            <strong>{job.failure.message}</strong><span>{job.failure.action}</span>
          </div>
        ) : null}
        {(job.status === "completed" || job.status === "failed" || job.status === "expired") ? (
          <div className="statistics-report-job-actions" role="group" aria-label="보고서 작업">
            {job.status === "completed" ? <Button variant="primary" aria-label={`${jobLabel} 다운로드`} onClick={() => onDownload(job)}>다운로드</Button> : null}
            {(job.status === "failed" || job.status === "expired") ? <Button variant="secondary" aria-label={`${jobLabel} 다시 생성`} disabled={Boolean(retryingReportId)} isLoading={retryingReportId === job.reportId} loadingLabel="다시 생성 중" onClick={() => onRegenerate(job)}>다시 생성</Button> : null}
          </div>
        ) : null}
      </Card>;
    })}
  </section>;
}

function ReportTime({ timestamp }: { timestamp: string }) {
  return <time dateTime={timestamp} title={timestamp}>{new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium", timeStyle: "short"
  }).format(new Date(timestamp))}</time>;
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
