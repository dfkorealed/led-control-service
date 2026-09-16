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

const firstReportPage: ReportCursorPageState = { page: 1, currentCursor: undefined, previousCursors: [] };
const reportPageParam = "reportPage";
const reportHistoryParam = "reportHistory";
const reportSiteParam = "reportSite";

export function StatisticsReportsPage() {
  const { siteId } = useOutletContext<StatisticsOutletContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const initialLocation = useRef(readReportLocation(searchParams, siteId));
  const [filters, setFilters] = useState<ReportHistoryFilterState>(initialLocation.current.filters);
  const [pageState, setPageState] = useState<ReportCursorPageState>(initialLocation.current.pageState);
  const [isForwardPending, setIsForwardPending] = useState(false);
  const pageSiteId = useRef(siteId);
  const isSiteTransition = pageSiteId.current !== siteId;
  const activePageState = isSiteTransition ? firstReportPage : pageState;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const query = activePageState.currentCursor ? { ...filters, cursor: activePageState.currentCursor } : filters;
  const targets = useEnergyReportTargets(siteId);
  const reports = useEnergyReports(siteId, query);
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [retryError, setRetryError] = useState("");
  const [retryingReportId, setRetryingReportId] = useState<string>();
  const siteIdRef = useRef(siteId);
  siteIdRef.current = siteId;

  useEffect(() => {
    const location = readReportLocation(new URLSearchParams(searchKey), siteId);
    setFilters(location.filters);
    setPageState(location.pageState);
    if (location.needsNormalization) {
      setSearchParams(writeReportLocation(location.filters, firstReportPage, siteId), { replace: true });
    }
  }, [searchKey, setSearchParams]);

  useEffect(() => {
    if (!reports.isFetching && !reports.isPlaceholderData) setIsForwardPending(false);
  }, [reports.isFetching, reports.isPlaceholderData, pageState.currentCursor]);

  useEffect(() => {
    if (pageSiteId.current === siteId) return;
    pageSiteId.current = siteId;
    resetToFirstPage(filtersRef.current);
  }, [siteId]);

  function syncUrl(nextFilters: ReportHistoryFilterState, nextPageState: ReportCursorPageState, replace = false) {
    setSearchParams(writeReportLocation(nextFilters, nextPageState, siteId), { replace });
  }

  function resetToFirstPage(nextFilters: ReportHistoryFilterState) {
    const normalized = withoutCursor(nextFilters);
    setFilters(normalized);
    setPageState(firstReportPage);
    setIsForwardPending(false);
    syncUrl(normalized, firstReportPage);
  }

  function nextPage() {
    const nextCursor = reports.data?.nextCursor;
    if (isSiteTransition || isForwardPending || reports.isFetching || reports.isPlaceholderData || !nextCursor) return;
    const nextPageState: ReportCursorPageState = {
      page: activePageState.page + 1,
      currentCursor: nextCursor,
      previousCursors: [...activePageState.previousCursors, activePageState.currentCursor]
    };
    setIsForwardPending(true);
    setPageState(nextPageState);
    syncUrl(filters, nextPageState);
  }

  function previousPage() {
    if (isSiteTransition || !activePageState.previousCursors.length) return;
    const previousCursor = activePageState.previousCursors.at(-1);
    const previousPageState: ReportCursorPageState = {
      page: Math.max(1, activePageState.page - 1),
      currentCursor: previousCursor,
      previousCursors: activePageState.previousCursors.slice(0, -1)
    };
    setIsForwardPending(false);
    setPageState(previousPageState);
    syncUrl(filters, previousPageState);
  }

  async function create(request: EnergyReportRequest) {
    if (!siteId) return;
    const requestSiteId = siteId;
    await createEnergyReport(requestSiteId, request);
    const invalidation = queryClient.invalidateQueries({ queryKey: ["energy-reports", requestSiteId] });
    if (siteIdRef.current === requestSiteId) resetToFirstPage(filtersRef.current);
    await invalidation;
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
      page={activePageState.page}
      pageSize={filters.limit}
      totalCount={reports.data?.totalCount ?? 0}
      hasPrevious={!isSiteTransition && activePageState.previousCursors.length > 0}
      hasNext={!isSiteTransition && !isForwardPending && !reports.isFetching && !reports.isPlaceholderData && Boolean(reports.data?.nextCursor)}
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

function readReportLocation(params: URLSearchParams, siteId: string | undefined): {
  filters: ReportHistoryFilterState;
  pageState: ReportCursorPageState;
  needsNormalization: boolean;
} {
  const query = parseReportHistorySearchParams(params);
  const filters = withoutCursor(query);
  const page = Number(params.get(reportPageParam));
  const previousCursors = readCursorHistory(params.get(reportHistoryParam));
  const metadataSiteId = params.get(reportSiteParam);
  const hasPageMetadata = params.has(reportPageParam) || params.has(reportHistoryParam) || params.has(reportSiteParam);
  if (query.cursor && Number.isInteger(page) && page >= 2 && page <= 1_000
    && previousCursors && previousCursors.length === page - 1 && metadataSiteId === siteId) {
    return {
      filters,
      pageState: { page, currentCursor: query.cursor, previousCursors },
      needsNormalization: false
    };
  }
  return {
    filters,
    pageState: firstReportPage,
    needsNormalization: Boolean(query.cursor) || hasPageMetadata
  };
}

function writeReportLocation(filters: ReportHistoryFilterState, pageState: ReportCursorPageState, siteId: string | undefined) {
  const params = serializeReportHistorySearchParams(pageState.currentCursor
    ? { ...withoutCursor(filters), cursor: pageState.currentCursor }
    : withoutCursor(filters));
  if (pageState.currentCursor) {
    params.set(reportPageParam, String(pageState.page));
    params.set(reportHistoryParam, JSON.stringify(pageState.previousCursors.map((cursor) => cursor ?? null)));
    if (siteId) params.set(reportSiteParam, siteId);
  }
  return params;
}

function readCursorHistory(raw: string | null): Array<string | undefined> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 999
      || !value.every((cursor) => cursor === null || typeof cursor === "string" && cursor.length >= 1 && cursor.length <= 1_024)) {
      return null;
    }
    return value.map((cursor) => cursor === null ? undefined : cursor as string);
  } catch {
    return null;
  }
}
