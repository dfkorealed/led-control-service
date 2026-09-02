import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CarFront, CircleCheck, Clock3, Pencil, Power, PowerOff, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { authMeQueryKey } from "../../../api/principal-cache";
import type { Dashboard } from "../../../api/queries";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Button, PageHeader, StatusBadge } from "../../../components/ui";
import { VehicleEventDialog } from "./VehicleEventDialog";

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
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const scope = useRef({ key: scopeKey, generation: 0 });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 };
  const scopeGeneration = scope.current.generation;
  const [editingRule, setEditingRule] = useState<VehicleEventRuleResponse | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogReturnFocus, setDialogReturnFocus] = useState<HTMLElement | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<VehicleEventRuleResponse | null>(null);
  const [deleteReturnFocus, setDeleteReturnFocus] = useState<HTMLElement | null>(null);
  const [message, setMessage] = useState("");
  const [mutationError, setMutationError] = useState("");
  const canManage = role === "admin";
  const rulesQuery = useInfiniteQuery({
    queryKey: vehicleEventRuleQueryKey(siteId),
    queryFn: ({ pageParam }) => listVehicleEventRules(siteId, { limit: 100, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 3000
  });
  const rules = rulesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const queryFailure = rulesQuery.isLoadingError
    ? {
        message: isScheduleUnauthorized(rulesQuery.error) ? "로그인 세션이 만료되었습니다." : "이벤트 규칙 목록을 불러오지 못했습니다.",
        retryLabel: "다시 시도",
        retry: () => rulesQuery.refetch()
      }
    : rulesQuery.isFetchNextPageError
      ? {
          message: isScheduleUnauthorized(rulesQuery.error) ? "로그인 세션이 만료되었습니다." : "다음 이벤트 규칙을 불러오지 못했습니다.",
          retryLabel: "다음 페이지 다시 시도",
          retry: () => rulesQuery.fetchNextPage()
        }
      : rulesQuery.isRefetchError
        ? {
            message: isScheduleUnauthorized(rulesQuery.error) ? "로그인 세션이 만료되었습니다." : "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
            retryLabel: "상태 다시 조회",
            retry: () => rulesQuery.refetch()
          }
        : null;
  // Mutation-level callbacks survive observer unmount; per-call callbacks below only update scoped UI state.
  const saveMutation = useMutation({
    mutationFn: ({ operationSiteId, ruleId, input }: { operationSiteId: string; ruleId: string | null; input: CreateVehicleEventRuleInput }) => ruleId
      ? updateVehicleEventRule(operationSiteId, ruleId, input)
      : createVehicleEventRule(operationSiteId, input),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error) => expirePrincipal(error)
  });
  const toggleMutation = useMutation({
    mutationFn: ({ operationSiteId, ruleId, status }: { operationSiteId: string; ruleId: string; status: "enabled" | "disabled" }) =>
      updateVehicleEventRule(operationSiteId, ruleId, { status }),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error) => expirePrincipal(error)
  });
  const removeMutation = useMutation({
    mutationFn: ({ operationSiteId, ruleId }: { operationSiteId: string; ruleId: string }) => deleteVehicleEventRule(operationSiteId, ruleId),
    onSuccess: (_result, variables) => invalidate(variables.operationSiteId),
    onError: (error) => expirePrincipal(error)
  });
  const isMutating = saveMutation.isPending || toggleMutation.isPending || removeMutation.isPending;

  useEffect(() => {
    setEditingRule(null);
    setDialogOpen(false);
    setDeleteCandidate(null);
    setMessage("");
    setMutationError("");
  }, [scopeKey]);

  useEffect(() => {
    expirePrincipal(rulesQuery.error);
  }, [rulesQuery.error, rulesQuery.errorUpdatedAt, scopeGeneration, scopeKey]);

  function isCurrent(operationScope: string, operationGeneration: number) {
    return scope.current.key === operationScope && scope.current.generation === operationGeneration;
  }

  function expirePrincipal(error: unknown) {
    if (!isScheduleUnauthorized(error)) return;
    void queryClient.invalidateQueries({ queryKey: authMeQueryKey });
  }

  function invalidate(operationSiteId: string) {
    void queryClient.invalidateQueries({ queryKey: vehicleEventRuleQueryKey(operationSiteId) });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  function beginAdd() {
    setEditingRule(null);
    setDialogReturnFocus(addButtonRef.current);
    setMutationError("");
    setMessage("");
    setDialogOpen(true);
  }

  function beginEdit(rule: VehicleEventRuleResponse, opener: HTMLElement) {
    setEditingRule(rule);
    setDialogReturnFocus(opener);
    setMutationError("");
    setMessage("");
    setDialogOpen(true);
  }

  function save(input: CreateVehicleEventRuleInput) {
    const operationScope = scopeKey;
    const operationGeneration = scopeGeneration;
    const ruleId = editingRule?.id ?? null;
    setMutationError("");
    saveMutation.mutate({ operationSiteId: siteId, ruleId, input }, {
      onSuccess: () => {
        if (!isCurrent(operationScope, operationGeneration)) return;
        setDialogOpen(false);
        setEditingRule(null);
        setMessage(ruleId ? "이벤트 규칙을 수정했습니다." : "이벤트 규칙을 만들었습니다. Gateway 적용 상태를 확인해 주세요.");
      },
      onError: (error) => {
        if (!isCurrent(operationScope, operationGeneration)) return;
        setMutationError(vehicleEventMutationErrorMessage(error));
      }
    });
  }

  function toggle(rule: VehicleEventRuleResponse) {
    const operationScope = scopeKey;
    const operationGeneration = scopeGeneration;
    const status = rule.status === "enabled" ? "disabled" : "enabled";
    setMessage("");
    setMutationError("");
    toggleMutation.mutate({ operationSiteId: siteId, ruleId: rule.id, status }, {
      onSuccess: () => {
        if (isCurrent(operationScope, operationGeneration)) setMessage(status === "enabled" ? "이벤트 규칙을 활성화했습니다." : "이벤트 규칙을 비활성화했습니다.");
      },
      onError: (error) => {
        if (!isCurrent(operationScope, operationGeneration)) return;
        setMutationError(vehicleEventMutationErrorMessage(error));
      }
    });
  }

  function remove() {
    if (!deleteCandidate) return;
    const operationScope = scopeKey;
    const operationGeneration = scopeGeneration;
    const ruleId = deleteCandidate.id;
    setMutationError("");
    removeMutation.mutate({ operationSiteId: siteId, ruleId }, {
      onSuccess: () => {
        if (!isCurrent(operationScope, operationGeneration)) return;
        setDeleteCandidate(null);
        setMessage("이벤트 규칙을 삭제했습니다.");
      },
      onError: (error) => {
        if (!isCurrent(operationScope, operationGeneration)) return;
        setMutationError(vehicleEventMutationErrorMessage(error));
      }
    });
  }

  return (
    <div id="control-mode-panel-event" className="schedule-control-panel" role="tabpanel" aria-labelledby="control-mode-event">
      <PageHeader
        title="이벤트 제어"
        headingLevel={3}
        description="Gateway가 차량 센서 감지를 현장 조명 규칙으로 즉시 연결합니다."
        actions={canManage ? <Button ref={addButtonRef} variant="primary" className="schedule-add-button" type="button" onClick={beginAdd} disabled={isMutating || !dashboard}><CarFront size={16} aria-hidden="true" /> 이벤트 추가</Button> : undefined}
      />
      {!canManage ? <p className="schedule-readonly-notice" role="status">조회 전용 계정입니다. 이벤트 규칙과 Gateway 적용 상태만 확인할 수 있습니다.</p> : null}
      {rulesQuery.isLoading ? <p className="muted-text" role="status">이벤트 규칙을 불러오는 중입니다.</p> : null}
      {queryFailure ? <QueryError message={queryFailure.message} onRetry={() => void queryFailure.retry()} label={queryFailure.retryLabel} /> : null}
      {!rulesQuery.isLoading && !rulesQuery.isLoadingError ? (
        <div className="schedule-table-wrap">
          <table className="schedule-table">
            <thead><tr><th>이름</th><th>활성</th><th>감지 센서</th><th>제어 조명</th><th>밝기</th><th>유지</th><th>Gateway 동기화</th><th>최근 감지</th>{canManage ? <th><span className="sr-only">관리</span></th> : null}</tr></thead>
            <tbody>
              {rules.map((rule) => <tr key={rule.id}>
                <td><strong>{rule.name}</strong></td>
                <td><EnabledBadge enabled={rule.status === "enabled"} /></td>
                <td>{rule.sourceCount}개</td>
                <td>{rule.targetCount}개</td>
                <td>{rule.action.dimmingEnabled ? `${rule.action.brightnessPercent}%` : "디밍 OFF · 100%"}</td>
                <td>{rule.holdSeconds}초</td>
                <td><SyncBadge status={rule.syncStatus} /></td>
                <td><DetectionBadge rule={rule} timeZone={dashboard?.site.timeZone ?? "UTC"} /></td>
                {canManage ? <td><div className="schedule-row-actions">
                  <Button variant="ghost" type="button" aria-label={`${rule.name} ${rule.status === "enabled" ? "비활성화" : "활성화"}`} title={rule.status === "enabled" ? "비활성화" : "활성화"} disabled={isMutating} onClick={() => toggle(rule)}>{rule.status === "enabled" ? <PowerOff size={15} aria-hidden="true" /> : <Power size={15} aria-hidden="true" />}</Button>
                  <Button variant="ghost" type="button" aria-label={`${rule.name} 수정`} title="수정" disabled={isMutating} onClick={(event) => beginEdit(rule, event.currentTarget)}><Pencil size={15} aria-hidden="true" /></Button>
                  <Button variant="danger" className="danger-action" type="button" aria-label={`${rule.name} 삭제`} title="삭제" disabled={isMutating} onClick={(event) => { setDeleteCandidate(rule); setDeleteReturnFocus(event.currentTarget); setMutationError(""); }}><Trash2 size={15} aria-hidden="true" /></Button>
                </div></td> : null}
              </tr>)}
              {rules.length === 0 ? <tr><td className="schedule-table-empty" colSpan={canManage ? 9 : 8}>등록된 이벤트 규칙이 없습니다.</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}
      {rulesQuery.hasNextPage ? <Button variant="secondary" className="control-load-more" type="button" disabled={rulesQuery.isFetchingNextPage} onClick={() => void rulesQuery.fetchNextPage()}>{rulesQuery.isFetchingNextPage ? "불러오는 중" : "더 보기"}</Button> : null}
      {message ? <p className="success-text schedule-panel-message" role="status">{message}</p> : null}
      {mutationError && !dialogOpen && !deleteCandidate ? <p className="danger-text schedule-panel-message" role="alert">{mutationError}</p> : null}
      {dashboard ? <VehicleEventDialog open={dialogOpen} rule={editingRule} dashboard={dashboard} isPending={saveMutation.isPending} serverError={mutationError} returnFocusElement={dialogReturnFocus} onClose={() => { if (!saveMutation.isPending) setDialogOpen(false); }} onSubmit={save} /> : null}
      <ConfirmDialog open={Boolean(deleteCandidate)} title="이벤트 규칙 삭제" description={deleteCandidate ? `${deleteCandidate.name} 규칙을 삭제합니다.` : undefined} confirmLabel="삭제" destructive isPending={removeMutation.isPending} returnFocusElement={deleteReturnFocus} fallbackFocusElement={addButtonRef.current} onClose={() => { if (!removeMutation.isPending) setDeleteCandidate(null); }} onConfirm={remove}>
        {mutationError ? <p className="danger-text" role="alert">{mutationError}</p> : null}
      </ConfirmDialog>
    </div>
  );
}

function QueryError({ message, onRetry, label }: { message: string; onRetry: () => void; label: string }) {
  return <div className="schedule-query-error" role="alert"><p className="danger-text">{message}</p><Button variant="secondary" type="button" onClick={onRetry}>{label}</Button></div>;
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

function DetectionBadge({ rule, timeZone }: { rule: VehicleEventRuleResponse; timeZone: string }) {
  const label = rule.lastDetection
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(rule.lastDetection.occurredAt))
    : "최근 감지 없음";
  return <StatusBadge tone={rule.lastDetection ? "info" : "neutral"} icon={rule.lastDetection ? CarFront : Clock3}>{label}</StatusBadge>;
}
