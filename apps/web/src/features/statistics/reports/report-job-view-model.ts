import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import type { StatusTone } from "../../../components/ui";

export interface FormattedInstant {
  iso: string;
  label: string;
}

export interface ReportJobViewModel {
  id: string;
  targetLabel: string;
  scopeLabel: string;
  rangeLabel: string;
  formatLabel: "PDF" | "XLSX";
  status: { label: string; tone: StatusTone; progress?: number };
  requestedAt: FormattedInstant;
  expiresAt?: FormattedInstant;
  action: "download" | "regenerate" | "none";
  failure?: { message: string; action: string };
}

export interface ReportJobRenderItem {
  job: EnergyReportJob;
  view: ReportJobViewModel;
}

export function reportJobViewModel(job: EnergyReportJob, timeZone?: string): ReportJobViewModel {
  return {
    id: job.reportId,
    targetLabel: job.target.label,
    scopeLabel: scopeLabel(job.request.scope),
    rangeLabel: `${job.request.from} ~ ${job.request.to}`,
    formatLabel: job.request.format === "pdf" ? "PDF" : "XLSX",
    status: reportStatus(job),
    requestedAt: formatInstant(job.requestedAt, timeZone),
    ...(job.expiresAt ? { expiresAt: formatInstant(job.expiresAt, timeZone) } : {}),
    action: job.status === "completed"
      ? "download"
      : job.status === "failed" || job.status === "expired" ? "regenerate" : "none",
    ...(job.status === "failed" && job.failure
      ? { failure: { message: job.failure.message, action: job.failure.action } }
      : {})
  };
}

function reportStatus(job: EnergyReportJob): ReportJobViewModel["status"] {
  if (job.status === "queued") return { label: "대기 중", tone: "neutral" };
  if (job.status === "processing") {
    return { label: `생성 중 ${job.progressPercent}%`, tone: "info", progress: job.progressPercent };
  }
  if (job.status === "completed") return { label: "완료", tone: "success" };
  if (job.status === "failed") return { label: "생성 실패", tone: "danger" };
  return { label: "만료됨", tone: "warning" };
}

function scopeLabel(scope: EnergyReportJob["request"]["scope"]) {
  return ({ site: "현장", fixture: "조명", floor: "층", group: "그룹" })[scope];
}

function formatInstant(iso: string, timeZone?: string): FormattedInstant {
  return {
    iso,
    label: new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso))
  };
}
