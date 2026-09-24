import { Bell, CircleAlert, Info } from "lucide-react";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Button } from "../Button";
import { StatusBadge } from "../StatusBadge";
import { Heading, Text } from "../Typography";
import { Popover } from "../overlays/Popover";
import { cn } from "../utils/cn";
import { useSessionStatusState } from "./SessionStatusProvider";

export interface SessionStatusCenterHandle {
  open(returnFocusTarget?: HTMLElement | null, focusStatusId?: string): void;
}

export const SessionStatusCenter = forwardRef<SessionStatusCenterHandle, { className?: string }>(function SessionStatusCenter({ className }, ref) {
  const { statuses } = useSessionStatusState();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);
  const pendingFocusStatusIdRef = useRef<string | null>(null);
  const statusItemRefs = useRef(new Map<string, HTMLLIElement>());
  const panelId = useId();
  const accessibleLabel = `상태 센터, 미해결 ${statuses.length}건`;
  const updateOpenState = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      returnFocusTargetRef.current ??= triggerRef.current;
      return;
    }
    const returnFocusTarget = returnFocusTargetRef.current ?? triggerRef.current;
    returnFocusTargetRef.current = null;
    window.requestAnimationFrame(() => returnFocusTarget?.focus());
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
      className="min-w-11 px-2"
      aria-label={accessibleLabel}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-controls={panelId}
      onClick={() => {
        if (!isOpen) returnFocusTargetRef.current = triggerRef.current;
        updateOpenState(!isOpen);
      }}
    >
      <Bell size={18} aria-hidden="true" />
      <span className="max-compact:sr-only">상태</span>
      <span aria-hidden="true">{statuses.length}</span>
    </Button>
    <Popover
      id={panelId}
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={updateOpenState}
      placement="bottom end"
      aria-label="현재 세션 상태"
      className="w-80"
    >
      <div className="grid gap-3">
        <div className="grid gap-1">
          <Heading as="h2" variant="card-title">현재 세션 상태</Heading>
          <Text variant="body-sm" tone="secondary">현재 화면과 선택 현장에서 확인이 필요한 항목입니다.</Text>
        </div>
        {statuses.length === 0 ? <Text variant="body-sm" tone="secondary">현재 확인할 상태가 없습니다.</Text> : (
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
      </div>
    </Popover>
  </div>;
});

function statusLabel(tone: "info" | "warning" | "danger") {
  if (tone === "danger") return "오류";
  if (tone === "warning") return "확인 필요";
  return "안내";
}
