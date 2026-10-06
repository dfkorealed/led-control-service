import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import { CircleAlert, FileWarning, LoaderCircle } from "lucide-react";
import { useState, type Ref } from "react";
import { Button, DataGrid, FeedbackState, StatusDetailButton, Text, type DataGridColumn } from "../../../components/ui";
import { ReportJobStatus } from "./ReportJobStatus";
import { reportJobViewModel, type ReportJobRenderItem } from "./report-job-view-model";

export function ReportJobList({
  reports,
  timeZone,
  isLoading,
  isError,
  isBusy = false,
  hasRefreshError = false,
  focusTargetRef,
  retryingReportId,
  downloadingReportId,
  onRetry,
  onRegenerate,
  onDownload
}: {
  reports?: EnergyReportJob[];
  timeZone?: string;
  isLoading: boolean;
  isError: boolean;
  isBusy?: boolean;
  hasRefreshError?: boolean;
  focusTargetRef?: Ref<HTMLElement>;
  retryingReportId?: string;
  downloadingReportId?: string;
  onRetry: (trigger: HTMLButtonElement | null) => void;
  onRegenerate: (job: EnergyReportJob) => void;
  onDownload: (job: EnergyReportJob) => void;
}) {
  const [expandedFailures, setExpandedFailures] = useState<Record<string, boolean>>({});
  const items: ReportJobRenderItem[] = reports?.map((job) => ({ job, view: reportJobViewModel(job, timeZone) })) ?? [];
  const refreshNotice = hasRefreshError ? <StatusDetailButton label="목록 갱신 실패"
    description="보고서 목록을 새로 불러오지 못했습니다. 기존 결과를 표시합니다." variant="danger"
    action={{ label: "다시 시도", onClick: onRetry, isBusy }} /> : null;
  const renderAction = (item: ReportJobRenderItem) => {
    const jobLabel = `${item.view.targetLabel} 보고서`;
    if (item.view.action === "download") {
      return <Button className="min-w-28" variant="primary" aria-label={`${jobLabel} 다운로드`}
        disabled={Boolean(downloadingReportId)} isLoading={downloadingReportId === item.view.id} loadingLabel="파일 준비 중"
        onClick={() => onDownload(item.job)}>다운로드</Button>;
    }
    if (item.view.action === "regenerate") {
      return <Button className="min-w-28" variant="secondary" aria-label={`${jobLabel} 다시 생성`} disabled={Boolean(retryingReportId)} isLoading={retryingReportId === item.view.id} loadingLabel="다시 생성 중" onClick={() => onRegenerate(item.job)}>다시 생성</Button>;
    }
    return null;
  };
  const renderFailure = (item: ReportJobRenderItem, surface: "table" | "card") => {
    if (!item.view.failure) return null;
    const key = `${surface}-${item.view.id}`;
    const panelId = `report-failure-${key}`;
    const isExpanded = Boolean(expandedFailures[key]);
    return <div className="grid min-w-0 gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="w-full justify-start text-left"
        aria-expanded={isExpanded}
        aria-controls={panelId}
        aria-label={`${item.view.targetLabel} 실패 상세 ${isExpanded ? "닫기" : "보기"}`}
        onClick={() => setExpandedFailures((current) => ({ ...current, [key]: !isExpanded }))}
      >
        실패 상세 {isExpanded ? "닫기" : "보기"}
      </Button>
      {isExpanded ? <div id={panelId} role="region" aria-label={`${item.view.targetLabel} 실패 안내`} className="grid min-w-0 gap-1 rounded-control bg-status-danger-background p-3 text-status-danger-foreground wrap-anywhere">
        <Text as="strong" variant="body-sm" weight="bold" tone="danger">{item.view.failure.message}</Text>
        <Text as="span" variant="body-sm" tone="danger">{item.view.failure.action}</Text>
      </div> : null}
    </div>;
  };
  const columns: DataGridColumn<ReportJobRenderItem>[] = [
    { id: "target", header: "대상", minWidth: 180, sortValue: item => item.view.targetLabel, renderCell: item => <Text weight="bold" className="wrap-anywhere">{item.view.targetLabel}</Text> },
    { id: "scope", header: "범위", minWidth: 70, align: "center", sortValue: item => item.view.scopeLabel, renderCell: item => item.view.scopeLabel },
    { id: "range", header: "기간", minWidth: 130, sortValue: item => item.job.request.from, renderCell: item => <span className="flex min-w-0 flex-wrap gap-x-1">
      {/* Calendar dates retain their API values without timezone conversion. */}
      <time dateTime={item.job.request.from} className="tabular-nums">{item.job.request.from}</time><span>~</span>
      <time dateTime={item.job.request.to} className="tabular-nums">{item.job.request.to}</time>
    </span> },
    { id: "status", header: "상태", minWidth: 150, align: "center", sortValue: item => item.view.status.label, renderCell: (item, surface) => <div className="grid min-w-0 justify-items-center gap-2"><ReportJobStatus item={item} />{renderFailure(item, surface)}</div> },
    { id: "requested", header: "요청 시각", minWidth: 140, sortValue: item => new Date(item.job.requestedAt), renderCell: item => <ReportTime instant={item.view.requestedAt} /> },
    { id: "expires", header: "파일 만료 시각", minWidth: 140, sortValue: item => item.job.expiresAt ? new Date(item.job.expiresAt) : null, renderCell: item => item.view.expiresAt ? <ReportTime instant={item.view.expiresAt} /> : "—" },
    { id: "actions", header: "작업", minWidth: 140, align: "center", renderCell: renderAction }
  ];

  return <section ref={focusTargetRef} tabIndex={-1} className="grid min-w-0 gap-3" aria-label="요청한 보고서" aria-busy={isBusy || undefined}>
    {isLoading ? <FeedbackState icon={LoaderCircle} title="보고서 목록을 불러오는 중" /> : null}
    {!isLoading && isError ? <FeedbackState tone="danger" icon={CircleAlert} title="보고서 목록을 불러오지 못했습니다." action={<Button variant="secondary" onClick={() => onRetry(null)}>다시 시도</Button>} /> : null}
    {!isLoading && !isError && !items.length ? <FeedbackState icon={FileWarning} title="요청한 보고서가 없습니다."
      aria-label="보고서 빈 목록" description="기간과 범위를 선택해 표준 에너지 사용량 보고서를 요청하세요."
      action={refreshNotice} /> : null}
    {items.length ? <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Text variant="caption" tone="secondary">시각: {timeZone ? "현장" : "기기"} 시간대 {timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}</Text>
      {refreshNotice}
    </div> : null}
    {items.length ? <DataGrid caption="보고서 생성 이력" rows={items} columns={columns} getRowKey={item => item.view.id} isBusy={isBusy} variant="compact" /> : null}
  </section>;
}

function ReportTime({ instant }: { instant: ReportJobRenderItem["view"]["requestedAt"] }) {
  return <time dateTime={instant.iso} title={instant.iso} className="tabular-nums wrap-anywhere">{instant.label}</time>;
}
