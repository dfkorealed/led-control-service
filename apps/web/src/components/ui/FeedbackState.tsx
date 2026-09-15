import type { LucideIcon } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { Text } from "./Typography";
import { cn } from "./utils/cn";

export type FeedbackTone = "neutral" | "info" | "success" | "warning" | "danger";
const feedbackText = {
  neutral: "text-content-secondary", info: "text-status-info-feedback-foreground", success: "text-status-success-feedback-foreground",
  warning: "text-status-warning-feedback-foreground", danger: "text-status-danger-feedback-foreground"
} satisfies Record<FeedbackTone, string>;

export interface FeedbackStateProps extends HTMLAttributes<HTMLElement> { variant?: "default"; tone?: FeedbackTone; icon: LucideIcon; title: string; description?: string; action?: ReactNode; liveRole?: "status" | "alert"; livePoliteness?: "polite" | "assertive" }
const feedback = cva("ui-feedback-state flex items-start gap-2.5 rounded-panel border p-3.5", {
  variants: {
    variant: { default: "" },
    tone: {
      neutral: "border-border-default bg-status-neutral-background text-content-secondary",
      info: "border-status-info-border bg-status-info-feedback-background text-status-info-feedback-foreground",
      success: "border-status-success-border bg-status-success-background text-status-success-feedback-foreground",
      warning: "border-status-warning-border bg-status-warning-feedback-background text-status-warning-feedback-foreground",
      danger: "border-status-danger-border bg-status-danger-background text-status-danger-feedback-foreground"
    }
  }
});

export const FeedbackState = forwardRef<HTMLElement, FeedbackStateProps>(function FeedbackState({ variant = "default", tone = "neutral", icon: Icon, title, description, action, liveRole, livePoliteness, className, ...props }, ref) {
  const liveProps = {
    role: liveRole ?? (tone === "danger" ? "alert" : "status"),
    "aria-live": livePoliteness
  };

  return <section {...liveProps} {...props} ref={ref} className={cn(feedback({ variant, tone }), className)} data-tone={tone}><Icon size={22} className="shrink-0" aria-hidden="true" /><div className="grid gap-1.5"><Text as="strong" weight="bold" className={feedbackText[tone]}>{title}</Text>{description ? <Text className={feedbackText[tone]}>{description}</Text> : null}{action}</div></section>;
});
