import { Bell, CircleAlert, CircleCheck, Info } from "lucide-react";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Button } from "../Button";
import { DrawerDialog } from "../DrawerDialog";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import { Heading, Text } from "../Typography";
import { cn } from "../utils/cn";
import { useSessionStatusState } from "./SessionStatusProvider";

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
  className?: string;
  contextItems?: readonly SessionStatusContextItem[];
}

export const SessionStatusCenter = forwardRef<SessionStatusCenterHandle, SessionStatusCenterProps>(function SessionStatusCenter({ className, contextItems = [] }, ref) {
  const { statuses } = useSessionStatusState();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);
  const pendingFocusStatusIdRef = useRef<string | null>(null);
  const statusItemRefs = useRef(new Map<string, HTMLLIElement>());
  const unresolvedHeadingId = useId();
  const accessibleLabel = `상태 센터, 미해결 ${statuses.length}건`;
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
      {statuses.length > 0 ? <span
        data-testid="status-unresolved-badge"
        aria-hidden="true"
        className="absolute right-1 top-1 grid min-h-4 min-w-4 place-items-center rounded-pill bg-status-danger-foreground px-1 text-overline text-content-inverse"
      >{statuses.length}</span> : null}
    </Button>
    <DrawerDialog
      isOpen={isOpen}
      title="현재 세션 상태"
      description="현재 화면과 선택 현장에서 확인이 필요한 항목입니다. 배지 숫자는 읽지 않은 알림 수가 아니라 현재 해결이 필요한 상태 수입니다."
      closeLabel="상태 센터 닫기"
      returnFocusElement={returnFocusTargetRef.current ?? triggerRef.current}
      onClose={() => updateOpenState(false)}
      actions={<Button type="button" variant="secondary" onClick={() => updateOpenState(false)}>닫기</Button>}
    >
      <div className="grid gap-5">
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
        <section className="grid gap-2" aria-labelledby={unresolvedHeadingId}>
          <Heading id={unresolvedHeadingId} as="h3" variant="card-title">확인할 항목</Heading>
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
  </div>;
});

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
