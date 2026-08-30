import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  scheduleMutationErrorMessage,
  scheduleQueryKey,
  updateSchedule,
  type CreateScheduleInput,
  type ScheduleResponse
} from "../../../api/automation";
import type { AuthUser } from "../../../api/auth";
import type { Dashboard } from "../../../api/queries";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
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
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
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
    setScheduleDialogOpen(false);
    setEditingSchedule(null);
    setDeleteCandidate(null);
    setMessage("");
    setMutationError("");
  }, [scopeKey]);

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
    const scheduleId = editingSchedule?.id ?? null;
    setMutationError("");
    saveMutation.mutate({ scheduleId, input }, {
      onSuccess: () => {
        invalidate();
        if (currentScope.current !== operationScope) return;
        setScheduleDialogOpen(false);
        setEditingSchedule(null);
        setMessage(scheduleId ? "스케줄을 수정했습니다." : "스케줄을 만들었습니다. Gateway 적용 상태를 확인해 주세요.");
      },
      onError: (error) => {
        if (currentScope.current === operationScope) setMutationError(scheduleMutationErrorMessage(error));
      }
    });
  }

  function toggle(schedule: ScheduleResponse) {
    const operationScope = scopeKey;
    const status = schedule.status === "enabled" ? "disabled" : "enabled";
    setMutationError("");
    setMessage("");
    toggleMutation.mutate({ scheduleId: schedule.id, status }, {
      onSuccess: () => {
        invalidate();
        if (currentScope.current === operationScope) {
          setMessage(status === "enabled" ? "스케줄을 활성화했습니다." : "스케줄을 비활성화했습니다.");
        }
      },
      onError: (error) => {
        if (currentScope.current === operationScope) setMutationError(scheduleMutationErrorMessage(error));
      }
    });
  }

  function remove() {
    if (!deleteCandidate) return;
    const operationScope = scopeKey;
    const scheduleId = deleteCandidate.id;
    setMutationError("");
    removeMutation.mutate(scheduleId, {
      onSuccess: () => {
        invalidate();
        if (currentScope.current !== operationScope) return;
        setDeleteCandidate(null);
        setMessage("스케줄을 삭제했습니다.");
      },
      onError: (error) => {
        if (currentScope.current === operationScope) setMutationError(scheduleMutationErrorMessage(error));
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
      <div className="schedule-panel-heading">
        <div>
          <span className="eyebrow">Gateway 자동 실행</span>
          <h2>스케줄 제어</h2>
        </div>
        {canManage ? (
          <button
            ref={addButtonRef}
            className="primary-button"
            type="button"
            onClick={beginAdd}
            disabled={isMutating || !dashboard}
            title={dashboard ? "새 스케줄 추가" : "제어 대상 정보를 불러오는 중입니다"}
          >
            <CalendarPlus size={16} aria-hidden="true" /> 스케줄 추가
          </button>
        ) : null}
      </div>

      {!canManage ? (
        <p className="schedule-readonly-notice" role="status">
          조회 전용 계정입니다. 스케줄 목록과 Gateway 적용 상태만 확인할 수 있습니다.
        </p>
      ) : null}

      {schedulesQuery.isLoading ? <p className="muted-text" role="status">스케줄을 불러오는 중입니다.</p> : null}
      {schedulesQuery.error && schedules.length === 0 ? (
        <div className="schedule-query-error" role="alert">
          <p className="danger-text">스케줄 목록을 불러오지 못했습니다.</p>
          <button type="button" onClick={() => void schedulesQuery.refetch()}>다시 시도</button>
        </div>
      ) : null}

      {!schedulesQuery.isLoading && !(schedulesQuery.error && schedules.length === 0) ? (
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
                  <td>{schedule.status === "enabled" ? "활성" : "비활성"}</td>
                  <td>{formatNextOccurrence(schedule, dashboard?.site.timeZone ?? "UTC")}</td>
                  <td>{formatRecurrence(schedule)}</td>
                  <td>{schedule.action.dimmingEnabled ? `${schedule.action.brightnessPercent}%` : "디밍 OFF · 100%"}</td>
                  <td>{schedule.targetCount}개</td>
                  <td><SyncBadge status={schedule.syncStatus} /></td>
                  <td>{formatLastExecution(schedule, dashboard?.site.timeZone ?? "UTC")}</td>
                  {canManage ? (
                    <td>
                      <div className="schedule-row-actions">
                        <button
                          type="button"
                          aria-label={`${schedule.name} ${schedule.status === "enabled" ? "비활성화" : "활성화"}`}
                          title={schedule.status === "enabled" ? "비활성화" : "활성화"}
                          disabled={isMutating}
                          onClick={() => toggle(schedule)}
                        >
                          {schedule.status === "enabled"
                            ? <PowerOff size={16} aria-hidden="true" />
                            : <Power size={16} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          aria-label={`${schedule.name} 수정`}
                          title="수정"
                          disabled={isMutating || !dashboard}
                          onClick={(event) => beginEdit(schedule, event.currentTarget)}
                        >
                          <Pencil size={16} aria-hidden="true" />
                        </button>
                        <button
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
                        </button>
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

      {schedulesQuery.hasNextPage ? (
        <button
          className="control-load-more"
          type="button"
          disabled={schedulesQuery.isFetchingNextPage}
          onClick={() => void schedulesQuery.fetchNextPage()}
        >
          {schedulesQuery.isFetchingNextPage ? "불러오는 중" : "스케줄 더 보기"}
        </button>
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
    ? { label: "Gateway 적용됨", className: "applied" }
    : status === "REJECTED"
      ? { label: "Gateway 적용 실패", className: "rejected" }
      : { label: "Gateway 동기화 중", className: "pending" };
  return <span className={`schedule-sync-badge ${presentation.className}`}>{presentation.label}</span>;
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
  return `${labels[schedule.lastExecution.kind]} · ${formatDateTime(schedule.lastExecution.occurredAt, timeZone)}`;
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
