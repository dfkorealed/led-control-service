import type { EnergyReportJob, EnergyReportRequest } from "@led-control/shared/energy-p2-contracts";
import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEnergyReport, downloadEnergyCsv, downloadEnergyReport, energyReportRequestErrorMessage, useEnergyReports, useEnergyReportTargets } from "../../../api/energy";
import { Button, PageHeader, PaginationBar, Text, type PaginationPageSize } from "../../../components/ui";
import { useOutletContext, useSearchParams } from "react-router-dom";
import type { StatisticsOutletContext } from "../StatisticsShell";
import { ReportCreateDialog } from "./ReportCreateDialog";
import { ReportHistoryFilters } from "./ReportHistoryFilters";
import { ReportJobList } from "./ReportJobList";
import { parseReportHistorySearchParams, serializeReportHistorySearchParams, type ReportHistoryFilterState } from "./report-history-filters";

interface ReportCursorPageState {
  page: number;
  currentCursor?: string;
  previousCursors: Array<string | undefined>;
}

export function StatisticsReportsPage() {
  const { siteId } = useOutletContext<StatisticsOutletContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = useRef(parseReportHistorySearchParams(searchParams));
  const [filters, setFilters] = useState<ReportHistoryFilterState>(() => withoutCursor(initialQuery.current));
  const [pageState, setPageState] = useState<ReportCursorPageState>({
    page: 1,
    currentCursor: initialQuery.current.cursor,
    previousCursors: []
  });
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const query = pageState.currentCursor ? { ...filters, cursor: pageState.currentCursor } : filters;
  const targets = useEnergyReportTargets(siteId);
  const reports = useEnergyReports(siteId, query);
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [retryError, setRetryError] = useState("");
  const [retryingReportId, setRetryingReportId] = useState<string>();
  const previousSiteId = useRef(siteId);

  useEffect(() => {
    if (previousSiteId.current === siteId) return;
    previousSiteId.current = siteId;
    resetToFirstPage(filtersRef.current);
  }, [siteId]);

  function syncUrl(nextFilters: ReportHistoryFilterState, cursor?: string) {
    setSearchParams(serializeReportHistorySearchParams(cursor ? { ...nextFilters, cursor } : nextFilters));
  }

  function resetToFirstPage(nextFilters: ReportHistoryFilterState) {
    const normalized = withoutCursor(nextFilters);
    setFilters(normalized);
    setPageState({ page: 1, currentCursor: undefined, previousCursors: [] });
    syncUrl(normalized);
  }

  function nextPage() {
    const nextCursor = reports.data?.nextCursor;
    if (!nextCursor) return;
    setPageState((current) => ({
      page: current.page + 1,
      currentCursor: nextCursor,
      previousCursors: [...current.previousCursors, current.currentCursor]
    }));
    syncUrl(filters, nextCursor);
  }

  function previousPage() {
    if (!pageState.previousCursors.length) return;
    const previousCursor = pageState.previousCursors.at(-1);
    setPageState((current) => ({
      page: Math.max(1, current.page - 1),
      currentCursor: previousCursor,
      previousCursors: current.previousCursors.slice(0, -1)
    }));
    syncUrl(filters, previousCursor);
  }

  async function create(request: EnergyReportRequest) {
    if (!siteId) return;
    await createEnergyReport(siteId, request);
    resetToFirstPage(filters);
    await queryClient.invalidateQueries({ queryKey: ["energy-reports", siteId] });
  }
  async function download(job: EnergyReportJob) {
    if (!siteId) return;
    setDownloadError("");
    try {
      const response = await downloadEnergyReport(siteId, job.reportId);
      const anchor = document.createElement("a");
      anchor.href = response.downloadUrl;
      anchor.download = "";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      setDownloadError(energyReportRequestErrorMessage(error, "download"));
    }
  }
  async function regenerate(job: EnergyReportJob) {
    if (retryingReportId || !siteId) return;
    setRetryError("");
    setRetryingReportId(job.reportId);
    try {
      await create(job.request);
    } catch (error) {
      setRetryError(energyReportRequestErrorMessage(error, "regenerate"));
    } finally {
      setRetryingReportId(undefined);
    }
  }

  return <section className="grid min-w-0 gap-6" aria-label="에너지 보고서">
    <PageHeader title="보고서" description="현장 에너지 사용량을 기간과 범위에 맞춰 내보냅니다." status={undefined}
      actions={<Button variant="primary" onClick={() => setIsDialogOpen(true)}><FileText size={16} />보고서 만들기</Button>} />
    <Text variant="body-sm" tone="muted">보고서와 CSV 비용은 당시 적용 단가의 저장 비용입니다.</Text>
    <ReportHistoryFilters value={query} onChange={resetToFirstPage} />
    <ReportJobList reports={reports.data?.reports} isLoading={reports.isLoading || !siteId} isError={reports.isError}
      isBusy={reports.isFetching}
      retryingReportId={retryingReportId} onRetry={() => void reports.refetch()} onRegenerate={(job) => void regenerate(job)} onDownload={(job) => void download(job)} />
    <PaginationBar
      page={pageState.page}
      pageSize={filters.limit}
      totalCount={reports.data?.totalCount ?? 0}
      hasPrevious={pageState.previousCursors.length > 0}
      hasNext={Boolean(reports.data?.nextCursor)}
      onPrevious={previousPage}
      onNext={nextPage}
      onPageSizeChange={(limit: PaginationPageSize) => resetToFirstPage({ ...filters, limit })}
    />
    {downloadError ? <Text tone="danger" role="alert">{downloadError}</Text> : null}
    {retryError ? <Text tone="danger" role="alert">{retryError}</Text> : null}
    {isDialogOpen && siteId ? <ReportCreateDialog key={siteId} siteId={siteId} targetData={targets.data} onClose={() => setIsDialogOpen(false)}
      isTargetsLoading={targets.isLoading} isTargetsError={targets.isError} onCreate={create} onExportCsv={(request) => downloadEnergyCsv(siteId, request)} /> : null}
  </section>;
}

function withoutCursor(value: ReportHistoryFilterState): ReportHistoryFilterState {
  const { cursor: _cursor, ...filters } = value;
  return filters;
}
