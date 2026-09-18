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
import { Button, ConfirmDialog, FeedbackState, PageHeader, StatusBadge, Text } from "../../../components/ui";
import { VehicleEventDialog } from "./VehicleEventDialog";
import {
  AutomationRuleTable,
  automationTableCellClassName,
  automationTableHeadingClassName
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
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const scope = useRef({ key: scopeKey, generation: 0 });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 };
  const scopeGeneration = scope.current.generation;
  const [editingRule, setEditingRule] = useState<VehicleEventRuleResponse | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogReturnFocusRef = useRef<HTMLElement | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<VehicleEventRuleResponse | null>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
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
    dialogReturnFocusRef.current = addButtonRef.current;
    setMutationError("");
    setMessage("");
    setDialogOpen(true);
  }

  function beginEdit(rule: VehicleEventRuleResponse, opener: HTMLElement) {
    setEditingRule(rule);
    dialogReturnFocusRef.current = opener;
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
    <div id="control-mode-panel-event" className="grid min-w-0 content-start gap-4 tablet:min-h-0 tablet:flex-1 tablet:overflow-y-auto" role="tabpanel" aria-labelledby="control-mode-event" data-control-automation-panel="event">
      <PageHeader
        title="이벤트 제어"
        headingLevel={3}
        description="Gateway가 차량 센서 감지를 현장 조명 규칙으로 즉시 연결합니다."
        actions={canManage ? <Button ref={addButtonRef} variant="primary" type="button" onClick={beginAdd} disabled={isMutating || !dashboard}><CarFront size={16} aria-hidden="true" /> 이벤트 추가</Button> : undefined}
      />
      {!canManage ? <p className="m-0 border-l-4 border-status-warning-border bg-status-warning-background px-3 py-2.5 text-body-sm font-bold text-status-warning-foreground" role="status" data-control-readonly-notice="">조회 전용 계정입니다. 이벤트 규칙과 Gateway 적용 상태만 확인할 수 있습니다.</p> : null}
      {rulesQuery.isLoading ? <FeedbackState icon={Clock3} title="이벤트 규칙을 불러오는 중입니다." /> : null}
      {queryFailure ? <QueryError message={queryFailure.message} onRetry={() => void queryFailure.retry()} label={queryFailure.retryLabel} isBackground={rulesQuery.isRefetchError && !isScheduleUnauthorized(rulesQuery.error)} /> : null}
      {!rulesQuery.isLoading && !rulesQuery.isLoadingError ? (
        rules.length > 0 ? <AutomationRuleTable label="차량 이벤트 목록">
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
                {canManage ? <td className={automationTableCellClassName(isLastRow)}><div className="grid grid-cols-3 gap-1.5" data-schedule-row-actions="">
                  <Button variant="ghost" className="w-11 p-0" type="button" aria-label={`${rule.name} ${rule.status === "enabled" ? "비활성화" : "활성화"}`} title={rule.status === "enabled" ? "비활성화" : "활성화"} disabled={isMutating} onClick={() => toggle(rule)}>{rule.status === "enabled" ? <PowerOff size={15} aria-hidden="true" /> : <Power size={15} aria-hidden="true" />}</Button>
                  <Button variant="ghost" className="w-11 p-0" type="button" aria-label={`${rule.name} 수정`} title="수정" disabled={isMutating} onClick={(event) => beginEdit(rule, event.currentTarget)}><Pencil size={15} aria-hidden="true" /></Button>
                  <Button variant="danger" className="w-11 p-0" type="button" aria-label={`${rule.name} 삭제`} title="삭제" disabled={isMutating} onClick={(event) => { setDeleteCandidate(rule); deleteReturnFocusRef.current = event.currentTarget; setMutationError(""); }}><Trash2 size={15} aria-hidden="true" /></Button>
                </div></td> : null}
              </tr>;
              })}
            </tbody>
        </AutomationRuleTable> : <FeedbackState icon={CarFront} title="등록된 이벤트 규칙이 없습니다." description="감지 센서와 제어 조명을 연결해 차량 이벤트 대응을 시작할 수 있습니다." />
      ) : null}
      {rulesQuery.hasNextPage ? <Button variant="secondary" className="justify-self-center" type="button" disabled={rulesQuery.isFetchingNextPage} onClick={() => void rulesQuery.fetchNextPage()}>{rulesQuery.isFetchingNextPage ? "불러오는 중" : "더 보기"}</Button> : null}
      {message ? <Text tone="success" role="status">{message}</Text> : null}
      {mutationError && !dialogOpen && !deleteCandidate ? <Text tone="danger" role="alert">{mutationError}</Text> : null}
      {dashboard ? <VehicleEventDialog open={dialogOpen} rule={editingRule} dashboard={dashboard} isPending={saveMutation.isPending} serverError={mutationError} returnFocusRef={dialogReturnFocusRef} onClose={() => { if (!saveMutation.isPending) setDialogOpen(false); }} onSubmit={save} /> : null}
      <ConfirmDialog isOpen={Boolean(deleteCandidate)} title="이벤트 규칙 삭제" description={deleteCandidate ? `${deleteCandidate.name} 규칙을 삭제합니다.` : undefined} confirmLabel="삭제" tone="danger" isPending={removeMutation.isPending} returnFocusRef={deleteReturnFocusRef} fallbackFocusRef={addButtonRef} onCancel={() => { if (!removeMutation.isPending) setDeleteCandidate(null); }} onConfirm={remove}>
        {mutationError ? <Text tone="danger" role="alert">{mutationError}</Text> : null}
      </ConfirmDialog>
    </div>
  );
}

function QueryError({ message, onRetry, label, isBackground }: { message: string; onRetry: () => void; label: string; isBackground: boolean }) {
  return <FeedbackState tone={isBackground ? "warning" : "danger"} liveRole="alert" icon={TriangleAlert} title={message} action={<Button variant="secondary" type="button" onClick={onRetry}>{label}</Button>} />;
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
