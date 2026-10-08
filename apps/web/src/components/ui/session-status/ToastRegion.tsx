import { X } from "lucide-react";
import { IconButton } from "../IconButton";
import { Text } from "../Typography";
import { cn } from "../utils/cn";
import { useSessionStatusState, type SessionToast } from "./SessionStatusProvider";

export function ToastRegion({ className, placement = "overlay", suppressVisual = false }: { className?: string; placement?: "overlay" | "flow"; suppressVisual?: boolean }) {
  const { toasts, dismiss } = useSessionStatusState();
  // Flow consumers reserve each visible article's real height, with no empty
  // band after expiry. Standalone callers retain the legacy overlay default.
  if (placement === "flow" && toasts.length === 0) return null;
  return (
    <section aria-label="알림" data-toast-placement={placement} className={cn(suppressVisual ? "sr-only" : placement === "flow"
      ? "grid min-w-0 shrink-0 gap-2 px-3.5 py-2 compact:px-7"
      : "pointer-events-none fixed inset-x-3 top-3 z-1000 grid justify-items-end gap-2 compact:left-auto compact:right-4 compact:w-80", className)}>
      {toasts.map((toast) => suppressVisual
        ? <div key={toast.id} role={toast.tone === "danger" ? "alert" : "status"}>{toast.title}{toast.description ? ` ${toast.description}` : ""}</div>
        : <ToastMessage key={toast.id} toast={toast} onDismiss={dismiss} />)}
    </section>
  );
}

function ToastMessage({ toast, onDismiss }: { toast: SessionToast; onDismiss(id: string): void }) {

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
