import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { CarFront, CircleCheck, Clock3, Eye, Power, PowerOff, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  automationListAccessErrorMessage,
  createVehicleEventRule,
  deleteVehicleEventRule,
  isAutomationListAccessDenied,
  isScheduleUnauthorized,
  listVehicleEventRules,
  vehicleEventMutationErrorMessage,
  vehicleEventRuleQueryKey,
  updateVehicleEventRule,
  type CreateVehicleEventRuleInput,
  type VehicleEventRuleResponse,
  type VehicleEventRuleListResponse
} from "../../../api/automation";
import type { AuthUser } from "../../../api/auth";
import { isApiStatus } from "../../../api/client";
import { authMeQueryKey, principalKey } from "../../../api/principal-cache";
import type { Dashboard } from "../../../api/queries";
import { LoadingState, Button, ConfirmDialog, FeedbackState, StatusBadge, Text, useSessionStatus, useSessionToast, type SessionStatusItem  } from "../../../components/ui";
import { formatControlTimestamp } from "../control-time";
import { VehicleEventDialog } from "./VehicleEventDialog";
import { EventSensorStatus } from "./components/EventSensorStatus";
import { AutomationRuleHeader } from "./components/AutomationRuleHeader";
import { AutomationRuleControls } from "./components/AutomationRuleControls";
import { AutomationRuleWorkspace } from "./components/AutomationWorkspaceSurface";
import { automationListRequest, useAutomationListState } from "./components/useAutomationListState";
import { useAutomationVisiblePagePoll } from "./components/useAutomationVisiblePagePoll";
import { AutomationRuleActions, AutomationRuleTable } from "./components/AutomationRuleTable";
import type { DataGridColumn } from "../../../components/ui";

export function VehicleEventControlPanel({
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
  const scope = useRef({ key: operationScopeKey, generation: 0 });
  if (scope.current.key !== operationScopeKey) scope.current = { key: operationScopeKey, generation: scope.current.generation + 1 };
  const scopeGeneration = scope.current.generation;
  const mounted = useRef(true);
  const publishedToastIds = useRef(new Set<string>());
  const [editingRule, setEditingRule] = useState<VehicleEventRuleResponse | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<VehicleEventRuleResponse | null>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const [mutationError, setMutationError] = useState("");
  // Dialog errors follow their form; toggle failures survive unrelated operations.
  const [toggleErrors, setToggleErrors] = useState<Record<string, { scope: string; name: string; message: string }>>({});
  const [failedNextPage, setFailedNextPage] = useState<{ scope: string; cursor: string } | null>(null);
  const [failedRefreshScope, setFailedRefreshScope] = useState<string | null>(null);
  const [lastRefreshSuccess, setLastRefreshSuccess] = useState<{ scope: string; at: number } | null>(null);
  const [visiblePollFailure, setVisiblePollFailure] = useState<{ scope: string; error: unknown } | null>(null);
  const canManage = role === "admin";
  const { filter, appliedQuery, pageIndex, isSearchPending, changeFilter, changePage } = useAutomationListState(operationScopeKey);
  const listScopeKey = JSON.stringify([operationScopeKey, appliedQuery, filter.status, filter.syncStatus, filter.limit]);
  const currentListScope = useRef(listScopeKey);
  currentListScope.current = listScopeKey;
  const listQueryKey = [...vehicleEventRuleQueryKey(siteId), listScopeKey] as const;
  const rulesQuery = useInfiniteQuery({
    queryKey: listQueryKey,
    queryFn: ({ pageParam }) => listVehicleEventRules(siteId, {
      ...automationListRequest(filter, appliedQuery),
      ...(pageParam ? { cursor: pageParam } : {})
    }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages.length ?? 0) > 1 ? false : 3000
  });
  const firstPage = rulesQuery.data?.pages[0];
  const globalContractScope = useRef<string | null>(null);
  if (firstPage) globalContractScope.current = firstPage.siteSummary && typeof firstPage.filteredTotal === "number" ? operationScopeKey : null;
  const hasGlobalContract = globalContractScope.current === operationScopeKey;
  const currentPageIndex = Math.min(pageIndex, Math.max(0, (rulesQuery.data?.pages.length ?? 1) - 1));
  const currentPage = rulesQuery.data?.pages[currentPageIndex];
  const rules = hasGlobalContract ? currentPage?.items ?? [] : rulesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const visiblePollError = visiblePollFailure?.scope === listScopeKey ? visiblePollFailure.error : null;
  const pollingPageIndex = hasGlobalContract ? currentPageIndex : Math.max(0, (rulesQuery.data?.pages.length ?? 1) - 1);
  const pollingPage = rulesQuery.data?.pages[pollingPageIndex];
  const visibleCursor = String(rulesQuery.data?.pageParams[pollingPageIndex] ?? "");
  const refreshVisiblePage = useAutomationVisiblePagePoll<VehicleEventRuleListResponse>({
    enabled: (rulesQuery.data?.pages.length ?? 0) > 1 && Boolean(pollingPage)
      && !isAutomationListAccessDenied(visiblePollError) && !isAutomationListAccessDenied(rulesQuery.error),
    scopeKey: listScopeKey,
    pageKey: `${pollingPageIndex}:${visibleCursor}`,
    fetchPage: () => listVehicleEventRules(siteId, { ...automationListRequest(filter, appliedQuery), ...(visibleCursor ? { cursor: visibleCursor } : {}) }),
    onSuccess: (page) => {
      setVisiblePollFailure(null);
      setFailedRefreshScope(null);
      setLastRefreshSuccess({ scope: listScopeKey, at: Date.now() });
      queryClient.setQueryData<InfiniteData<VehicleEventRuleListResponse>>(listQueryKey, (previous) => {
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
  // A current list access denial wins over an older visible-page transient error.
  const accessError = isAutomationListAccessDenied(rulesQuery.error) ? rulesQuery.error
    : isAutomationListAccessDenied(visiblePollError) ? visiblePollError : null;
  const effectiveError = accessError ?? visiblePollError ?? rulesQuery.error;
  const retryRefresh = () => (rulesQuery.data?.pages.length ?? 0) > 1
    ? refreshVisiblePage() : rulesQuery.refetch();
  // A successful refresh can remove or replace the failed cursor; that page is no longer retryable.
  const missingCursor = failedNextPage?.scope === listScopeKey
    && rulesQuery.data?.pages.at(-1)?.nextCursor === failedNextPage.cursor ? failedNextPage.cursor : null;
  const queryFailure = accessError
    ? {
        message: automationListAccessErrorMessage(accessError),
        retryLabel: accessError === rulesQuery.error && rulesQuery.isLoadingError ? "다시 시도" : "상태 다시 조회",
        retry: accessError === rulesQuery.error ? () => rulesQuery.refetch() : retryRefresh
      }
    : rulesQuery.isLoadingError
    ? {
        message: isScheduleUnauthorized(rulesQuery.error) ? "로그인 세션이 만료되었습니다." : "이벤트 규칙 목록을 불러오지 못했습니다.",
        retryLabel: "다시 시도",
        retry: () => rulesQuery.refetch()
      }
    : missingCursor && !isScheduleUnauthorized(rulesQuery.error)
      ? { message: "다음 이벤트 규칙을 불러오지 못했습니다.", retryLabel: "다음 페이지 다시 시도", retry: loadNextPage }
    : rulesQuery.isFetchNextPageError
      ? {
          message: isScheduleUnauthorized(rulesQuery.error) ? "로그인 세션이 만료되었습니다." : "다음 이벤트 규칙을 불러오지 못했습니다.",
          retryLabel: "다음 페이지 다시 시도",
          retry: loadNextPage
        }
      : rulesQuery.isRefetchError
        ? {
            message: isScheduleUnauthorized(rulesQuery.error) ? "로그인 세션이 만료되었습니다." : "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
            retryLabel: "상태 다시 조회",
            retry: () => rulesQuery.refetch()
          }
        : visiblePollError
          ? {
              message: isScheduleUnauthorized(visiblePollError) ? "로그인 세션이 만료되었습니다." : "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
              retryLabel: "상태 다시 조회",
              retry: retryRefresh
            }
        : null;
  const isNonBlockingQueryFailure = Boolean(rulesQuery.data && queryFailure && !accessError);
  // Site-read loss (403/404) blocks cached management like session expiry; mutation 403/404 stays local.
  const isAuthBlocked = Boolean(accessError);
  const authBlockedRef = useRef(isAuthBlocked);
  authBlockedRef.current = isAuthBlocked;
  const queryUnauthorized = Boolean(accessError);
  const refreshFailure = failedRefreshScope === listScopeKey || rulesQuery.isRefetchError || Boolean(visiblePollError);
  const statusItems = useMemo<SessionStatusItem[]>(() => {
    const items: SessionStatusItem[] = [];
    const lastSuccess = lastRefreshSuccess?.scope === listScopeKey
      ? `마지막 성공: ${formatControlTimestamp(lastRefreshSuccess.at, dashboard?.site.timeZone ?? "UTC")}`
      : undefined;
    if (rulesQuery.data && !queryUnauthorized && (missingCursor || rulesQuery.isFetchNextPageError)) items.push({
      id: `control:event:${scopeKey}:${siteId}:${listScopeKey}:query:next`,
      fingerprint: "next-page-failure",
      source: "query",
      tone: "warning",
      title: "다음 이벤트 규칙을 불러오지 못했습니다.",
      description: lastSuccess,
      action: { label: "다음 페이지 다시 시도", onAction: () => void loadNextPage() }
    });
    if (rulesQuery.data && !queryUnauthorized && refreshFailure) items.push({
      id: `control:event:${scopeKey}:${siteId}:${listScopeKey}:query:refresh`,
      fingerprint: "refresh-failure",
      source: "query",
      tone: "warning",
      title: "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
      description: lastSuccess,
      action: { label: "상태 다시 조회", onAction: () => void retryRefresh() }
    });
    if (!queryUnauthorized) for (const [ruleId, error] of Object.entries(toggleErrors)) {
      if (error.scope !== operationScopeKey) continue;
      items.push({
        id: `control:event:${scopeKey}:${siteId}:mutation:toggle:${ruleId}`,
        fingerprint: error.message,
        source: "command",
        tone: "danger",
        title: error.message,
        description: `이벤트 규칙: ${error.name}`
      });
    }
    return items;
  }, [dashboard?.site.timeZone, lastRefreshSuccess, listScopeKey, missingCursor, operationScopeKey, queryUnauthorized, refreshFailure, rulesQuery.data, rulesQuery.fetchNextPage, rulesQuery.isFetchNextPageError, rulesQuery.refetch, scopeKey, siteId, toggleErrors]);
  useSessionStatus(`control:event:${scopeKey}:${siteId}`, statusItems);
  // Mutation-level callbacks survive observer unmount; per-call callbacks below only update scoped UI state.
  const saveMutation = useMutation({
    mutationFn: ({ operationSiteId, ruleId, input }: { operationSiteId: string; operationScope: string; operationGeneration: number; operationPrincipal: string | null; ruleId: string | null; input: CreateVehicleEventRuleInput }) => ruleId
      ? updateVehicleEventRule(operationSiteId, ruleId, input)
      : createVehicleEventRule(operationSiteId, input),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error, variables) => {
      expireMutationPrincipal(error, variables);
    }
  });
  const toggleMutation = useMutation({
    mutationFn: ({ operationSiteId, ruleId, status }: { operationSiteId: string; operationScope: string; operationGeneration: number; operationPrincipal: string | null; ruleId: string; status: "enabled" | "disabled" }) =>
      updateVehicleEventRule(operationSiteId, ruleId, { status }),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error, variables) => {
      expireMutationPrincipal(error, variables);
    }
  });
  const removeMutation = useMutation({
    mutationFn: ({ operationSiteId, ruleId }: { operationSiteId: string; operationScope: string; operationGeneration: number; operationPrincipal: string | null; ruleId: string }) => deleteVehicleEventRule(operationSiteId, ruleId),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error, variables) => {
      expireMutationPrincipal(error, variables);
    }
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
    setFailedNextPage(null);
    setFailedRefreshScope(null);
    setLastRefreshSuccess(null);
    setVisiblePollFailure(null);
    setEditingRule(null);
    setDialogOpen(false);
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
    expirePrincipal(effectiveError);
  }, [effectiveError, operationScopeKey, rulesQuery.errorUpdatedAt, scopeGeneration]);

  useEffect(() => {
    if (!isAuthBlocked) return;
    setLastRefreshSuccess(null);
    setToggleErrors({});
    setDialogOpen(false);
    setEditingRule(null);
    setDeleteCandidate(null);
    // The row opener disappears with the blocked list; move focus to recovery instead.
    const frame = window.requestAnimationFrame(() => authRetryRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isAuthBlocked]);

  function isCurrent(operationScope: string, operationGeneration: number) {
    return scope.current.key === operationScope && scope.current.generation === operationGeneration;
  }

  function expirePrincipal(error: unknown) {
    if (!isScheduleUnauthorized(error)) return;
    void queryClient.invalidateQueries({ queryKey: authMeQueryKey });
  }

  function currentPrincipal() {
    const auth = queryClient.getQueryData<{ user?: AuthUser } | null>(authMeQueryKey);
    return auth?.user ? principalKey(auth.user) : null;
  }

  function expireMutationPrincipal(error: unknown, variables: { operationScope: string; operationGeneration: number; operationPrincipal: string | null }) {
    if (!isScheduleUnauthorized(error) || currentPrincipal() !== variables.operationPrincipal) return;
    if (mounted.current && !isCurrent(variables.operationScope, variables.operationGeneration)) return;
    void queryClient.invalidateQueries({ queryKey: authMeQueryKey });
  }

  function invalidate(operationSiteId: string) {
    void queryClient.invalidateQueries({ queryKey: vehicleEventRuleQueryKey(operationSiteId) });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  function publishSuccess(dedupeKey: string, title: string) {
    publishedToastIds.current.add(toast.publish({ dedupeKey, tone: "success", title }));
  }

  async function loadNextPage() {
    if (hasGlobalContract && currentPageIndex < (rulesQuery.data?.pages.length ?? 0) - 1) {
      changePage(currentPageIndex + 1);
      return;
    }
    const cursor = rulesQuery.data?.pages.at(-1)?.nextCursor;
    const previousPageCount = rulesQuery.data?.pages.length ?? 0;
    if (!cursor) return;
    const result = await rulesQuery.fetchNextPage();
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
    setEditingRule(null);
    dialogReturnFocusRef.current = addButtonRef.current;
    setMutationError("");
    setDialogOpen(true);
  }

  function beginEdit(rule: VehicleEventRuleResponse, opener: HTMLElement) {
    setEditingRule(rule);
    dialogReturnFocusRef.current = opener;
    setMutationError("");
    setDialogOpen(true);
  }

  function save(input: CreateVehicleEventRuleInput) {
    if (authBlockedRef.current) return;
    const operationScope = operationScopeKey;
    const operationGeneration = scopeGeneration;
    const ruleId = editingRule?.id ?? null;
    setMutationError("");
    saveMutation.mutate({ operationSiteId: siteId, operationScope, operationGeneration, operationPrincipal: currentPrincipal(), ruleId, input }, {
      onSuccess: () => {
        if (!isCurrent(operationScope, operationGeneration) || authBlockedRef.current) return;
        setDialogOpen(false);
        setEditingRule(null);
        publishSuccess(`control:event:${operationScope}:${siteId}:save:${ruleId ?? "new"}`, ruleId ? "이벤트 규칙을 수정했습니다." : "이벤트 규칙을 만들었습니다. Gateway 적용 상태를 확인해 주세요.");
      },
      onError: (error) => {
        if (!isCurrent(operationScope, operationGeneration) || authBlockedRef.current) return;
        setMutationError(vehicleEventMutationErrorMessage(error));
      }
    });
  }

  function bioSourcesReady(rule: VehicleEventRuleResponse) {
    if (dashboard?.site.id !== siteId || !rule.sourceFixtureIds.length) return false;
    const fixtures = dashboard.floors.flatMap(floor => floor.fixtures);
    // Readiness belongs to the current server binding, not an old pulse or a
    // saved rule. Missing/remapped sources must fail closed until refreshed.
    return rule.sourceFixtureIds.every(id => {
      const source = fixtures.find(fixture => fixture.id === id);
      return source?.gateway?.id === rule.gatewayId
        && source.vehicleEventSource?.sensorProtocol === "bio-usb-pulse"
        && source.vehicleEventSource.sourceEligible === true;
    });
  }

  function canToggle(rule: VehicleEventRuleResponse) {
    // Explicit disable remains available even after readiness is lost. The
    // server revalidates admission when the operator requests activation.
    return rule.status === "enabled" || rule.sensorProtocol !== "bio-usb-pulse" || bioSourcesReady(rule);
  }

  function toggle(rule: VehicleEventRuleResponse) {
    if (authBlockedRef.current) return;
    if (!canToggle(rule)) return;
    const operationScope = operationScopeKey;
    const operationGeneration = scopeGeneration;
    const status = rule.status === "enabled" ? "disabled" : "enabled";
    toggleMutation.mutate({ operationSiteId: siteId, operationScope, operationGeneration, operationPrincipal: currentPrincipal(), ruleId: rule.id, status }, {
      onSuccess: () => {
        if (isCurrent(operationScope, operationGeneration) && !authBlockedRef.current) {
          setToggleErrors((current) => {
            const next = { ...current };
            delete next[rule.id];
            return next;
          });
          publishSuccess(`control:event:${operationScope}:${siteId}:toggle:${rule.id}`, status === "enabled" ? "이벤트 규칙을 활성화했습니다." : "이벤트 규칙을 비활성화했습니다.");
        }
      },
      onError: (error) => {
        if (!isCurrent(operationScope, operationGeneration) || authBlockedRef.current) return;
        setToggleErrors((current) => ({ ...current, [rule.id]: { scope: operationScope, name: rule.name, message: vehicleEventMutationErrorMessage(error) } }));
      }
    });
  }

  function remove() {
    if (authBlockedRef.current) return;
    if (!deleteCandidate) return;
    const operationScope = operationScopeKey;
    const operationGeneration = scopeGeneration;
    const ruleId = deleteCandidate.id;
    setMutationError("");
    removeMutation.mutate({ operationSiteId: siteId, operationScope, operationGeneration, operationPrincipal: currentPrincipal(), ruleId }, {
      onSuccess: () => {
        if (!isCurrent(operationScope, operationGeneration) || authBlockedRef.current) return;
        setToggleErrors((current) => {
          const next = { ...current };
          delete next[ruleId];
          return next;
        });
        setDeleteCandidate(null);
        publishSuccess(`control:event:${operationScope}:${siteId}:delete:${ruleId}`, "이벤트 규칙을 삭제했습니다.");
      },
      onError: (error) => {
        if (!isCurrent(operationScope, operationGeneration) || authBlockedRef.current) return;
        setMutationError(vehicleEventMutationErrorMessage(error));
      }
    });
  }

  function renderActions(rule: VehicleEventRuleResponse) {
    if (!canManage) return null;
    return <AutomationRuleActions name={rule.name} enabled={rule.status === "enabled"} disabled={isMutating || isAuthBlocked} toggleDisabled={!canToggle(rule)}
      touchClassName={rule.sensorProtocol === "bio-usb-pulse" ? "max-compact:size-13" : undefined}
      onToggle={() => toggle(rule)} onEdit={opener => beginEdit(rule, opener)}
      onDelete={opener => { deleteReturnFocusRef.current = opener; setDeleteCandidate(rule); setMutationError(""); }} />;
  }

  const columns: DataGridColumn<VehicleEventRuleResponse>[] = [
    { id: "name", header: "이름", minWidth: 150, sortValue: row => row.name, renderCell: row => <strong className="wrap-anywhere">{row.name}</strong> },
    { id: "activation", header: "활성", minWidth: 90, align: "center", sortValue: row => row.status === "enabled" ? "활성" : "비활성", renderCell: row => <EnabledBadge enabled={row.status === "enabled"} /> },
    { id: "sources", header: "감지 센서", minWidth: 120, align: "right", sortValue: row => row.sourceCount, renderCell: row => <>
      {row.sourceCount}개
      {row.sensorProtocol === "bio-usb-pulse" ? <EventSensorStatus name={row.name} ready={bioSourcesReady(row)}
        sources={dashboard?.site.id === siteId ? dashboard.floors.flatMap(floor => floor.fixtures)
          .filter(fixture => row.sourceFixtureIds.includes(fixture.id)) : []} /> : null}
    </> },
    { id: "targets", header: "제어 조명", minWidth: 80, align: "right", sortValue: row => row.targetCount, renderCell: row => `${row.targetCount}개` },
    { id: "brightness", header: "밝기", minWidth: 100, align: "right", sortValue: row => row.action.dimmingEnabled ? row.action.brightnessPercent : 100, renderCell: row => row.action.dimmingEnabled ? `${row.action.brightnessPercent}%` : "디밍 OFF · 100%" },
    { id: "hold", header: "유지", minWidth: 70, align: "right", sortValue: row => row.holdSeconds, renderCell: row => `${row.holdSeconds}초` },
    { id: "sync", header: "Gateway 동기화", minWidth: 110, align: "center", sortValue: row => ({ APPLIED: "적용됨", PENDING: "적용 대기", REJECTED: "적용 실패" })[row.syncStatus], renderCell: row => <SyncBadge status={row.syncStatus} /> },
    { id: "detection", header: "최근 감지", minWidth: 150, sortValue: row => row.lastDetection ? new Date(row.lastDetection.occurredAt) : null, renderCell: row => <><DetectionBadge rule={row} timeZone={dashboard?.site.timeZone ?? "UTC"} wrap /><Text variant="caption" tone="secondary">{dashboard?.site.timeZone ?? "UTC"}</Text></> }
  ];
  if (canManage) columns.push({ id: "actions", header: "관리", minWidth: 116, align: "center", renderCell: renderActions });

  return (
    <div id="control-mode-panel-event" className="grid min-w-0 content-start gap-4 tablet:flex tablet:min-h-0 tablet:flex-1 tablet:flex-col tablet:overflow-hidden" role="tabpanel" aria-labelledby="control-mode-event" data-control-automation-panel="event">
      <AutomationRuleHeader addAction={<>
        {!canManage ? <StatusBadge tone="neutral" icon={Eye}>조회 전용</StatusBadge> : null}
        {canManage && !isAuthBlocked ? <Button ref={addButtonRef} variant="primary" type="button" onClick={beginAdd} disabled={isMutating || !dashboard}><CarFront size={16} aria-hidden="true" /> 이벤트 추가</Button> : null}
      </>} />
      {hasGlobalContract && !isAuthBlocked ? <AutomationRuleControls label="이벤트" filter={filter}
        filteredTotal={isSearchPending ? undefined : firstPage?.filteredTotal}
        pageIndex={currentPageIndex} currentPageCount={isSearchPending ? 0 : rules.length}
        hasNextPage={!isSearchPending && (currentPageIndex < (rulesQuery.data?.pages.length ?? 0) - 1 || Boolean(currentPage?.nextCursor))}
        isFetchingNextPage={rulesQuery.isFetchingNextPage}
        onFilterChange={changeFilter} onPrevious={() => changePage(currentPageIndex - 1)} onNext={() => void loadNextPage()} /> : null}
      <AutomationRuleWorkspace footer={!hasGlobalContract && rulesQuery.hasNextPage && !isAuthBlocked ? <Button variant="secondary" type="button" disabled={rulesQuery.isFetchingNextPage} isLoading={rulesQuery.isFetchingNextPage} loadingLabel="불러오는 중" onClick={() => void loadNextPage()}>더 보기</Button> : undefined}>
      {rulesQuery.isLoading ? <LoadingState title="이벤트 규칙을 불러오는 중입니다." /> : null}
      {isSearchPending ? <LoadingState title="검색 조건을 적용 중입니다." /> : null}
      {queryFailure && !isNonBlockingQueryFailure ? <QueryError message={queryFailure.message} onRetry={() => void queryFailure.retry()} label={queryFailure.retryLabel} buttonRef={authRetryRef} /> : null}
      {!rulesQuery.isLoading && !rulesQuery.isLoadingError && !isAuthBlocked && !isSearchPending ? (
        rules.length > 0 ? <AutomationRuleTable caption="차량 이벤트 목록" rows={rules} columns={columns} getRowKey={row => row.id} /> : <FeedbackState icon={CarFront}
          title={hasGlobalContract && firstPage?.total !== 0 ? "조건에 맞는 이벤트 규칙이 없습니다." : "등록된 이벤트 규칙이 없습니다."}
          description={hasGlobalContract && firstPage?.total !== 0 ? "검색이나 필터 조건을 바꿔 다시 확인해 주세요." : "감지 센서와 제어 조명을 연결해 차량 이벤트 대응을 시작할 수 있습니다."} />
      ) : null}
      </AutomationRuleWorkspace>
      {dashboard ? <VehicleEventDialog open={dialogOpen && !isAuthBlocked} rule={editingRule} dashboard={dashboard} isPending={saveMutation.isPending} serverError={mutationError} returnFocusRef={dialogReturnFocusRef} onClose={() => { if (!saveMutation.isPending) setDialogOpen(false); }} onRefreshSource={() => queryClient.invalidateQueries({ queryKey: ["dashboard"] }, { throwOnError: true })} onSubmit={save} /> : null}
      <ConfirmDialog isOpen={Boolean(deleteCandidate) && !isAuthBlocked} title="이벤트 규칙 삭제" description={deleteCandidate ? `${deleteCandidate.name} 규칙을 삭제합니다.` : undefined} confirmLabel="삭제" tone="danger" isPending={removeMutation.isPending} returnFocusRef={deleteReturnFocusRef} fallbackFocusRef={addButtonRef} onCancel={() => { if (!removeMutation.isPending) setDeleteCandidate(null); }} onConfirm={remove}>
        {mutationError ? <Text tone="danger" role="alert">{mutationError}</Text> : null}
      </ConfirmDialog>
    </div>
  );
}

function QueryError({ message, onRetry, label, buttonRef }: { message: string; onRetry: () => void; label: string; buttonRef: RefObject<HTMLButtonElement> }) {
  return <FeedbackState tone="danger" liveRole="alert" icon={TriangleAlert} title={message} action={<Button ref={buttonRef} variant="secondary" type="button" onClick={onRetry}>{label}</Button>} />;
}

function SyncBadge({ status }: { status: "PENDING" | "APPLIED" | "REJECTED" }) {
  const presentation = status === "APPLIED"
    ? { tone: "success" as const, icon: CircleCheck, label: "적용됨" }
    : status === "REJECTED"
      ? { tone: "danger" as const, icon: TriangleAlert, label: "적용 실패" }
      : { tone: "warning" as const, icon: Clock3, label: "적용 대기" };
  return <StatusBadge tone={presentation.tone} icon={presentation.icon}>{presentation.label}</StatusBadge>;
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled
    ? <StatusBadge tone="success" icon={Power}>활성</StatusBadge>
    : <StatusBadge tone="neutral" icon={PowerOff}>비활성</StatusBadge>;
}

function DetectionBadge({ rule, timeZone, wrap = false }: { rule: VehicleEventRuleResponse; timeZone: string; wrap?: boolean }) {
  const label = rule.lastDetection
    ? formatControlTimestamp(rule.lastDetection.occurredAt, timeZone)
    : "최근 감지 없음";
  return <StatusBadge tone={rule.lastDetection ? "info" : "neutral"} icon={rule.lastDetection ? CarFront : Clock3} className={wrap ? "max-w-full whitespace-normal break-words" : undefined}>{label}</StatusBadge>;
}
