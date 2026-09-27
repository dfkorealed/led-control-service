import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { automationExecutionActionResultPayloadV1Schema } from "@led-control/shared/automation-contracts";
import { CalendarPlus, CircleCheck, Clock3, Eye, Pencil, Power, PowerOff, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSchedule,
  deleteSchedule,
  isScheduleUnauthorized,
  listSchedules,
  scheduleMutationErrorMessage,
  scheduleQueryErrorMessage,
  scheduleQueryKey,
  updateSchedule,
  type CreateScheduleInput,
  type ScheduleResponse,
  type ScheduleListResponse
} from "../../../api/automation";
import type { AuthUser } from "../../../api/auth";
import { isApiStatus } from "../../../api/client";
import { authMeQueryKey, principalKey } from "../../../api/principal-cache";
import type { Dashboard } from "../../../api/queries";
import { Button, ConfirmDialog, FeedbackState, PageHeader, StatusBadge, Text, useSessionStatus, useSessionToast, type SessionStatusItem } from "../../../components/ui";
import { ScheduleDialog } from "./ScheduleDialog";
import { AutomationRuleCard } from "./components/AutomationRuleCard";
import { AutomationRuleControls } from "./components/AutomationRuleControls";
import { AutomationRuleWorkspace, AutomationWorkspaceSummary } from "./components/AutomationWorkspaceSurface";
import { automationListRequest, useAutomationListState } from "./components/useAutomationListState";
import { useAutomationVisiblePagePoll } from "./components/useAutomationVisiblePagePoll";
import {
  AutomationRuleTable,
  automationTableCellClassName,
  automationTableHeadingClassName,
  useCompactAutomationList
} from "./components/AutomationRuleTable";

export function ScheduleControlPanel({
  siteId,
  role,
  dashboard,
  scopeKey = siteId
}: {
  siteId: string;
  role: AuthUser["role"];
  dashboard?: Dashboard;
  scopeKey?: string;
}) {
  const queryClient = useQueryClient();
  const toast = useSessionToast();
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const authRetryRef = useRef<HTMLButtonElement>(null);
  const operationScopeKey = `${scopeKey}:${siteId}`;
  const currentScope = useRef({ key: operationScopeKey, generation: 0 });
  if (currentScope.current.key !== operationScopeKey) {
    currentScope.current = { key: operationScopeKey, generation: currentScope.current.generation + 1 };
  }
  const currentScopeGeneration = currentScope.current.generation;
  const mounted = useRef(true);
  const publishedToastIds = useRef(new Set<string>());
  const expiredPrincipalGeneration = useRef<number | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleResponse | null>(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ScheduleResponse | null>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const [mutationError, setMutationError] = useState("");
  // Dialog errors follow their form; toggle failures survive unrelated operations.
  const [toggleErrors, setToggleErrors] = useState<Record<string, { scope: string; name: string; message: string }>>({});
  const [failedNextPage, setFailedNextPage] = useState<{ scope: string; cursor: string } | null>(null);
  const [failedRefreshScope, setFailedRefreshScope] = useState<string | null>(null);
  const [lastRefreshSuccess, setLastRefreshSuccess] = useState<{ scope: string; at: number } | null>(null);
  const [visiblePollFailure, setVisiblePollFailure] = useState<{ scope: string; error: unknown } | null>(null);
  const canManage = role === "admin";
  const isCompactList = useCompactAutomationList();
  const { filter, appliedQuery, pageIndex, isSearchPending, changeFilter, changePage } = useAutomationListState(operationScopeKey);
  const listScopeKey = JSON.stringify([operationScopeKey, appliedQuery, filter.status, filter.syncStatus, filter.limit]);
  const currentListScope = useRef(listScopeKey);
  currentListScope.current = listScopeKey;
  const listQueryKey = [...scheduleQueryKey(siteId), listScopeKey] as const;
  const schedulesQuery = useInfiniteQuery({
    queryKey: listQueryKey,
    queryFn: ({ pageParam }) => listSchedules(siteId, {
      ...automationListRequest(filter, appliedQuery),
      ...(pageParam ? { cursor: pageParam } : {})
    }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages.length ?? 0) > 1 ? false : 3000
  });
  const firstPage = schedulesQuery.data?.pages[0];
  const globalContractScope = useRef<string | null>(null);
  if (firstPage) globalContractScope.current = firstPage.siteSummary && typeof firstPage.filteredTotal === "number" ? operationScopeKey : null;
  const hasGlobalContract = globalContractScope.current === operationScopeKey;
  const currentPageIndex = Math.min(pageIndex, Math.max(0, (schedulesQuery.data?.pages.length ?? 1) - 1));
  const currentPage = schedulesQuery.data?.pages[currentPageIndex];
  const schedules = hasGlobalContract ? currentPage?.items ?? [] : schedulesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const visiblePollError = visiblePollFailure?.scope === listScopeKey ? visiblePollFailure.error : null;
  const pollingPageIndex = hasGlobalContract ? currentPageIndex : Math.max(0, (schedulesQuery.data?.pages.length ?? 1) - 1);
  const pollingPage = schedulesQuery.data?.pages[pollingPageIndex];
  const visibleCursor = String(schedulesQuery.data?.pageParams[pollingPageIndex] ?? "");
  const refreshVisiblePage = useAutomationVisiblePagePoll<ScheduleListResponse>({
    enabled: (schedulesQuery.data?.pages.length ?? 0) > 1 && Boolean(pollingPage) && !isScheduleUnauthorized(visiblePollError),
    scopeKey: listScopeKey,
    pageKey: `${pollingPageIndex}:${visibleCursor}`,
    fetchPage: () => listSchedules(siteId, { ...automationListRequest(filter, appliedQuery), ...(visibleCursor ? { cursor: visibleCursor } : {}) }),
    onSuccess: (page) => {
      setVisiblePollFailure(null);
      setFailedRefreshScope(null);
      setLastRefreshSuccess({ scope: listScopeKey, at: Date.now() });
      queryClient.setQueryData<InfiniteData<ScheduleListResponse>>(listQueryKey, (previous) => {
        if (!previous?.pages[pollingPageIndex]) return previous;
        const changedCursor = previous.pages[pollingPageIndex].nextCursor !== page.nextCursor;
        const pages = previous.pages.slice(0, changedCursor ? pollingPageIndex + 1 : undefined);
        pages[pollingPageIndex] = page;
        if (pollingPageIndex > 0) pages[0] = { ...pages[0], total: page.total, filteredTotal: page.filteredTotal, siteSummary: page.siteSummary };
        return { ...previous, pages, pageParams: changedCursor ? previous.pageParams.slice(0, pollingPageIndex + 1) : previous.pageParams };
      });
    },
    onError: (error) => {
      if (visibleCursor && isApiStatus(error, 400)) {
        setVisiblePollFailure(null);
        changePage(0);
        void queryClient.resetQueries({ queryKey: listQueryKey, exact: true });
        return;
      }
      setVisiblePollFailure({ scope: listScopeKey, error });
    }
  });
  const effectiveError = visiblePollError ?? schedulesQuery.error;
  const retryRefresh = () => (schedulesQuery.data?.pages.length ?? 0) > 1
    ? refreshVisiblePage() : schedulesQuery.refetch();
  // A successful refresh can remove or replace the failed cursor; that page is no longer retryable.
  const missingCursor = failedNextPage?.scope === listScopeKey
    && schedulesQuery.data?.pages.at(-1)?.nextCursor === failedNextPage.cursor ? failedNextPage.cursor : null;
  const queryFailure = isScheduleUnauthorized(visiblePollError)
    ? { message: scheduleQueryErrorMessage(visiblePollError), retryLabel: "상태 다시 조회", retry: retryRefresh }
    : schedulesQuery.isLoadingError
    ? {
        message: scheduleQueryErrorMessage(schedulesQuery.error),
        retryLabel: "다시 시도",
        retry: () => schedulesQuery.refetch()
      }
    : missingCursor && !isScheduleUnauthorized(schedulesQuery.error)
      ? { message: "다음 스케줄을 불러오지 못했습니다.", retryLabel: "다음 페이지 다시 시도", retry: loadNextPage }
    : schedulesQuery.isFetchNextPageError
      ? {
          message: isScheduleUnauthorized(schedulesQuery.error)
            ? scheduleQueryErrorMessage(schedulesQuery.error)
            : "다음 스케줄을 불러오지 못했습니다.",
          retryLabel: "다음 페이지 다시 시도",
          retry: loadNextPage
        }
      : schedulesQuery.isRefetchError
        ? {
            message: isScheduleUnauthorized(schedulesQuery.error)
              ? scheduleQueryErrorMessage(schedulesQuery.error)
              : "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
            retryLabel: "상태 다시 조회",
            retry: () => schedulesQuery.refetch()
          }
        : visiblePollError
          ? {
              message: isScheduleUnauthorized(visiblePollError)
                ? scheduleQueryErrorMessage(visiblePollError)
                : "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
              retryLabel: "상태 다시 조회",
              retry: retryRefresh
            }
        : null;
  const isNonBlockingQueryFailure = Boolean(schedulesQuery.data && queryFailure && !isScheduleUnauthorized(effectiveError));
  const isAuthBlocked = Boolean(queryFailure && isScheduleUnauthorized(effectiveError));
  const authBlockedRef = useRef(isAuthBlocked);
  authBlockedRef.current = isAuthBlocked;
  const queryUnauthorized = isScheduleUnauthorized(effectiveError);
  const refreshFailure = failedRefreshScope === listScopeKey || schedulesQuery.isRefetchError || Boolean(visiblePollError);
  const statusItems = useMemo<SessionStatusItem[]>(() => {
    const items: SessionStatusItem[] = [];
    const lastSuccess = lastRefreshSuccess?.scope === listScopeKey
      ? `마지막 성공: ${new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone: dashboard?.site.timeZone ?? "UTC" }).format(lastRefreshSuccess.at)}`
      : undefined;
    if (schedulesQuery.data && !queryUnauthorized && (missingCursor || schedulesQuery.isFetchNextPageError)) items.push({
      id: `control:schedule:${scopeKey}:${siteId}:${listScopeKey}:query:next`,
      fingerprint: "next-page-failure",
      source: "query",
      tone: "warning",
      title: "다음 스케줄을 불러오지 못했습니다.",
      description: lastSuccess,
      action: { label: "다음 페이지 다시 시도", onAction: () => void loadNextPage() }
    });
    if (schedulesQuery.data && !queryUnauthorized && refreshFailure) items.push({
      id: `control:schedule:${scopeKey}:${siteId}:${listScopeKey}:query:refresh`,
      fingerprint: "refresh-failure",
      source: "query",
      tone: "warning",
      title: "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
      description: lastSuccess,
      action: { label: "상태 다시 조회", onAction: () => void retryRefresh() }
    });
    if (!queryUnauthorized) for (const [scheduleId, error] of Object.entries(toggleErrors)) {
      if (error.scope !== operationScopeKey) continue;
      items.push({
        id: `control:schedule:${scopeKey}:${siteId}:mutation:toggle:${scheduleId}`,
        fingerprint: error.message,
        source: "command",
        tone: "danger",
        title: error.message,
        description: `스케줄: ${error.name}`
      });
    }
    return items;
  }, [dashboard?.site.timeZone, lastRefreshSuccess, listScopeKey, missingCursor, operationScopeKey, queryUnauthorized, refreshFailure, schedulesQuery.data, schedulesQuery.fetchNextPage, schedulesQuery.isFetchNextPageError, schedulesQuery.refetch, scopeKey, siteId, toggleErrors]);
  useSessionStatus(`control:schedule:${scopeKey}:${siteId}`, statusItems);

  const saveMutation = useMutation({
    mutationFn: ({ operationSiteId, scheduleId, input }: { operationSiteId: string; operationScope: string; operationGeneration: number; operationPrincipal: string | null; scheduleId: string | null; input: CreateScheduleInput }) => scheduleId
      ? updateSchedule(operationSiteId, scheduleId, input)
      : createSchedule(operationSiteId, input),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error, variables) => expireMutationPrincipal(error, variables)
  });
  const toggleMutation = useMutation({
    mutationFn: ({ operationSiteId, scheduleId, status }: { operationSiteId: string; operationScope: string; operationGeneration: number; operationPrincipal: string | null; scheduleId: string; status: "enabled" | "disabled" }) =>
      updateSchedule(operationSiteId, scheduleId, { status }),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error, variables) => expireMutationPrincipal(error, variables)
  });
  const removeMutation = useMutation({
    mutationFn: ({ operationSiteId, scheduleId }: { operationSiteId: string; operationScope: string; operationGeneration: number; operationPrincipal: string | null; scheduleId: string }) => deleteSchedule(operationSiteId, scheduleId),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error, variables) => expireMutationPrincipal(error, variables)
  });
  const isMutating = saveMutation.isPending || toggleMutation.isPending || removeMutation.isPending;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => () => {
    for (const id of publishedToastIds.current) toast.dismiss(id);
    publishedToastIds.current.clear();
  }, [operationScopeKey, toast]);

  useEffect(() => {
    expiredPrincipalGeneration.current = null;
    setFailedNextPage(null);
    setFailedRefreshScope(null);
    setLastRefreshSuccess(null);
    setVisiblePollFailure(null);
    setScheduleDialogOpen(false);
    setEditingSchedule(null);
    setDeleteCandidate(null);
    setMutationError("");
    setToggleErrors({});
  }, [scopeKey, siteId]);

  useEffect(() => {
    setFailedNextPage(null);
    setFailedRefreshScope(null);
    setLastRefreshSuccess(null);
    setVisiblePollFailure(null);
  }, [listScopeKey]);

  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || JSON.stringify(event.query.queryKey) !== JSON.stringify(listQueryKey)) return;
    // Infinite queries share one error state. Cache events keep a loaded-page refresh
    // failure until that operation succeeds; fetching the next page cannot resolve it.
    if (event.query.state.fetchMeta?.fetchMore?.direction) return;
    if (event.action.type === "error" && event.query.state.data && !isScheduleUnauthorized(event.action.error)) {
      setFailedRefreshScope(listScopeKey);
    } else if (event.action.type === "success" && !event.action.manual) {
      setFailedRefreshScope((current) => current === listScopeKey ? null : current);
      // dataUpdatedAt also advances for next-page fetches and manual cache writes.
      // Only a completed whole-list fetch establishes freshness in this scope.
      setLastRefreshSuccess({ scope: listScopeKey, at: event.query.state.dataUpdatedAt });
    }
  }), [listScopeKey, queryClient, siteId]);

  useEffect(() => {
    expirePrincipal(effectiveError, operationScopeKey, currentScopeGeneration);
  }, [currentScopeGeneration, effectiveError, operationScopeKey, schedulesQuery.errorUpdatedAt]);

  useEffect(() => {
    if (!isAuthBlocked) return;
    setLastRefreshSuccess(null);
    setToggleErrors({});
    setScheduleDialogOpen(false);
    setEditingSchedule(null);
    setDeleteCandidate(null);
    // The row opener disappears with the blocked list; move focus to recovery instead.
    const frame = window.requestAnimationFrame(() => authRetryRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isAuthBlocked]);

  function isCurrentOperation(operationScope: string, operationGeneration: number) {
    return currentScope.current.key === operationScope
      && currentScope.current.generation === operationGeneration;
  }

  function expirePrincipal(error: unknown, operationScope: string, operationGeneration: number) {
    if (!isScheduleUnauthorized(error) || !isCurrentOperation(operationScope, operationGeneration)) return;
    if (expiredPrincipalGeneration.current === operationGeneration) return;
    expiredPrincipalGeneration.current = operationGeneration;
    void queryClient.invalidateQueries({ queryKey: authMeQueryKey });
  }

  function currentPrincipal() {
    const auth = queryClient.getQueryData<{ user?: AuthUser } | null>(authMeQueryKey);
    return auth?.user ? principalKey(auth.user) : null;
  }

  function expireMutationPrincipal(error: unknown, variables: { operationScope: string; operationGeneration: number; operationPrincipal: string | null }) {
    if (!isScheduleUnauthorized(error) || currentPrincipal() !== variables.operationPrincipal) return;
    if (mounted.current && !isCurrentOperation(variables.operationScope, variables.operationGeneration)) return;
    if (expiredPrincipalGeneration.current === variables.operationGeneration) return;
    expiredPrincipalGeneration.current = variables.operationGeneration;
    void queryClient.invalidateQueries({ queryKey: authMeQueryKey });
  }

  function invalidate(operationSiteId: string) {
    void queryClient.invalidateQueries({ queryKey: scheduleQueryKey(operationSiteId) });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  function publishSuccess(dedupeKey: string, title: string) {
    publishedToastIds.current.add(toast.publish({ dedupeKey, tone: "success", title }));
  }

  async function loadNextPage() {
    if (hasGlobalContract && currentPageIndex < (schedulesQuery.data?.pages.length ?? 0) - 1) {
      changePage(currentPageIndex + 1);
      return;
    }
    const cursor = schedulesQuery.data?.pages.at(-1)?.nextCursor;
    const previousPageCount = schedulesQuery.data?.pages.length ?? 0;
    if (!cursor) return;
    const result = await schedulesQuery.fetchNextPage();
    if (currentListScope.current !== listScopeKey) return;
    if (isApiStatus(result.error, 400)) {
      // An opaque cursor can expire after a server-side list change. Rebuild the chain from page one.
      setFailedNextPage(null);
      changePage(0);
      await queryClient.resetQueries({ queryKey: listQueryKey, exact: true });
      return;
    }
    if (result.isFetchNextPageError && !isScheduleUnauthorized(result.error)) {
      setFailedNextPage({ scope: listScopeKey, cursor });
    } else if (result.isSuccess && (result.data?.pages.length ?? 0) > previousPageCount) {
      setFailedNextPage((current) => current?.scope === listScopeKey && current.cursor === cursor ? null : current);
      if (hasGlobalContract) changePage(previousPageCount);
    }
  }

  function beginAdd() {
    setEditingSchedule(null);
    dialogReturnFocusRef.current = addButtonRef.current;
    setMutationError("");
    setScheduleDialogOpen(true);
  }

  function beginEdit(schedule: ScheduleResponse, opener: HTMLElement) {
    setEditingSchedule(schedule);
    dialogReturnFocusRef.current = opener;
    setMutationError("");
    setScheduleDialogOpen(true);
  }

  function save(input: CreateScheduleInput) {
    if (authBlockedRef.current) return;
    const operationScope = operationScopeKey;
    const operationGeneration = currentScopeGeneration;
    const operationSiteId = siteId;
    const scheduleId = editingSchedule?.id ?? null;
    setMutationError("");
    saveMutation.mutate({ operationSiteId, operationScope, operationGeneration, operationPrincipal: currentPrincipal(), scheduleId, input }, {
      onSuccess: () => {
        if (!isCurrentOperation(operationScope, operationGeneration) || authBlockedRef.current) return;
        setScheduleDialogOpen(false);
        setEditingSchedule(null);
        publishSuccess(`control:schedule:${operationScope}:${operationSiteId}:save:${scheduleId ?? "new"}`, scheduleId ? "스케줄을 수정했습니다." : "스케줄을 만들었습니다. Gateway 적용 상태를 확인해 주세요.");
      },
      onError: (error) => {
        if (!isCurrentOperation(operationScope, operationGeneration) || authBlockedRef.current) return;
        setMutationError(scheduleMutationErrorMessage(error));
      }
    });
  }

  function toggle(schedule: ScheduleResponse) {
    if (authBlockedRef.current) return;
    const operationScope = operationScopeKey;
    const operationGeneration = currentScopeGeneration;
    const operationSiteId = siteId;
    const status = schedule.status === "enabled" ? "disabled" : "enabled";
    toggleMutation.mutate({ operationSiteId, operationScope, operationGeneration, operationPrincipal: currentPrincipal(), scheduleId: schedule.id, status }, {
      onSuccess: () => {
        if (isCurrentOperation(operationScope, operationGeneration) && !authBlockedRef.current) {
          setToggleErrors((current) => {
            const next = { ...current };
            delete next[schedule.id];
            return next;
          });
          publishSuccess(`control:schedule:${operationScope}:${operationSiteId}:toggle:${schedule.id}`, status === "enabled" ? "스케줄을 활성화했습니다." : "스케줄을 비활성화했습니다.");
        }
      },
      onError: (error) => {
        if (!isCurrentOperation(operationScope, operationGeneration) || authBlockedRef.current) return;
        setToggleErrors((current) => ({ ...current, [schedule.id]: { scope: operationScope, name: schedule.name, message: scheduleMutationErrorMessage(error) } }));
      }
    });
  }

  function remove() {
    if (authBlockedRef.current) return;
    if (!deleteCandidate) return;
    const operationScope = operationScopeKey;
    const operationGeneration = currentScopeGeneration;
    const operationSiteId = siteId;
    const scheduleId = deleteCandidate.id;
    setMutationError("");
    removeMutation.mutate({ operationSiteId, operationScope, operationGeneration, operationPrincipal: currentPrincipal(), scheduleId }, {
      onSuccess: () => {
        if (!isCurrentOperation(operationScope, operationGeneration) || authBlockedRef.current) return;
        setToggleErrors((current) => {
          const next = { ...current };
          delete next[scheduleId];
          return next;
        });
        setDeleteCandidate(null);
        publishSuccess(`control:schedule:${operationScope}:${operationSiteId}:delete:${scheduleId}`, "스케줄을 삭제했습니다.");
      },
      onError: (error) => {
        if (!isCurrentOperation(operationScope, operationGeneration) || authBlockedRef.current) return;
        setMutationError(scheduleMutationErrorMessage(error));
      }
    });
  }

  function renderActions(schedule: ScheduleResponse) {
    if (!canManage) return null;
    return <div className="grid grid-cols-3 gap-1.5" data-schedule-row-actions="">
      <Button variant="ghost" className="w-11 p-0" type="button" aria-label={`${schedule.name} ${schedule.status === "enabled" ? "비활성화" : "활성화"}`} title={schedule.status === "enabled" ? "비활성화" : "활성화"} disabled={isMutating} onClick={() => toggle(schedule)}>
        {schedule.status === "enabled" ? <PowerOff size={16} aria-hidden="true" /> : <Power size={16} aria-hidden="true" />}
      </Button>
      <Button variant="ghost" className="w-11 p-0" type="button" aria-label={`${schedule.name} 수정`} title="수정" disabled={isMutating || !dashboard} onClick={(event) => beginEdit(schedule, event.currentTarget)}>
        <Pencil size={16} aria-hidden="true" />
      </Button>
      <Button variant="danger" className="w-11 p-0" type="button" aria-label={`${schedule.name} 삭제`} title="삭제" disabled={isMutating} onClick={(event) => {
        deleteReturnFocusRef.current = event.currentTarget;
        setDeleteCandidate(schedule);
        setMutationError("");
      }}>
        <Trash2 size={16} aria-hidden="true" />
      </Button>
    </div>;
  }

  return (
    <div
      id="control-mode-panel-schedule"
      className="grid min-w-0 content-start gap-4 tablet:min-h-0 tablet:flex-1 tablet:flex-col tablet:overflow-hidden"
      role="tabpanel"
      aria-labelledby="control-mode-schedule"
      data-control-automation-panel="schedule"
    >
      <PageHeader
        title="스케줄 제어"
        headingLevel={3}
        status={!canManage ? <StatusBadge tone="neutral" icon={Eye}>조회 전용</StatusBadge> : undefined}
        actions={canManage && !isAuthBlocked ? (
          <Button
            ref={addButtonRef}
            variant="primary"
            type="button"
            onClick={beginAdd}
            disabled={isMutating || !dashboard}
            title={dashboard ? "새 스케줄 추가" : "제어 대상 정보를 불러오는 중입니다"}
          >
            <CalendarPlus size={16} aria-hidden="true" /> 스케줄 추가
          </Button>
        ) : undefined}
      />

      <AutomationWorkspaceSummary label="스케줄 요약" timeZone={dashboard?.site.timeZone} total={firstPage?.total} siteSummary={firstPage?.siteSummary}
        loadedStatuses={schedules.map((schedule) => schedule.syncStatus)}
        state={schedulesQuery.isLoading ? "loading" : isAuthBlocked || schedulesQuery.isLoadingError ? "error" : "ready"} />

      {hasGlobalContract ? <AutomationRuleControls label="스케줄" filter={filter}
        filteredTotal={isSearchPending ? undefined : firstPage?.filteredTotal}
        pageIndex={currentPageIndex} currentPageCount={isSearchPending ? 0 : schedules.length}
        hasNextPage={!isSearchPending && (currentPageIndex < (schedulesQuery.data?.pages.length ?? 0) - 1 || Boolean(currentPage?.nextCursor))}
        isFetchingNextPage={schedulesQuery.isFetchingNextPage}
        onFilterChange={changeFilter} onPrevious={() => changePage(currentPageIndex - 1)} onNext={() => void loadNextPage()} /> : null}

      <AutomationRuleWorkspace footer={!hasGlobalContract && schedulesQuery.hasNextPage && !schedulesQuery.isFetchNextPageError && !isAuthBlocked ? (
        <Button variant="secondary" type="button" disabled={schedulesQuery.isFetchingNextPage} onClick={() => void loadNextPage()}>
          {schedulesQuery.isFetchingNextPage ? "불러오는 중" : "스케줄 더 보기"}
        </Button>
      ) : undefined}>

      {schedulesQuery.isLoading ? <FeedbackState icon={Clock3} title="스케줄을 불러오는 중입니다." /> : null}
      {isSearchPending ? <FeedbackState icon={Clock3} title="검색 조건을 적용 중입니다." /> : null}
      {queryFailure && !isNonBlockingQueryFailure ? (
        <FeedbackState
          tone={(schedulesQuery.isRefetchError || visiblePollError) && !isScheduleUnauthorized(effectiveError) ? "warning" : "danger"}
          liveRole="alert"
          icon={TriangleAlert}
          title={queryFailure.message}
          action={<Button ref={authRetryRef} variant="secondary" type="button" onClick={() => void queryFailure.retry()}>{queryFailure.retryLabel}</Button>}
        />
      ) : null}

      {!schedulesQuery.isLoading && !schedulesQuery.isLoadingError && !isAuthBlocked && !isSearchPending ? (
        schedules.length > 0 ? isCompactList ? <div role="list" aria-label="스케줄 카드 목록" className="grid min-w-0 gap-3">
          {schedules.map((schedule) => <AutomationRuleCard
            key={schedule.id}
            name={schedule.name}
            status={<EnabledBadge enabled={schedule.status === "enabled"} />}
            fields={[
              { label: "적용 기간", value: formatActivePeriod(schedule, dashboard?.site.timeZone ?? "UTC") },
              { label: "다음 실행", value: formatNextOccurrence(schedule, dashboard?.site.timeZone ?? "UTC") },
              { label: "반복 · 시간", value: formatRecurrence(schedule) },
              { label: "밝기", value: schedule.action.dimmingEnabled ? `${schedule.action.brightnessPercent}%` : "디밍 OFF · 100%" },
              { label: "대상", value: `${schedule.targetCount}개` },
              { label: "Gateway 동기화", value: <SyncBadge status={schedule.syncStatus} /> },
              { label: "최근 결과", value: <LastExecutionBadge schedule={schedule} timeZone={dashboard?.site.timeZone ?? "UTC"} wrap /> }
            ]}
            actions={renderActions(schedule)}
          />)}
        </div> : <AutomationRuleTable label="스케줄 목록">
            <thead>
              <tr>
                <th className={automationTableHeadingClassName}>이름</th>
                <th className={automationTableHeadingClassName}>활성</th>
                <th className={automationTableHeadingClassName}>다음 실행</th>
                <th className={automationTableHeadingClassName}>반복 · 시간</th>
                <th className={automationTableHeadingClassName}>밝기</th>
                <th className={automationTableHeadingClassName}>대상</th>
                <th className={automationTableHeadingClassName}>Gateway 동기화</th>
                <th className={automationTableHeadingClassName}>최근 결과</th>
                {canManage ? <th className={automationTableHeadingClassName} aria-label="관리" /> : null}
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule, index) => {
                const isLastRow = index === schedules.length - 1;
                return (
                <tr key={schedule.id}>
                  <td className={automationTableCellClassName(isLastRow, "grid gap-1")}>
                    <strong className="max-w-48 truncate">{schedule.name}</strong>
                    <small className="text-content-muted">{formatActivePeriod(schedule, dashboard?.site.timeZone ?? "UTC")}</small>
                  </td>
                  <td className={automationTableCellClassName(isLastRow)}><EnabledBadge enabled={schedule.status === "enabled"} /></td>
                  <td className={automationTableCellClassName(isLastRow)}>{formatNextOccurrence(schedule, dashboard?.site.timeZone ?? "UTC")}</td>
                  <td className={automationTableCellClassName(isLastRow)}>{formatRecurrence(schedule)}</td>
                  <td className={automationTableCellClassName(isLastRow)}>{schedule.action.dimmingEnabled ? `${schedule.action.brightnessPercent}%` : "디밍 OFF · 100%"}</td>
                  <td className={automationTableCellClassName(isLastRow)}>{schedule.targetCount}개</td>
                  <td className={automationTableCellClassName(isLastRow)}><SyncBadge status={schedule.syncStatus} /></td>
                  <td className={automationTableCellClassName(isLastRow)}><LastExecutionBadge schedule={schedule} timeZone={dashboard?.site.timeZone ?? "UTC"} /></td>
                  {canManage ? (
                    <td className={automationTableCellClassName(isLastRow)}>
                      {renderActions(schedule)}
                    </td>
                  ) : null}
                </tr>
                );
              })}
            </tbody>
        </AutomationRuleTable> : <FeedbackState
          icon={CalendarPlus}
          title={hasGlobalContract && firstPage?.total !== 0 ? "조건에 맞는 스케줄이 없습니다." : "등록된 스케줄이 없습니다."}
          description={hasGlobalContract && firstPage?.total !== 0 ? "검색이나 필터 조건을 바꿔 다시 확인해 주세요." : "반복 밝기 규칙을 추가하면 Gateway 적용 상태와 최근 결과를 여기서 확인할 수 있습니다."}
        />
      ) : null}

      </AutomationRuleWorkspace>

      {dashboard ? (
        <ScheduleDialog
          open={scheduleDialogOpen && !isAuthBlocked}
          schedule={editingSchedule}
          dashboard={dashboard}
          isPending={saveMutation.isPending}
          serverError={scheduleDialogOpen ? mutationError : ""}
          returnFocusRef={dialogReturnFocusRef}
          onClose={() => {
            if (saveMutation.isPending) return;
            setScheduleDialogOpen(false);
            setEditingSchedule(null);
            setMutationError("");
          }}
          onSubmit={save}
        />
      ) : null}

      <ConfirmDialog
        isOpen={Boolean(deleteCandidate) && !isAuthBlocked}
        title="스케줄 삭제"
        description={deleteCandidate ? `${deleteCandidate.name} 스케줄을 삭제하시겠습니까?` : undefined}
        confirmLabel="삭제"
        tone="danger"
        isPending={removeMutation.isPending}
        returnFocusRef={deleteReturnFocusRef}
        fallbackFocusRef={addButtonRef}
        onCancel={() => {
          if (!removeMutation.isPending) setDeleteCandidate(null);
        }}
        onConfirm={remove}
      >
        {deleteCandidate && mutationError ? <Text tone="danger" role="alert">{mutationError}</Text> : null}
      </ConfirmDialog>
    </div>
  );
}

function SyncBadge({ status }: { status: ScheduleResponse["syncStatus"] }) {
  const presentation = status === "APPLIED"
    ? { label: "적용됨", tone: "success" as const, icon: CircleCheck }
    : status === "REJECTED"
      ? { label: "적용 실패", tone: "danger" as const, icon: TriangleAlert }
      : { label: "적용 대기", tone: "warning" as const, icon: Clock3 };
  return <StatusBadge tone={presentation.tone} icon={presentation.icon}>{presentation.label}</StatusBadge>;
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled
    ? <StatusBadge tone="success" icon={Power}>활성</StatusBadge>
    : <StatusBadge tone="neutral" icon={PowerOff}>비활성</StatusBadge>;
}

function LastExecutionBadge({ schedule, timeZone, wrap = false }: { schedule: ScheduleResponse; timeZone: string; wrap?: boolean }) {
  const failed = schedule.lastExecution?.kind === "action_result"
    && !formatActionResult(schedule.lastExecution.payload).startsWith("모두 성공");
  return (
    <StatusBadge tone={failed ? "danger" : schedule.lastExecution ? "info" : "neutral"} icon={failed ? TriangleAlert : Clock3} className={wrap ? "max-w-full whitespace-normal break-words" : undefined}>
      {formatLastExecution(schedule, timeZone)}
    </StatusBadge>
  );
}

function formatActivePeriod(schedule: ScheduleResponse, timeZone: string) {
  return `${formatDate(schedule.activeFrom, timeZone)} ~ ${formatDate(schedule.activeUntil, timeZone)}`;
}

function formatNextOccurrence(schedule: ScheduleResponse, timeZone: string) {
  if (!schedule.nextOccurrence) return "예정 없음";
  return formatDateTime(schedule.nextOccurrence.startsAt, timeZone);
}

function formatRecurrence(schedule: ScheduleResponse) {
  const recurrence = schedule.recurrence;
  const labels: Record<number, string> = { 1: "월", 2: "화", 3: "수", 4: "목", 5: "금", 6: "토", 7: "일" };
  const recurrenceLabel = recurrence.kind === "once"
    ? "1회"
    : recurrence.kind === "daily"
      ? "매일"
      : recurrence.kind === "weekly"
        ? `매주 ${recurrence.weeklyDays.map((day) => labels[day]).join("·")}`
        : recurrence.kind === "monthly"
          ? `매월 ${recurrence.monthlyDay}일`
          : `매년 ${recurrence.yearlyMonth}월 ${recurrence.yearlyDay}일`;
  const crossesMidnight = schedule.localEndTime < schedule.localStartTime;
  return `${recurrenceLabel} · ${schedule.localStartTime}~${schedule.localEndTime}${crossesMidnight ? "(다음 날)" : ""}`;
}

function formatLastExecution(schedule: ScheduleResponse, timeZone: string) {
  if (!schedule.lastExecution) return "실행 기록 없음";
  const labels: Record<NonNullable<ScheduleResponse["lastExecution"]>["kind"], string> = {
    schedule_started: "스케줄 시작",
    schedule_ended: "스케줄 종료",
    vehicle_detected: "차량 감지",
    event_started: "이벤트 시작",
    event_extended: "이벤트 연장",
    event_ended: "이벤트 종료",
    action_result: "조명 적용 결과",
    telemetry_gap: "실행 기록 일부 누락"
  };
  const label = schedule.lastExecution.kind === "action_result"
    ? formatActionResult(schedule.lastExecution.payload)
    : labels[schedule.lastExecution.kind];
  return `${label} · ${formatDateTime(schedule.lastExecution.occurredAt, timeZone)}`;
}

function formatActionResult(payload: unknown) {
  const parsed = automationExecutionActionResultPayloadV1Schema.safeParse(payload);
  if (!parsed.success) return "결과 상세를 확인할 수 없음";

  const counts = { succeeded: 0, failed: 0, timed_out: 0 };
  for (const result of parsed.data.results) counts[result.status] += 1;
  if (counts.failed === 0 && counts.timed_out === 0) {
    return `모두 성공 · 성공 ${counts.succeeded}개`;
  }

  const details = [
    counts.succeeded > 0 ? `성공 ${counts.succeeded}개` : null,
    counts.failed > 0 ? `실패 ${counts.failed}개` : null,
    counts.timed_out > 0 ? `시간 초과 ${counts.timed_out}개` : null
  ].filter((detail): detail is string => Boolean(detail));
  return `${counts.succeeded > 0 ? "일부 실패" : "실패"} · ${details.join(" · ")}`;
}

function formatDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(iso));
}

function formatDateTime(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(iso));
}
