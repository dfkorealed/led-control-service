import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { automationExecutionActionResultPayloadV1Schema } from "@led-control/shared/automation-contracts";
import { CalendarPlus, CircleCheck, Clock3, Pencil, Power, PowerOff, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  type ScheduleResponse
} from "../../../api/automation";
import type { AuthUser } from "../../../api/auth";
import { authMeQueryKey } from "../../../api/principal-cache";
import type { Dashboard } from "../../../api/queries";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { Button, PageHeader, StatusBadge } from "../../../components/ui";
import { ScheduleDialog } from "./ScheduleDialog";

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
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const currentScope = useRef({ key: scopeKey, generation: 0 });
  if (currentScope.current.key !== scopeKey) {
    currentScope.current = { key: scopeKey, generation: currentScope.current.generation + 1 };
  }
  const currentScopeGeneration = currentScope.current.generation;
  const expiredPrincipalGeneration = useRef<number | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleResponse | null>(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [dialogReturnFocus, setDialogReturnFocus] = useState<HTMLElement | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<ScheduleResponse | null>(null);
  const [deleteReturnFocus, setDeleteReturnFocus] = useState<HTMLElement | null>(null);
  const [message, setMessage] = useState("");
  const [mutationError, setMutationError] = useState("");
  const canManage = role === "admin";
  const schedulesQuery = useInfiniteQuery({
    queryKey: scheduleQueryKey(siteId),
    queryFn: ({ pageParam }) => listSchedules(siteId, {
      limit: 100,
      ...(pageParam ? { cursor: pageParam } : {})
    }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 3000
  });
  const schedules = schedulesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const queryFailure = schedulesQuery.isLoadingError
    ? {
        message: scheduleQueryErrorMessage(schedulesQuery.error),
        retryLabel: "다시 시도",
        retry: () => schedulesQuery.refetch()
      }
    : schedulesQuery.isFetchNextPageError
      ? {
          message: isScheduleUnauthorized(schedulesQuery.error)
            ? scheduleQueryErrorMessage(schedulesQuery.error)
            : "다음 스케줄을 불러오지 못했습니다.",
          retryLabel: "다음 페이지 다시 시도",
          retry: () => schedulesQuery.fetchNextPage()
        }
      : schedulesQuery.isRefetchError
        ? {
            message: isScheduleUnauthorized(schedulesQuery.error)
              ? scheduleQueryErrorMessage(schedulesQuery.error)
              : "Gateway 적용 상태를 새로고침하지 못했습니다. 표시된 상태가 최신이 아닐 수 있습니다.",
            retryLabel: "상태 다시 조회",
            retry: () => schedulesQuery.refetch()
          }
        : null;

  const saveMutation = useMutation({
    mutationFn: ({ scheduleId, input }: { scheduleId: string | null; input: CreateScheduleInput }) => scheduleId
      ? updateSchedule(siteId, scheduleId, input)
      : createSchedule(siteId, input)
  });
  const toggleMutation = useMutation({
    mutationFn: ({ scheduleId, status }: { scheduleId: string; status: "enabled" | "disabled" }) =>
      updateSchedule(siteId, scheduleId, { status })
  });
  const removeMutation = useMutation({
    mutationFn: (scheduleId: string) => deleteSchedule(siteId, scheduleId)
  });
  const isMutating = saveMutation.isPending || toggleMutation.isPending || removeMutation.isPending;

  useEffect(() => {
    expiredPrincipalGeneration.current = null;
    setScheduleDialogOpen(false);
    setEditingSchedule(null);
    setDeleteCandidate(null);
    setMessage("");
    setMutationError("");
  }, [scopeKey]);

  useEffect(() => {
    expirePrincipal(schedulesQuery.error, scopeKey, currentScopeGeneration);
  }, [currentScopeGeneration, schedulesQuery.error, schedulesQuery.errorUpdatedAt, scopeKey]);

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

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: scheduleQueryKey(siteId) });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  function beginAdd() {
    setEditingSchedule(null);
    setDialogReturnFocus(addButtonRef.current);
    setMutationError("");
    setMessage("");
    setScheduleDialogOpen(true);
  }

  function beginEdit(schedule: ScheduleResponse, opener: HTMLElement) {
    setEditingSchedule(schedule);
    setDialogReturnFocus(opener);
    setMutationError("");
    setMessage("");
    setScheduleDialogOpen(true);
  }

  function save(input: CreateScheduleInput) {
    const operationScope = scopeKey;
    const operationGeneration = currentScopeGeneration;
    const scheduleId = editingSchedule?.id ?? null;
    setMutationError("");
    saveMutation.mutate({ scheduleId, input }, {
      onSuccess: () => {
        invalidate();
        if (!isCurrentOperation(operationScope, operationGeneration)) return;
        setScheduleDialogOpen(false);
        setEditingSchedule(null);
        setMessage(scheduleId ? "스케줄을 수정했습니다." : "스케줄을 만들었습니다. Gateway 적용 상태를 확인해 주세요.");
      },
      onError: (error) => {
        if (!isCurrentOperation(operationScope, operationGeneration)) return;
        expirePrincipal(error, operationScope, operationGeneration);
        setMutationError(scheduleMutationErrorMessage(error));
      }
    });
  }

  function toggle(schedule: ScheduleResponse) {
    const operationScope = scopeKey;
    const operationGeneration = currentScopeGeneration;
    const status = schedule.status === "enabled" ? "disabled" : "enabled";
    setMutationError("");
    setMessage("");
    toggleMutation.mutate({ scheduleId: schedule.id, status }, {
      onSuccess: () => {
        invalidate();
        if (isCurrentOperation(operationScope, operationGeneration)) {
          setMessage(status === "enabled" ? "스케줄을 활성화했습니다." : "스케줄을 비활성화했습니다.");
        }
      },
      onError: (error) => {
        if (!isCurrentOperation(operationScope, operationGeneration)) return;
        expirePrincipal(error, operationScope, operationGeneration);
        setMutationError(scheduleMutationErrorMessage(error));
      }
    });
  }

  function remove() {
    if (!deleteCandidate) return;
    const operationScope = scopeKey;
    const operationGeneration = currentScopeGeneration;
    const scheduleId = deleteCandidate.id;
    setMutationError("");
    removeMutation.mutate(scheduleId, {
      onSuccess: () => {
        invalidate();
        if (!isCurrentOperation(operationScope, operationGeneration)) return;
        setDeleteCandidate(null);
        setMessage("스케줄을 삭제했습니다.");
      },
      onError: (error) => {
        if (!isCurrentOperation(operationScope, operationGeneration)) return;
        expirePrincipal(error, operationScope, operationGeneration);
        setMutationError(scheduleMutationErrorMessage(error));
      }
    });
  }

  return (
    <div
      id="control-mode-panel-schedule"
      className="schedule-control-panel"
      role="tabpanel"
      aria-labelledby="control-mode-schedule"
    >
      <PageHeader
        title="스케줄 제어"
        description="Gateway가 현장 시간대에 맞춰 반복 밝기 규칙을 실행합니다."
        actions={canManage ? (
          <button
            ref={addButtonRef}
            className="ui-button ui-button-primary schedule-add-button"
            type="button"
            onClick={beginAdd}
            disabled={isMutating || !dashboard}
            title={dashboard ? "새 스케줄 추가" : "제어 대상 정보를 불러오는 중입니다"}
          >
            <CalendarPlus size={16} aria-hidden="true" /> 스케줄 추가
          </button>
        ) : undefined}
      />

      {!canManage ? (
        <p className="schedule-readonly-notice" role="status">
          조회 전용 계정입니다. 스케줄 목록과 Gateway 적용 상태만 확인할 수 있습니다.
        </p>
      ) : null}

      {schedulesQuery.isLoading ? <p className="muted-text" role="status">스케줄을 불러오는 중입니다.</p> : null}
      {queryFailure ? (
        <div className="schedule-query-error" role="alert">
          <p className="danger-text">{queryFailure.message}</p>
          <Button variant="secondary" type="button" onClick={() => void queryFailure.retry()}>{queryFailure.retryLabel}</Button>
        </div>
      ) : null}

      {!schedulesQuery.isLoading && !schedulesQuery.isLoadingError ? (
        <div className="schedule-table-wrap">
          <table className="schedule-table">
            <thead>
              <tr>
                <th>이름</th>
                <th>활성</th>
                <th>다음 실행</th>
                <th>반복 · 시간</th>
                <th>밝기</th>
                <th>대상</th>
                <th>Gateway 동기화</th>
                <th>최근 결과</th>
                {canManage ? <th><span className="sr-only">관리</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td>
                    <strong>{schedule.name}</strong>
                    <small>{formatActivePeriod(schedule, dashboard?.site.timeZone ?? "UTC")}</small>
                  </td>
                  <td><EnabledBadge enabled={schedule.status === "enabled"} /></td>
                  <td>{formatNextOccurrence(schedule, dashboard?.site.timeZone ?? "UTC")}</td>
                  <td>{formatRecurrence(schedule)}</td>
                  <td>{schedule.action.dimmingEnabled ? `${schedule.action.brightnessPercent}%` : "디밍 OFF · 100%"}</td>
                  <td>{schedule.targetCount}개</td>
                  <td><SyncBadge status={schedule.syncStatus} /></td>
                  <td><LastExecutionBadge schedule={schedule} timeZone={dashboard?.site.timeZone ?? "UTC"} /></td>
                  {canManage ? (
                    <td>
                      <div className="schedule-row-actions">
                        <Button
                          variant="ghost"
                          type="button"
                          aria-label={`${schedule.name} ${schedule.status === "enabled" ? "비활성화" : "활성화"}`}
                          title={schedule.status === "enabled" ? "비활성화" : "활성화"}
                          disabled={isMutating}
                          onClick={() => toggle(schedule)}
                        >
                          {schedule.status === "enabled"
                            ? <PowerOff size={16} aria-hidden="true" />
                            : <Power size={16} aria-hidden="true" />}
                        </Button>
                        <Button
                          variant="ghost"
                          type="button"
                          aria-label={`${schedule.name} 수정`}
                          title="수정"
                          disabled={isMutating || !dashboard}
                          onClick={(event) => beginEdit(schedule, event.currentTarget)}
                        >
                          <Pencil size={16} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="danger"
                          className="danger-action"
                          type="button"
                          aria-label={`${schedule.name} 삭제`}
                          title="삭제"
                          disabled={isMutating}
                          onClick={(event) => {
                            setDeleteReturnFocus(event.currentTarget);
                            setDeleteCandidate(schedule);
                            setMutationError("");
                            setMessage("");
                          }}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
              {schedules.length === 0 ? (
                <tr><td className="schedule-table-empty" colSpan={canManage ? 9 : 8}>등록된 스케줄이 없습니다.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {schedulesQuery.hasNextPage && !schedulesQuery.isFetchNextPageError ? (
        <Button
          variant="secondary"
          className="control-load-more"
          type="button"
          disabled={schedulesQuery.isFetchingNextPage}
          onClick={() => void schedulesQuery.fetchNextPage()}
        >
          {schedulesQuery.isFetchingNextPage ? "불러오는 중" : "스케줄 더 보기"}
        </Button>
      ) : null}
      {message ? <p className="success-text schedule-panel-message" role="status">{message}</p> : null}
      {mutationError && !scheduleDialogOpen && !deleteCandidate
        ? <p className="danger-text schedule-panel-message" role="alert">{mutationError}</p>
        : null}

      {dashboard ? (
        <ScheduleDialog
          open={scheduleDialogOpen}
          schedule={editingSchedule}
          dashboard={dashboard}
          isPending={saveMutation.isPending}
          serverError={scheduleDialogOpen ? mutationError : ""}
          returnFocusElement={dialogReturnFocus}
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
        open={Boolean(deleteCandidate)}
        title="스케줄 삭제"
        description={deleteCandidate ? `${deleteCandidate.name} 스케줄을 삭제하시겠습니까?` : undefined}
        confirmLabel="삭제"
        destructive
        isPending={removeMutation.isPending}
        returnFocusElement={deleteReturnFocus}
        fallbackFocusElement={addButtonRef.current}
        onClose={() => {
          if (!removeMutation.isPending) setDeleteCandidate(null);
        }}
        onConfirm={remove}
      >
        {deleteCandidate && mutationError ? <p className="danger-text" role="alert">{mutationError}</p> : null}
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

function LastExecutionBadge({ schedule, timeZone }: { schedule: ScheduleResponse; timeZone: string }) {
  const failed = schedule.lastExecution?.kind === "action_result"
    && !formatActionResult(schedule.lastExecution.payload).startsWith("모두 성공");
  return (
    <StatusBadge tone={failed ? "danger" : schedule.lastExecution ? "info" : "neutral"} icon={failed ? TriangleAlert : Clock3}>
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
