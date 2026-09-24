import type { EnergyReportJob, EnergyReportListResponse, EnergyReportRequest } from "@led-control/shared/energy-p2-contracts";
import { FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEnergyReport, downloadEnergyCsv, downloadEnergyReport, energyReportRequestErrorMessage, useEnergyReports, useEnergyReportTargets } from "../../../api/energy";
import { Button, PageHeader, PaginationBar, Text, type PaginationPageSize } from "../../../components/ui";
import { useLocation, useOutletContext, useSearchParams } from "react-router-dom";
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
const reportHistoryStateKey = "statisticsReportHistory";
const legacyReportLocationParams = ["cursor", "reportCursor", "reportPage", "reportHistory", "reportSite"] as const;

interface RetainedReportPage {
  scopeKey: string;
  data: EnergyReportListResponse;
  pageState: ReportCursorPageState;
}

export function StatisticsReportsPage() {
  const { siteId } = useOutletContext<StatisticsOutletContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const searchKey = searchParams.toString();
  const reportLocation = useMemo(
    () => readReportLocation(searchParams, location.state, siteId),
    [location.state, searchKey, siteId]
  );
  const filters = reportLocation.filters;
  const activePageState = reportLocation.pageState;
  const [isForwardPending, setIsForwardPending] = useState(false);
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
  const retainedPageRef = useRef<RetainedReportPage>();
  const refreshErrorScopeRef = useRef<string>();
  const reportListRef = useRef<HTMLElement>(null);
  const retryFocusKeyRef = useRef<string>();
  const retryFocusOriginRef = useRef<HTMLButtonElement>();
  const retryObservedFetchingRef = useRef(false);
  const retryRequestKeyRef = useRef<string>();
  const siteIdRef = useRef(siteId);
  siteIdRef.current = siteId;
  const scopeKey = reportScopeKey(siteId, filters);

  useEffect(() => {
    if (!reportLocation.needsNormalization) return;
    setSearchParams(writeReportLocation(reportLocation.filters, siteId), {
      replace: true,
      state: writeReportLocationState(location.state, siteId, reportLocation.filters, firstReportPage)
    });
  }, [location.key, reportLocation.needsNormalization, searchKey, setSearchParams, siteId]);

  useEffect(() => {
    if (!reports.isFetching && !reports.isPlaceholderData) setIsForwardPending(false);
  }, [reports.isFetching, reports.isPlaceholderData, activePageState.currentCursor]);

  const currentPage = reports.data && !reports.isError && !reports.isPlaceholderData
    ? { scopeKey, data: reports.data, pageState: activePageState }
    : undefined;
  if (currentPage) retainedPageRef.current = currentPage;
  const retainedPageForScope = retainedPageRef.current?.scopeKey === scopeKey ? retainedPageRef.current : undefined;
  const displayedPage = currentPage ?? retainedPageForScope;
  if (currentPage || refreshErrorScopeRef.current !== scopeKey) refreshErrorScopeRef.current = undefined;
  if (reports.isError && retainedPageForScope) refreshErrorScopeRef.current = scopeKey;
  // Keep the recovery control mounted while its retry is pending, so focus can
  // return to the same trigger even when the retry fails again.
  const hasRefreshError = Boolean(retainedPageForScope && refreshErrorScopeRef.current === scopeKey);
  const requestKey = JSON.stringify([scopeKey, activePageState.currentCursor ?? null]);

  useEffect(() => {
    if (!retryFocusKeyRef.current) return;
    if (retryFocusKeyRef.current !== requestKey) {
      retryFocusKeyRef.current = undefined;
      retryFocusOriginRef.current = undefined;
      retryObservedFetchingRef.current = false;
      return;
    }
    if (reports.isFetching) {
      retryObservedFetchingRef.current = true;
      return;
    }
    if (hasRefreshError) {
      if (reports.isError && retryObservedFetchingRef.current) {
        retryFocusKeyRef.current = undefined;
        retryFocusOriginRef.current = undefined;
      }
      retryObservedFetchingRef.current = false;
      return;
    }
    const origin = retryFocusOriginRef.current;
    const active = document.activeElement;
    // Recover focus only if the retry's own trigger still owns it, or if
    // removing that trigger left the browser focus on the document body.
    const shouldRestoreFocus = Boolean(origin && (active === origin || (active === document.body && !origin.isConnected)));
    retryFocusKeyRef.current = undefined;
    retryFocusOriginRef.current = undefined;
    retryObservedFetchingRef.current = false;
    if (currentPage && shouldRestoreFocus) reportListRef.current?.focus();
  }, [currentPage, hasRefreshError, reports.isError, reports.isFetching, requestKey]);

  function retryList(trigger: HTMLButtonElement | null) {
    if (reports.isFetching || retryRequestKeyRef.current === requestKey) return;
    retryRequestKeyRef.current = requestKey;
    retryFocusKeyRef.current = requestKey;
    retryFocusOriginRef.current = trigger ?? undefined;
    retryObservedFetchingRef.current = false;
    Promise.resolve(reports.refetch()).then((result) => {
      if (result?.isError && retryFocusKeyRef.current === requestKey) {
        retryFocusKeyRef.current = undefined;
        retryFocusOriginRef.current = undefined;
      }
      if (retryRequestKeyRef.current === requestKey) retryRequestKeyRef.current = undefined;
    }, () => {
      if (retryFocusKeyRef.current === requestKey) {
        retryFocusKeyRef.current = undefined;
        retryFocusOriginRef.current = undefined;
      }
      if (retryRequestKeyRef.current === requestKey) retryRequestKeyRef.current = undefined;
    });
  }

  function syncLocation(nextFilters: ReportHistoryFilterState, nextPageState: ReportCursorPageState, replace = false) {
    setSearchParams(writeReportLocation(nextFilters, siteId), {
      replace,
      state: writeReportLocationState(location.state, siteId, nextFilters, nextPageState)
    });
  }

  function resetToFirstPage(nextFilters: ReportHistoryFilterState) {
    const normalized = withoutCursor(nextFilters);
    setIsForwardPending(false);
    syncLocation(normalized, firstReportPage);
  }

  function nextPage() {
    const nextCursor = currentPage?.data.nextCursor;
    const nextPageNumber = activePageState.page + 1;
    if (isForwardPending
      || reports.isFetching
      || reports.isPlaceholderData
      || reports.isError
      || !validNextPageCursor(nextCursor, activePageState)
      || !Number.isSafeInteger(nextPageNumber)) return;
    const nextPageState: ReportCursorPageState = {
      page: nextPageNumber,
      currentCursor: nextCursor,
      previousCursors: [...activePageState.previousCursors, activePageState.currentCursor]
    };
    setIsForwardPending(true);
    syncLocation(filters, nextPageState);
  }

  function previousPage() {
    if (!activePageState.previousCursors.length) return;
    const previousCursor = activePageState.previousCursors.at(-1);
    const previousPageState: ReportCursorPageState = {
      page: Math.max(1, activePageState.page - 1),
      currentCursor: previousCursor,
      previousCursors: activePageState.previousCursors.slice(0, -1)
    };
    setIsForwardPending(false);
    syncLocation(filters, previousPageState);
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
    <ReportHistoryFilters value={filters} onChange={resetToFirstPage} />
    <ReportJobList reports={displayedPage?.data.reports} timeZone={targets.data?.timeZone} focusTargetRef={reportListRef}
      isLoading={(reports.isLoading || reports.isPlaceholderData || !siteId) && !displayedPage}
      isError={Boolean(reports.isError && !displayedPage)} hasRefreshError={hasRefreshError}
      isBusy={reports.isFetching}
      retryingReportId={retryingReportId} onRetry={retryList} onRegenerate={(job) => void regenerate(job)} onDownload={(job) => void download(job)} />
    <PaginationBar
      page={displayedPage?.pageState.page ?? activePageState.page}
      pageSize={filters.limit}
      totalCount={displayedPage?.data.totalCount ?? 0}
      hasPrevious={activePageState.previousCursors.length > 0}
      hasNext={!reports.isError
        && !isForwardPending
        && !reports.isFetching
        && !reports.isPlaceholderData
        && Number.isSafeInteger(activePageState.page + 1)
        && validNextPageCursor(currentPage?.data.nextCursor, activePageState)}
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

function readReportLocation(params: URLSearchParams, state: unknown, siteId: string | undefined): {
  filters: ReportHistoryFilterState;
  pageState: ReportCursorPageState;
  needsNormalization: boolean;
} {
  const filterParams = new URLSearchParams(params);
  const hasLegacyPageState = legacyReportLocationParams.some((key) => filterParams.has(key));
  for (const key of legacyReportLocationParams) filterParams.delete(key);
  const filters = withoutCursor(parseReportHistorySearchParams(filterParams));
  const storedPageState = hasLegacyPageState ? null : readReportLocationState(state, siteId, filters);
  return {
    filters,
    pageState: storedPageState ?? firstReportPage,
    needsNormalization: hasLegacyPageState || storedPageState === null
  };
}

function writeReportLocation(filters: ReportHistoryFilterState, siteId: string | undefined) {
  const params = serializeReportHistorySearchParams(withoutCursor(filters));
  // Report controls own their query params, but the shell still derives the
  // selected tenant site from this shared parameter across navigation updates.
  if (siteId) params.set("siteId", siteId);
  return params;
}

function writeReportLocationState(
  state: unknown,
  siteId: string | undefined,
  filters: ReportHistoryFilterState,
  pageState: ReportCursorPageState
) {
  const existing = isRecord(state) ? state : {};
  return {
    ...existing,
    [reportHistoryStateKey]: {
      version: 1,
      siteId: siteId ?? null,
      filterFingerprint: reportFilterFingerprint(filters),
      page: pageState.page,
      currentCursor: pageState.currentCursor ?? null,
      previousCursors: pageState.previousCursors.map((cursor) => cursor ?? null)
    }
  };
}

function readReportLocationState(
  state: unknown,
  siteId: string | undefined,
  filters: ReportHistoryFilterState
): ReportCursorPageState | null {
  if (!isRecord(state)) return null;
  const candidate = state[reportHistoryStateKey];
  if (!isRecord(candidate)
    || candidate.version !== 1
    || candidate.siteId !== (siteId ?? null)
    || candidate.filterFingerprint !== reportFilterFingerprint(filters)
    || !Number.isSafeInteger(candidate.page)
    || (candidate.page as number) < 1
    || !Array.isArray(candidate.previousCursors)) return null;

  const page = candidate.page as number;
  const previousCursors = candidate.previousCursors;
  if (!hasDenseOwnElements(previousCursors)) return null;
  if (page === 1) {
    return candidate.currentCursor === null && previousCursors.length === 0 ? firstReportPage : null;
  }
  if (!validCursor(candidate.currentCursor)
    || previousCursors.length !== page - 1
    || previousCursors[0] !== null) return null;
  const opaquePreviousCursors = previousCursors.slice(1);
  if (!opaquePreviousCursors.every(validCursor)) return null;
  const uniqueCursors = new Set([...opaquePreviousCursors, candidate.currentCursor]);
  if (uniqueCursors.size !== opaquePreviousCursors.length + 1) return null;
  return {
    page,
    currentCursor: candidate.currentCursor,
    previousCursors: [undefined, ...(opaquePreviousCursors as string[])]
  };
}

function reportScopeKey(siteId: string | undefined, filters: ReportHistoryFilterState) {
  return `${siteId ?? ""}|${reportFilterFingerprint(filters)}`;
}

function reportFilterFingerprint(filters: ReportHistoryFilterState) {
  return serializeReportHistorySearchParams(withoutCursor(filters)).toString();
}

function validCursor(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 1_024;
}

function hasDenseOwnElements(values: unknown[]) {
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(values, index)) return false;
  }
  return true;
}

function validNextPageCursor(value: unknown, pageState: ReportCursorPageState): value is string {
  return validCursor(value)
    && value !== pageState.currentCursor
    && !pageState.previousCursors.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
