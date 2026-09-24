import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import { CircleAlert, FileWarning, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button, FeedbackState, Text } from "../../../components/ui";
import { ReportJobCards } from "./ReportJobCards";
import { ReportJobTable } from "./ReportJobTable";
import { reportJobViewModel, type ReportJobRenderItem } from "./report-job-view-model";

export function ReportJobList({
  reports,
  timeZone,
  isLoading,
  isError,
  isBusy = false,
  hasRefreshError = false,
  retryingReportId,
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
  retryingReportId?: string;
  onRetry: () => void;
  onRegenerate: (job: EnergyReportJob) => void;
  onDownload: (job: EnergyReportJob) => void;
}) {
  const [expandedFailures, setExpandedFailures] = useState<Record<string, boolean>>({});
  const items: ReportJobRenderItem[] = reports?.map((job) => ({ job, view: reportJobViewModel(job, timeZone) })) ?? [];
  const renderAction = (item: ReportJobRenderItem) => {
    const jobLabel = `${item.view.targetLabel} 보고서`;
    if (item.view.action === "download") {
      return <Button className="min-w-28" variant="primary" aria-label={`${jobLabel} 다운로드`} onClick={() => onDownload(item.job)}>다운로드</Button>;
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

  return <section className="grid min-w-0 gap-3" aria-label="요청한 보고서" aria-busy={isBusy || undefined}>
    {isLoading ? <FeedbackState icon={LoaderCircle} title="보고서 목록을 불러오는 중" /> : null}
    {!isLoading && isError ? <FeedbackState tone="danger" icon={CircleAlert} title="보고서 목록을 불러오지 못했습니다." action={<Button variant="secondary" onClick={onRetry}>다시 시도</Button>} /> : null}
    {hasRefreshError ? <FeedbackState
      tone="danger"
      icon={CircleAlert}
      title="보고서 목록을 새로 불러오지 못했습니다. 기존 결과를 표시합니다."
      action={<Button variant="secondary" onClick={onRetry}>다시 시도</Button>}
    /> : null}
    {!isLoading && !isError && !items.length ? <FeedbackState icon={FileWarning} title="요청한 보고서가 없습니다." description="기간과 범위를 선택해 표준 에너지 사용량 보고서를 요청하세요." /> : null}
    {items.length ? <>
      <Text variant="caption" tone="secondary">시각: {timeZone ? "현장" : "기기"} 시간대 {timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}</Text>
      <ReportJobTable items={items} isBusy={isBusy} renderAction={renderAction} renderFailure={renderFailure} />
      <ReportJobCards items={items} isBusy={isBusy} renderAction={renderAction} renderFailure={renderFailure} />
    </> : null}
  </section>;
}
