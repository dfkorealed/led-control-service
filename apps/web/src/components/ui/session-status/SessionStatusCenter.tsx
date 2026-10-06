import { Bell, CircleAlert, CircleCheck, Info } from "lucide-react";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Button } from "../Button";
import { ConfirmDialog } from "../ConfirmDialog";
import { DrawerDialog } from "../DrawerDialog";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import { Heading, Text } from "../Typography";
import { cn } from "../utils/cn";
import { formatTimestamp } from "../utils/formatTimestamp";
import { useSessionStatusState } from "./SessionStatusProvider";
import { useMonitoringIncidents } from "./useMonitoringIncidents";
import type { MonitoringIncidentType } from "../../../api/monitoring-incidents";

export interface SessionStatusCenterHandle {
  open(returnFocusTarget?: HTMLElement | null, focusStatusId?: string): void;
}

export interface SessionStatusContextItem {
  id: string;
  title: string;
  description?: string;
  tone: StatusTone;
}

export interface SessionStatusCenterProps {
  compact?: boolean;
  className?: string;
  contextItems?: readonly SessionStatusContextItem[];
  userId?: string;
  siteId?: string;
  timeZone?: string;
}

export const SessionStatusCenter = forwardRef<SessionStatusCenterHandle, SessionStatusCenterProps>(function SessionStatusCenter({ className, compact = false, contextItems = [], userId, siteId, timeZone }, ref) {
  const { statuses, recentNotifications, recentUnreadCount, markRecentRead } = useSessionStatusState();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const bulkTriggerRef = useRef<HTMLButtonElement>(null);
  const alarms = useMonitoringIncidents(userId, siteId, isOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const alarmItemRefs = useRef(new Map<string, HTMLLIElement>());
  const visibleIds = useRef(new Set<string>());
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);
  const pendingFocusStatusIdRef = useRef<string | null>(null);
  const statusItemRefs = useRef(new Map<string, HTMLLIElement>());
  const unresolvedHeadingId = useId();
  const alarmHeadingId = useId();
  // Unknown server counts stay unknown even if the local history is empty.
  const unreadCount = alarms.unreadCount === undefined ? undefined : alarms.unreadCount + (compact ? recentUnreadCount : 0);
  const accessibleLabel = `알람센터, ${!alarms.enabled ? "현장 미선택" : alarms.unreadCount === undefined
    ? alarms.error ? "확인 불가" : "확인 중"
    : `미읽음 ${unreadCount}건${compact ? " (현장 알람과 최근 알림)" : ""}${alarms.isStale ? ", 갱신 실패" : ""}`}`;
  const updateOpenState = (open: boolean) => {
    if (open) returnFocusTargetRef.current ??= triggerRef.current;
    setIsOpen(open);
  };

  useImperativeHandle(ref, () => ({
    open(returnFocusTarget, focusStatusId) {
      returnFocusTargetRef.current = returnFocusTarget ?? triggerRef.current;
      pendingFocusStatusIdRef.current = focusStatusId ?? null;
      setIsOpen(true);
    }
  }), []);

  useEffect(() => {
    if (!isOpen || !pendingFocusStatusIdRef.current) return;
    const statusId = pendingFocusStatusIdRef.current;
    pendingFocusStatusIdRef.current = null;
    const frame = window.requestAnimationFrame(() => statusItemRefs.current.get(statusId)?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, statuses]);

  useEffect(() => {
    setIsOpen(false);
    setConfirmBulk(false);
  }, [userId, siteId]);

  useEffect(() => {
    if (!isOpen || !alarms.documentActive || !alarms.enabled || !dialogRef.current || typeof IntersectionObserver === "undefined") return;
    let observing = true;
    const observer = new IntersectionObserver(entries => {
      if (!observing || document.visibilityState !== "visible" || !document.hasFocus()) return;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.alarmId;
        if (!id) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0) {
          visibleIds.current.add(id);
          void alarms.markRead(id);
        } else visibleIds.current.delete(id);
      }
    }, { root: dialogRef.current, threshold: 0.01 });
    alarmItemRefs.current.forEach(element => observer.observe(element));
    return () => {
      observing = false;
      visibleIds.current.clear();
      observer.disconnect();
    };
  }, [isOpen, alarms.documentActive, alarms.enabled, alarms.incidents, alarms.markRead]);

  return <div className={cn("relative shrink-0", className)}>
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      className="relative min-h-13 min-w-13 p-0"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      onClick={() => {
        if (!isOpen) returnFocusTargetRef.current = triggerRef.current;
        updateOpenState(!isOpen);
      }}
    >
      <Bell size={20} aria-hidden="true" />
      {alarms.enabled && unreadCount !== 0 ? <span
        data-testid="alarm-unread-badge"
        aria-hidden="true"
        className="absolute right-1 top-1 grid min-h-4 min-w-4 place-items-center rounded-pill bg-status-danger-foreground px-1 text-overline text-content-inverse"
      >{unreadCount ?? "?"}</span> : null}
    </Button>
    <DrawerDialog
      ref={dialogRef}
      className="flex min-h-0 flex-col overflow-hidden"
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
      safeArea
      isOpen={isOpen}
      title="알람센터"
      description="선택 현장의 계정별 알람입니다. 화면에 보인 알람만 읽음으로 저장하며 장애 처리 상태는 유지됩니다."
      closeLabel="알람센터 닫기"
      returnFocusElement={returnFocusTargetRef.current ?? triggerRef.current}
      onClose={() => updateOpenState(false)}
      actions={<Button type="button" variant="secondary" onClick={() => updateOpenState(false)}>닫기</Button>}
    >
      <div className="grid gap-5">
        <section className="grid gap-2" aria-label="최근 알림">
          <Heading as="h3" variant="card-title">최근 알림</Heading>
          <Text variant="body-sm" tone="secondary">이 세션의 최근 50개 알림입니다. 읽음은 장애 해결이나 작업 실행을 의미하지 않습니다. 현장·계정 변경 시 초기화됩니다.</Text>
          {recentNotifications.length === 0 ? <Text tone="secondary">최근 알림이 없습니다.</Text> : null}
          <ul className="m-0 grid list-none gap-2 p-0" aria-label="최근 알림 목록">
            {[...recentNotifications].reverse().map(item => <li key={item.id} className="grid gap-2 rounded-control border border-border-default p-3">
              <Text weight="bold">{item.title}</Text>
              {item.description ? <Text variant="body-sm" tone="secondary">{item.description}</Text> : null}
              <StatusBadge icon={item.isRead ? CircleCheck : Bell} tone={item.isRead ? "neutral" : "info"}>{item.isRead ? "읽음" : "미읽음"}</StatusBadge>
              {!item.isRead ? <Button type="button" size="sm" variant="secondary" className="justify-self-start" onClick={() => markRecentRead(item.id)}>읽음으로 표시</Button> : null}
            </li>)}
          </ul>
        </section>
        <section className="grid gap-2" aria-labelledby={alarmHeadingId}>
          <Heading id={alarmHeadingId} as="h3" variant="card-title">현장 알람</Heading>
          {alarms.enabled ? <Button ref={bulkTriggerRef} type="button" variant="secondary" className="justify-self-start"
            isDisabled={alarms.bulkPending || alarms.dismissalPending.size > 0 || alarms.pendingDismissalRequestIds.length > 0}
            onClick={() => setConfirmBulk(true)}>전체 지우기</Button> : null}
          {alarms.bulkError ? <Text role="status" tone="secondary">{alarms.bulkError}</Text> : null}
          {alarms.pendingDismissalRequestIds.map(id => <div key={id} className="grid min-w-0 gap-2">
            <Text variant="body-sm" tone="secondary" className="wrap-anywhere">완료 확인이 필요한 요청: {id}</Text>
            <Button type="button" variant="secondary" isDisabled={alarms.bulkPending || alarms.dismissalPending.size > 0}
              aria-label={`결과 확인 및 다시 시도 ${id}`} onClick={() => void alarms.dismissAll(id)}>결과 확인 및 다시 시도</Button>
          </div>)}
          {!alarms.enabled ? <Text tone="secondary">현장을 선택하면 알람을 확인할 수 있습니다.</Text> : null}
          {alarms.isLoading ? <Text role="status" tone="secondary">알람 확인 중…</Text> : null}
          {alarms.error ? <div className="grid gap-2" role="status">
            <Text tone="secondary">{alarms.isStale ? "알람 갱신 실패 · 마지막으로 확인한 값을 표시합니다." : "알람 확인 불가 · 다시 시도하세요."}</Text>
            <Button type="button" size="sm" variant="secondary" className="justify-self-start" onClick={() => void alarms.refetch()}>알람 다시 조회</Button>
          </div> : null}
          {alarms.enabled && !alarms.isLoading && !alarms.error && alarms.incidents.length === 0 ? <Text tone="secondary">등록된 알람이 없습니다.</Text> : null}
          <ul className="m-0 grid list-none gap-2 p-0" aria-label="현장 알람 목록">
            {alarms.incidents.map(item => <li key={item.id} data-alarm-id={item.id}
              ref={element => { if (element) alarmItemRefs.current.set(item.id, element); else alarmItemRefs.current.delete(item.id); }}
              className="grid gap-2 rounded-control border border-border-default p-3">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <Text weight="bold">{item.target.name}</Text>
                  <Text variant="body-sm" tone="secondary">{incidentTypeLabel[item.type]}</Text>
                </div>
                <StatusBadge icon={item.status === "resolved" ? CircleCheck : CircleAlert} tone={item.status === "resolved" ? "success" : item.status === "acknowledged" ? "warning" : "danger"}>
                  {item.status === "resolved" ? "해결" : item.status === "acknowledged" ? "확인됨" : "미해결"}
                </StatusBadge>
              </div>
              <Text variant="body-sm" tone="secondary">발생 {formatTimestamp(item.openedAt, { timeZone })}</Text>
              <StatusBadge icon={item.isRead ? CircleCheck : Bell} tone={item.isRead ? "neutral" : "info"}>{item.isRead ? "읽음" : "미읽음"}</StatusBadge>
              <Button type="button" size="sm" variant="secondary" className="justify-self-start"
                isDisabled={alarms.bulkPending || alarms.dismissalPending.has(item.id)} onClick={() => void alarms.dismiss(item.id)}>지우기</Button>
              {alarms.dismissalFailures.has(item.id) ? <Text role="status" variant="body-sm" tone="secondary">알람을 지우지 못했습니다. 다시 시도하세요.</Text> : null}
              {alarms.readFailures.has(item.id) ? <div className="grid gap-2" role="status">
                <Text variant="body-sm" tone="secondary">읽음 저장 실패</Text>
                <Button type="button" size="sm" variant="secondary" className="justify-self-start"
                  onClick={() => { if (visibleIds.current.has(item.id)) void alarms.markRead(item.id, true); }}>읽음 저장 다시 시도</Button>
              </div> : null}
            </li>)}
          </ul>
          {alarms.hasNextPage ? <Button type="button" variant="secondary" isLoading={alarms.isFetchingNextPage}
            onClick={() => void alarms.fetchNextPage()}>알람 더 보기</Button> : null}
        </section>
        <section className="grid gap-2" aria-labelledby={unresolvedHeadingId}>
          <Heading id={unresolvedHeadingId} as="h3" variant="card-title">현재 화면 상태</Heading>
        {contextItems.length > 0 ? <ul className="m-0 grid list-none gap-2 p-0" aria-label="현재 연결 요약">
          {contextItems.map((item) => <li key={item.id} className="grid gap-2 rounded-control border border-border-default p-3">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <Text weight="bold">{item.title}</Text>
                {item.description ? <Text variant="body-sm" tone="secondary" className="mt-1">{item.description}</Text> : null}
              </div>
              <StatusBadge icon={contextStatusIcon(item.tone)} tone={item.tone}>{contextStatusLabel(item.tone)}</StatusBadge>
            </div>
          </li>)}
        </ul> : null}
          {statuses.length === 0 ? <Text tone="secondary">현재 확인할 상태가 없습니다.</Text> : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {statuses.map((item) => {
              const icon = item.tone === "info" ? Info : CircleAlert;
              return <li
                key={item.id}
                ref={(element) => {
                  if (element) statusItemRefs.current.set(item.id, element);
                  else statusItemRefs.current.delete(item.id);
                }}
                tabIndex={-1}
                className="grid gap-2 rounded-control border border-border-default p-3 focus-visible:outline-none focus-visible:shadow-focus"
              >
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Text weight="bold">{item.title}</Text>
                    {item.description ? <Text variant="body-sm" tone="secondary" className="mt-1">{item.description}</Text> : null}
                  </div>
                  <StatusBadge icon={icon} tone={item.tone}>{statusLabel(item.tone)}</StatusBadge>
                </div>
                {item.action ? <Button type="button" size="sm" className="justify-self-start" onClick={item.action.onAction}>{item.action.label}</Button> : null}
              </li>;
            })}
          </ul>
          )}
        </section>
      </div>
    </DrawerDialog>
    <ConfirmDialog isOpen={confirmBulk} title="전체 알람 지우기" role="alertdialog" confirmLabel="전체 지우기" returnFocusRef={bulkTriggerRef}
      onCancel={() => setConfirmBulk(false)} onConfirm={() => { setConfirmBulk(false); void alarms.dismissAll(); }}>
      현재 계정의 선택 현장 알람을 페이지와 목록 필터 밖까지 모두 개인 목록에서 숨깁니다. 원본 장애와 읽음 상태는 유지됩니다. 처리 시작 뒤 도착한 새 알람은 남습니다.
    </ConfirmDialog>
  </div>;
});

const incidentTypeLabel: Record<MonitoringIncidentType, string> = {
  gateway_offline: "게이트웨이 연결 끊김", fixture_stale: "조명 상태 수신 지연",
  fixture_fault: "조명 이상", command_failed: "조명 명령 실패"
};

function contextStatusLabel(tone: StatusTone) {
  if (tone === "success") return "정상";
  if (tone === "warning") return "확인 필요";
  if (tone === "danger") return "오류";
  return "정보";
}

function contextStatusIcon(tone: StatusTone) {
  if (tone === "success") return CircleCheck;
  if (tone === "neutral" || tone === "info") return Info;
  return CircleAlert;
}

function statusLabel(tone: "info" | "warning" | "danger") {
  if (tone === "danger") return "오류";
  if (tone === "warning") return "확인 필요";
  return "안내";
}
