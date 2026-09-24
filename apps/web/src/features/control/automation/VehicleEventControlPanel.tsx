import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CarFront, CircleCheck, Clock3, Eye, Pencil, Power, PowerOff, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  createVehicleEventRule,
  deleteVehicleEventRule,
  isScheduleUnauthorized,
  listVehicleEventRules,
  vehicleEventMutationErrorMessage,
  vehicleEventRuleQueryKey,
  updateVehicleEventRule,
  type CreateVehicleEventRuleInput,
  type VehicleEventRuleResponse
} from "../../../api/automation";
import type { AuthUser } from "../../../api/auth";
import { authMeQueryKey, principalKey } from "../../../api/principal-cache";
import type { Dashboard } from "../../../api/queries";
import { Button, ConfirmDialog, FeedbackState, PageHeader, StatusBadge, Text, useSessionStatus, useSessionToast, type SessionStatusItem } from "../../../components/ui";
import { VehicleEventDialog } from "./VehicleEventDialog";
import { AutomationRuleCard } from "./components/AutomationRuleCard";
import {
  AutomationRuleTable,
  automationTableCellClassName,
  automationTableHeadingClassName,
  useCompactAutomationList
} from "./components/AutomationRuleTable";

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
  const canManage = role === "admin";
  const isCompactList = useCompactAutomationList();
  const rulesQuery = useInfiniteQuery({
    queryKey: vehicleEventRuleQueryKey(siteId),
    queryFn: ({ pageParam }) => listVehicleEventRules(siteId, { limit: 100, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 3000
  });
  const rules = rulesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  // A successful refresh can remove or replace the failed cursor; that page is no longer retryable.
  const missingCursor = failedNextPage?.scope === operationScopeKey
    && rulesQuery.data?.pages.at(-1)?.nextCursor === failedNextPage.cursor ? failedNextPage.cursor : null;
  const queryFailure = rulesQuery.isLoadingError
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
        : null;
  const isNonBlockingQueryFailure = Boolean(rulesQuery.data && queryFailure && !isScheduleUnauthorized(rulesQuery.error));
  const isAuthBlocked = Boolean(queryFailure && isScheduleUnauthorized(rulesQuery.error));
  const authBlockedRef = useRef(isAuthBlocked);
  authBlockedRef.current = isAuthBlocked;
  const queryUnauthorized = isScheduleUnauthorized(rulesQuery.error);
  const refreshFailure = failedRefreshScope === operationScopeKey || rulesQuery.isRefetchError;
  const statusItems = useMemo<SessionStatusItem[]>(() => {
    const items: SessionStatusItem[] = [];
    const lastSuccess = lastRefreshSuccess?.scope === operationScopeKey
      ? `마지막 성공: ${new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone: dashboard?.site.timeZone ?? "UTC" }).format(lastRefreshSuccess.at)}`
      : undefined;
    if (rulesQuery.data && !queryUnauthorized && (missingCursor || rulesQuery.isFetchNextPageError)) items.push({
      id: `control:event:${scopeKey}:${siteId}:query:next`,
      fingerprint: "next-page-failure",
      source: "query",
      tone: "warning",
      title: "다음 이벤트 규칙을 불러오지 못했습니다.",
      description: lastSuccess,
      action: { label: "다음 페이지 다시 시도", onAction: () => void loadNextPage() }
    });
    if (rulesQuery.data && !queryUnauthorized && refreshFailure) items.push({
      id: `control:event:${scopeKey}:${siteId}:query:refresh`,
      fingerprint: "refresh-failure",
      source: "query",
      tone: "warning",
      title: "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
      description: lastSuccess,
      action: { label: "상태 다시 조회", onAction: () => void rulesQuery.refetch() }
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
  }, [dashboard?.site.timeZone, lastRefreshSuccess, missingCursor, operationScopeKey, queryUnauthorized, refreshFailure, rulesQuery.data, rulesQuery.fetchNextPage, rulesQuery.isFetchNextPageError, rulesQuery.refetch, scopeKey, siteId, toggleErrors]);
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
    setEditingRule(null);
    setDialogOpen(false);
    setDeleteCandidate(null);
    setMutationError("");
    setToggleErrors({});
  }, [scopeKey, siteId]);

  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== "automation-vehicle-event-rules" || event.query.queryKey[1] !== siteId) return;
    // Infinite queries share one error state. Cache events keep a loaded-page refresh
    // failure until that operation succeeds; fetching the next page cannot resolve it.
    if (event.query.state.fetchMeta?.fetchMore?.direction) return;
    if (event.action.type === "error" && event.query.state.data && !isScheduleUnauthorized(event.action.error)) {
      setFailedRefreshScope(operationScopeKey);
    } else if (event.action.type === "success" && !event.action.manual) {
      setFailedRefreshScope((current) => current === operationScopeKey ? null : current);
      // dataUpdatedAt also advances for next-page fetches and manual cache writes.
      // Only a completed whole-list fetch establishes freshness in this scope.
      setLastRefreshSuccess({ scope: operationScopeKey, at: event.query.state.dataUpdatedAt });
    }
  }), [operationScopeKey, queryClient, siteId]);

  useEffect(() => {
    expirePrincipal(rulesQuery.error);
  }, [operationScopeKey, rulesQuery.error, rulesQuery.errorUpdatedAt, scopeGeneration]);

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
    const cursor = rulesQuery.data?.pages.at(-1)?.nextCursor;
    const previousPageCount = rulesQuery.data?.pages.length ?? 0;
    if (!cursor) return;
    const result = await rulesQuery.fetchNextPage();
    if (result.isFetchNextPageError && !isScheduleUnauthorized(result.error)) {
      setFailedNextPage({ scope: operationScopeKey, cursor });
    } else if (result.isSuccess && (result.data?.pages.length ?? 0) > previousPageCount) {
      setFailedNextPage((current) => current?.scope === operationScopeKey && current.cursor === cursor ? null : current);
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

  function toggle(rule: VehicleEventRuleResponse) {
    if (authBlockedRef.current) return;
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
    return <div className="grid grid-cols-3 gap-1.5" data-schedule-row-actions="">
      <Button variant="ghost" className="w-11 p-0" type="button" aria-label={`${rule.name} ${rule.status === "enabled" ? "비활성화" : "활성화"}`} title={rule.status === "enabled" ? "비활성화" : "활성화"} disabled={isMutating} onClick={() => toggle(rule)}>{rule.status === "enabled" ? <PowerOff size={15} aria-hidden="true" /> : <Power size={15} aria-hidden="true" />}</Button>
      <Button variant="ghost" className="w-11 p-0" type="button" aria-label={`${rule.name} 수정`} title="수정" disabled={isMutating} onClick={(event) => beginEdit(rule, event.currentTarget)}><Pencil size={15} aria-hidden="true" /></Button>
      <Button variant="danger" className="w-11 p-0" type="button" aria-label={`${rule.name} 삭제`} title="삭제" disabled={isMutating} onClick={(event) => { setDeleteCandidate(rule); deleteReturnFocusRef.current = event.currentTarget; setMutationError(""); }}><Trash2 size={15} aria-hidden="true" /></Button>
    </div>;
  }

  return (
    <div id="control-mode-panel-event" className="grid min-w-0 content-start gap-4 tablet:min-h-0 tablet:flex-1 tablet:overflow-y-auto" role="tabpanel" aria-labelledby="control-mode-event" data-control-automation-panel="event">
      <PageHeader
        title="이벤트 제어"
        headingLevel={3}
        description="Gateway가 차량 센서 감지를 현장 조명 규칙으로 즉시 연결합니다."
        status={!canManage ? <StatusBadge tone="neutral" icon={Eye}>조회 전용</StatusBadge> : undefined}
        actions={canManage && !isAuthBlocked ? <Button ref={addButtonRef} variant="primary" type="button" onClick={beginAdd} disabled={isMutating || !dashboard}><CarFront size={16} aria-hidden="true" /> 이벤트 추가</Button> : undefined}
      />
      {rulesQuery.isLoading ? <FeedbackState icon={Clock3} title="이벤트 규칙을 불러오는 중입니다." /> : null}
      {queryFailure && !isNonBlockingQueryFailure ? <QueryError message={queryFailure.message} onRetry={() => void queryFailure.retry()} label={queryFailure.retryLabel} buttonRef={authRetryRef} /> : null}
      {!rulesQuery.isLoading && !rulesQuery.isLoadingError && !isAuthBlocked ? (
        rules.length > 0 ? isCompactList ? <div role="list" aria-label="차량 이벤트 카드 목록" className="grid min-w-0 gap-3">
          {rules.map((rule) => <AutomationRuleCard
            key={rule.id}
            name={rule.name}
            status={<EnabledBadge enabled={rule.status === "enabled"} />}
            fields={[
              { label: "감지 센서", value: `${rule.sourceCount}개` },
              { label: "제어 조명", value: `${rule.targetCount}개` },
              { label: "밝기", value: rule.action.dimmingEnabled ? `${rule.action.brightnessPercent}%` : "디밍 OFF · 100%" },
              { label: "유지", value: `${rule.holdSeconds}초` },
              { label: "Gateway 동기화", value: <SyncBadge status={rule.syncStatus} /> },
              { label: "최근 감지", value: <DetectionBadge rule={rule} timeZone={dashboard?.site.timeZone ?? "UTC"} wrap /> }
            ]}
            actions={renderActions(rule)}
          />)}
        </div> : <AutomationRuleTable label="차량 이벤트 목록">
            <thead><tr><th className={automationTableHeadingClassName}>이름</th><th className={automationTableHeadingClassName}>활성</th><th className={automationTableHeadingClassName}>감지 센서</th><th className={automationTableHeadingClassName}>제어 조명</th><th className={automationTableHeadingClassName}>밝기</th><th className={automationTableHeadingClassName}>유지</th><th className={automationTableHeadingClassName}>Gateway 동기화</th><th className={automationTableHeadingClassName}>최근 감지</th>{canManage ? <th className={automationTableHeadingClassName} aria-label="관리" /> : null}</tr></thead>
            <tbody>
              {rules.map((rule, index) => {
                const isLastRow = index === rules.length - 1;
                return <tr key={rule.id}>
                <td className={automationTableCellClassName(isLastRow)}><strong className="block max-w-48 truncate">{rule.name}</strong></td>
                <td className={automationTableCellClassName(isLastRow)}><EnabledBadge enabled={rule.status === "enabled"} /></td>
                <td className={automationTableCellClassName(isLastRow)}>{rule.sourceCount}개</td>
                <td className={automationTableCellClassName(isLastRow)}>{rule.targetCount}개</td>
                <td className={automationTableCellClassName(isLastRow)}>{rule.action.dimmingEnabled ? `${rule.action.brightnessPercent}%` : "디밍 OFF · 100%"}</td>
                <td className={automationTableCellClassName(isLastRow)}>{rule.holdSeconds}초</td>
                <td className={automationTableCellClassName(isLastRow)}><SyncBadge status={rule.syncStatus} /></td>
                <td className={automationTableCellClassName(isLastRow)}><DetectionBadge rule={rule} timeZone={dashboard?.site.timeZone ?? "UTC"} /></td>
                {canManage ? <td className={automationTableCellClassName(isLastRow)}>{renderActions(rule)}</td> : null}
              </tr>;
              })}
            </tbody>
        </AutomationRuleTable> : <FeedbackState icon={CarFront} title="등록된 이벤트 규칙이 없습니다." description="감지 센서와 제어 조명을 연결해 차량 이벤트 대응을 시작할 수 있습니다." />
      ) : null}
      {rulesQuery.hasNextPage && !isAuthBlocked ? <Button variant="secondary" className="justify-self-center" type="button" disabled={rulesQuery.isFetchingNextPage} onClick={() => void loadNextPage()}>{rulesQuery.isFetchingNextPage ? "불러오는 중" : "더 보기"}</Button> : null}
      {dashboard ? <VehicleEventDialog open={dialogOpen && !isAuthBlocked} rule={editingRule} dashboard={dashboard} isPending={saveMutation.isPending} serverError={mutationError} returnFocusRef={dialogReturnFocusRef} onClose={() => { if (!saveMutation.isPending) setDialogOpen(false); }} onSubmit={save} /> : null}
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
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(rule.lastDetection.occurredAt))
    : "최근 감지 없음";
  return <StatusBadge tone={rule.lastDetection ? "info" : "neutral"} icon={rule.lastDetection ? CarFront : Clock3} className={wrap ? "max-w-full whitespace-normal break-words" : undefined}>{label}</StatusBadge>;
}
