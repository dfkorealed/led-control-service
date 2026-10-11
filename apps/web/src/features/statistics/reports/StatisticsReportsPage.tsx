import { energyReportListQuerySchema, type EnergyReportJob, type EnergyReportListResponse, type EnergyReportRequest } from "@led-control/shared/energy-p2-contracts";
import { Download, FileText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEnergyFileOperation, createEnergyReport, downloadEnergyCsv, downloadEnergyReport, energyReportRequestErrorMessage, useEnergyReports, useEnergyReportTargets } from "../../../api/energy";
import { Button, PageHeader, PaginationBar, Text } from "../../../components/ui";
import { useLocation, useOutletContext, useSearchParams } from "react-router-dom";
import type { StatisticsOutletContext } from "../StatisticsShell";
import { ReportCreateDialog } from "./ReportCreateDialog";
import { downloadMobileAwareUrl, MobileFileExportError } from "../../mobile/file-download";
import { ReportHistoryFilters, type InvalidRequestedRange, type ReportFilterIntent } from "./ReportHistoryFilters";
import { ReportJobList } from "./ReportJobList";
import { parseReportHistorySearchParams, serializeReportHistorySearchParams, type ReportHistoryFilterState } from "./report-history-filters";

interface ReportCursorPageState {
  page: number;
  currentCursor?: string;
  previousCursors: Array<string | undefined>;
}

const firstReportPage: ReportCursorPageState = { page: 1, currentCursor: undefined, previousCursors: [] };
const reportHistoryStateKey = "statisticsReportHistory";
const legacyReportLocationParams = ["cursor", "reportCursor", "reportPage", "reportHistory", "reportSite", "format"] as const;

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
  const invalidRequestedRange = reportLocation.invalidRequestedRange;
  const draftScope = `${siteId ?? ""}|${location.key}|${searchKey}`;
  const [storedInvalidFilters, setStoredInvalidFilters] = useState({ scope: draftScope, filters: reportLocation.filters });
  let invalidFilters = storedInvalidFilters;
  if (invalidFilters.scope !== draftScope) {
    invalidFilters = { scope: draftScope, filters: reportLocation.filters };
    setStoredInvalidFilters(invalidFilters);
  }
  const filters = invalidRequestedRange ? invalidFilters.filters : reportLocation.filters;
  const draftEpochRef = useRef({ scope: draftScope, epoch: {} });
  if (draftEpochRef.current.scope !== draftScope) draftEpochRef.current = { scope: draftScope, epoch: {} };
  const draftEpoch = draftEpochRef.current.epoch;
  const [localDraft, setLocalDraft] = useState({ epoch: draftEpoch, invalid: false });
  const localInvalid = localDraft.epoch === draftEpoch && localDraft.invalid;
  const historyBlocked = Boolean(invalidRequestedRange) || localInvalid;
  const invalidHistoryRef = useRef(historyBlocked);
  invalidHistoryRef.current = historyBlocked;
  const onInvalidDraftChange = useCallback((invalid: boolean) => {
    // An old A callback cannot acquire the later A visit's ownership.
    if (draftEpochRef.current.epoch !== draftEpoch) return;
    invalidHistoryRef.current = Boolean(invalidRequestedRange) || invalid;
    setLocalDraft(current => current.epoch === draftEpoch && current.invalid === invalid ? current : { epoch: draftEpoch, invalid });
  }, [draftEpoch, invalidRequestedRange]);
  const activePageState = reportLocation.pageState;
  const [isForwardPending, setIsForwardPending] = useState(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const query = activePageState.currentCursor ? { ...filters, cursor: activePageState.currentCursor } : filters;
  const targets = useEnergyReportTargets(siteId);
  // Keep the existing hook/schema strict. An invalid URL has no executable
  // history query; the validated placeholder is never displayed or refetched.
  const reports = useEnergyReports(historyBlocked ? undefined : siteId, query);
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [fileNotice, setFileNotice] = useState("");
  const [downloadingReportId, setDownloadingReportId] = useState<string>();
  const downloadOperationRef = useRef<AbortController | null>(null);
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
    setDownloadError("");
    setFileNotice("");
    setDownloadingReportId(undefined);
    // A late file response belongs to the old site/document, never the new page.
    return () => { downloadOperationRef.current?.abort(); downloadOperationRef.current = null; };
  }, [siteId]);

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

  if (invalidRequestedRange) retainedPageRef.current = undefined;
  const currentPage = !historyBlocked && reports.data && !reports.isError && !reports.isPlaceholderData
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
    if (draftEpochRef.current.epoch !== draftEpoch || invalidHistoryRef.current || reports.isFetching || retryRequestKeyRef.current === requestKey) return;
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
    if (invalidHistoryRef.current) return;
    const normalized = withoutCursor(nextFilters);
    setIsForwardPending(false);
    syncLocation(normalized, firstReportPage);
  }

  function changeFilters(nextFilters: ReportHistoryFilterState, intent: ReportFilterIntent = "filter") {
    if (draftEpochRef.current.epoch !== draftEpoch) return;
    if (!invalidRequestedRange) {
      if (intent === "dates" || intent === "reset") {
        setIsForwardPending(false);
        syncLocation(withoutCursor(nextFilters), firstReportPage);
      } else resetToFirstPage(nextFilters);
      return;
    }
    if (storedInvalidFilters.scope !== draftScope) return;
    if (intent === "dates" || intent === "reset") {
      setIsForwardPending(false);
      syncLocation(withoutCursor(nextFilters), firstReportPage);
    } else {
      // Search still debounces and other controls remain editable, but no raw
      // invalid date is silently removed from the URL by an unrelated change.
      setStoredInvalidFilters(current => current.scope === draftScope ? { ...current, filters: nextFilters } : current);
    }
  }

  function nextPage() {
    if (draftEpochRef.current.epoch !== draftEpoch || invalidHistoryRef.current) return;
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
    if (draftEpochRef.current.epoch !== draftEpoch || invalidHistoryRef.current) return;
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
    if (siteIdRef.current === requestSiteId && !invalidHistoryRef.current) resetToFirstPage(filtersRef.current);
    await invalidation;
  }
  async function download(job: EnergyReportJob) {
    if (invalidHistoryRef.current || !siteId || downloadOperationRef.current) return;
    const requestSiteId = siteId;
    const operation = new AbortController();
    downloadOperationRef.current = operation;
    const isCurrent = () => downloadOperationRef.current === operation && siteIdRef.current === requestSiteId;
    setDownloadError("");
    setFileNotice("");
    setDownloadingReportId(job.reportId);
    let scope: ReturnType<typeof createEnergyFileOperation> | undefined;
    try {
      scope = createEnergyFileOperation(operation.signal);
      const response = await downloadEnergyReport(requestSiteId, job.reportId, { signal: scope.signal });
      if (!isCurrent()) return;
      scope.assertCurrent();
      if (operation.signal.aborted) { setFileNotice("파일 공유를 취소했습니다."); return; }
      const outcome = await downloadMobileAwareUrl({ url: response.downloadUrl,
        fileName: `energy-report_${job.request.from}_${job.request.to}_${job.reportId}.pdf`,
        mimeType: "application/pdf", signal: scope.signal });
      scope.assertCurrent();
      if (isCurrent()) setFileNotice(operation.signal.aborted || outcome === "cancelled" ? "파일 공유를 취소했습니다."
        : outcome === "handoff" ? "공유창을 닫았습니다." : "");
    } catch (error) {
      if (isCurrent()) {
        try { scope?.assertCurrent(); } catch (scopeError) { error = scopeError; }
        if (error instanceof MobileFileExportError && error.code === "FILE_DOCUMENT_CHANGED") {
          setDownloadError(energyReportRequestErrorMessage(error, "download"));
        } else if (operation.signal.aborted) setFileNotice("파일 공유를 취소했습니다.");
        else setDownloadError(energyReportRequestErrorMessage(error, "download"));
      }
    } finally {
      scope?.dispose();
      if (isCurrent()) {
        downloadOperationRef.current = null;
        setDownloadingReportId(undefined);
      }
    }
  }
  async function regenerate(job: EnergyReportJob) {
    if (invalidHistoryRef.current || retryingReportId || !siteId) return;
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

  return <section className="grid min-w-0 gap-6 max-compact:gap-2" aria-label="에너지 보고서">
    <PageHeader variant="customer" headingLevel={1} title="보고서" status={undefined} className="max-compact:flex-row max-compact:items-center max-compact:[&>div:last-child]:w-auto"
      actions={<Button variant="primary" onClick={() => setIsDialogOpen(true)}><FileText size={16} />보고서 만들기</Button>} />
    <ReportHistoryFilters className="max-compact:order-1" scopeKey={draftScope} value={filters} invalidRequestedRange={invalidRequestedRange} onChange={changeFilters} onInvalidDraftChange={onInvalidDraftChange}
      actions={<Button variant="secondary" onClick={() => setIsDialogOpen(true)}><Download size={16} />CSV 내보내기</Button>} />
    <section className="grid min-w-0 gap-4" aria-label="보고서 이력">
      {invalidRequestedRange ? <Text role="alert" tone="danger">URL의 요청 기간을 직접 수정하거나 필터를 초기화해 주세요.</Text> : <>
      {localInvalid ? <Text role="alert" tone="danger">요청 기간을 완성하거나 필터를 초기화한 뒤 이력을 조회하세요.</Text> : null}
      <fieldset disabled={localInvalid} className="contents">
      <ReportJobList reports={displayedPage?.data.reports} timeZone={targets.data?.timeZone} focusTargetRef={reportListRef}
        isLoading={(reports.isLoading || reports.isPlaceholderData || !siteId) && !displayedPage}
        isError={Boolean(reports.isError && !displayedPage)} hasRefreshError={hasRefreshError}
        isBusy={reports.isFetching}
        retryingReportId={retryingReportId} downloadingReportId={downloadingReportId} onRetry={retryList} onRegenerate={(job) => void regenerate(job)} onDownload={(job) => void download(job)} />
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
        showPageSizeSelector={false}
        onPageSizeChange={limit => resetToFirstPage({ ...filters, limit })}
      />
      </fieldset>
      </>}
    </section>
    {downloadingReportId ? <Button variant="secondary" onClick={() => downloadOperationRef.current?.abort()}>파일 준비 취소</Button> : null}
    {fileNotice ? <Text role="status">{fileNotice}</Text> : null}
    {downloadError ? <Text tone="danger" role="alert">{downloadError}</Text> : null}
    {retryError ? <Text tone="danger" role="alert">{retryError}</Text> : null}
    {isDialogOpen && siteId ? <ReportCreateDialog key={siteId} siteId={siteId} targetData={targets.data} onClose={() => setIsDialogOpen(false)}
      isTargetsLoading={targets.isLoading} isTargetsError={targets.isError} onCreate={create}
      onFileNotice={setFileNotice} onExportCsv={(request, signal) => downloadEnergyCsv(siteId, request, { signal })} /> : null}
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
  invalidRequestedRange?: InvalidRequestedRange;
} {
  const filterParams = new URLSearchParams(params);
  const hasLegacyPageState = legacyReportLocationParams.some((key) => filterParams.has(key));
  for (const key of legacyReportLocationParams) filterParams.delete(key);
  let filters: ReportHistoryFilterState;
  try {
    filters = withoutCursor(parseReportHistorySearchParams(filterParams));
  } catch (error) {
    const start = filterParams.get("requestedFrom");
    const end = filterParams.get("requestedTo");
    const dates = energyReportListQuerySchema.safeParse({ limit: 20,
      ...(start !== null ? { requestedFrom: start } : {}), ...(end !== null ? { requestedTo: end } : {}) });
    if (dates.success) throw error;
    const withoutDates = new URLSearchParams(filterParams);
    withoutDates.delete("requestedFrom"); withoutDates.delete("requestedTo");
    try { filters = withoutCursor(parseReportHistorySearchParams(withoutDates)); }
    catch { throw error; } // Non-date validation failures retain the original rejection.
    return { filters, pageState: firstReportPage, needsNormalization: false, invalidRequestedRange: { start, end } };
  }
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
