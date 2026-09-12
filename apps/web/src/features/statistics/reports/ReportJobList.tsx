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
      return <Card key={job.reportId} className="statistics-report-job">
        <div className="statistics-report-job-copy"><div><strong>{scopeLabel(job.request.scope)} 보고서</strong><span>{job.request.from} ~ {job.request.to}</span></div><StatusBadge tone={state.tone} icon={state.icon}>{state.label}</StatusBadge></div>
        <div className="statistics-report-job-meta"><span>{job.request.format.toUpperCase()}</span><span>{scopeLabel(job.request.scope)}</span>{job.status === "processing" ? <span>{job.progressPercent}%</span> : null}</div>
        {job.status === "completed" ? <Button variant="primary" onClick={() => onDownload(job)}>다운로드</Button> : null}
        {(job.status === "failed" || job.status === "expired") ? <Button variant="secondary" disabled={Boolean(retryingReportId)} isLoading={retryingReportId === job.reportId} loadingLabel="다시 생성 중" onClick={() => onRegenerate(job)}>다시 생성</Button> : null}
      </Card>;
    })}
  </section>;
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
