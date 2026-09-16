import type { LucideIcon } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export type StatusTone = "success" | "warning" | "danger" | "neutral" | "info";

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> { variant?: "default"; tone: StatusTone; icon: LucideIcon; children: ReactNode }
const badge = cva("inline-flex min-h-7 items-center gap-1.5 rounded-pill px-2 py-1 text-label font-bold whitespace-nowrap", {
  variants: { variant: { default: "" }, tone: {
    success: "bg-status-success-background text-status-success-foreground",
    warning: "bg-status-warning-background text-status-warning-badge",
    danger: "bg-status-danger-background text-status-danger-badge",
    neutral: "bg-status-neutral-background text-status-neutral-foreground",
    info: "bg-status-info-background text-status-info-foreground"
  } }
});
export const StatusBadge = forwardRef<HTMLSpanElement, StatusBadgeProps>(function StatusBadge({ variant = "default", tone, icon: Icon, children, className, ...props }, ref) {
  return <span {...props} ref={ref} className={cn(badge({ variant, tone }), className)} data-tone={tone}><Icon size={14} aria-hidden="true" /><span>{children}</span></span>;
});
