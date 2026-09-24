import { X } from "lucide-react";
import { useEffect } from "react";
import { IconButton } from "../IconButton";
import { Text } from "../Typography";
import { cn } from "../utils/cn";
import { useSessionStatusState, type SessionToast } from "./SessionStatusProvider";

export function ToastRegion({ className }: { className?: string }) {
  const { toasts, dismiss } = useSessionStatusState();
  return (
    <section aria-label="알림" className={cn("pointer-events-none fixed inset-x-3 top-3 z-1000 grid justify-items-end gap-2 compact:left-auto compact:right-4 compact:w-80", className)}>
      {toasts.map((toast) => <ToastMessage key={toast.id} toast={toast} onDismiss={dismiss} />)}
    </section>
  );
}

function ToastMessage({ toast, onDismiss }: { toast: SessionToast; onDismiss(id: string): void }) {
  useEffect(() => {
    const timeout = window.setTimeout(() => onDismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(timeout);
  }, [onDismiss, toast.durationMs, toast.id, toast.revision]);

  return (
    <article
      role={toast.tone === "danger" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2 rounded-panel border bg-surface-panel p-3 shadow-popover",
        toast.tone === "success" && "border-status-success-border",
        toast.tone === "info" && "border-status-info-border",
        toast.tone === "warning" && "border-status-warning-border",
        toast.tone === "danger" && "border-status-danger-border"
      )}
      data-toast-tone={toast.tone}
    >
      <div className="min-w-0 flex-1">
        <Text weight="bold">{toast.title}</Text>
        {toast.description ? <Text variant="body-sm" tone="secondary" className="mt-1">{toast.description}</Text> : null}
      </div>
      <IconButton className="size-11 shrink-0" variant="ghost" aria-label="알림 닫기" onClick={() => onDismiss(toast.id)}><X size={16} aria-hidden="true" /></IconButton>
    </article>
  );
}
