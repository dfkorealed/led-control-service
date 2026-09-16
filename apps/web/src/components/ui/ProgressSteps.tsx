import { CircleAlert, CircleCheck, Clock3 } from "lucide-react";
import { forwardRef, type HTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";
import { Text } from "./Typography";

export type ProgressStepState = "complete" | "current" | "pending" | "error";

export interface ProgressStep {
  id: string;
  label: string;
  state: ProgressStepState;
  description?: string;
}

const statePresentation = {
  complete: { Icon: CircleCheck, label: "완료" },
  current: { Icon: CircleCheck, label: "진행 중" },
  pending: { Icon: Clock3, label: "대기" },
  error: { Icon: CircleAlert, label: "오류" }
} as const;

export interface ProgressStepsProps extends HTMLAttributes<HTMLOListElement> { variant?: "default"; label: string; steps: readonly ProgressStep[] }
const progress = cva("m-0 flex list-none gap-3 p-0", { variants: { variant: { default: "" } } });
const progressText = cva("", { variants: { state: {
  complete: "text-action-primary", current: "text-action-primary", pending: "text-content-secondary", error: "text-status-danger-foreground"
} } });
const progressIndex = cva("inline-grid size-7 shrink-0 place-items-center rounded-pill border-2 text-label font-bold", { variants: { state: {
  complete: "border-action-primary bg-action-primary text-content-inverse", current: "border-action-primary bg-action-primary text-content-inverse",
  pending: "border-border-strong bg-surface-panel text-content-secondary", error: "border-status-danger-foreground bg-status-danger-background text-status-danger-foreground"
} } });
export const ProgressSteps = forwardRef<HTMLOListElement, ProgressStepsProps>(function ProgressSteps({ variant = "default", label, steps, className, ...props }, ref) {
  return (
    <ol {...props} ref={ref} className={cn(progress({ variant }), className)} aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.id} className={cn("flex min-w-0 items-start gap-2", progressText({ state: step.state }))} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
          <span className={progressIndex({ state: step.state })} aria-hidden="true">{step.state === "complete" ? "✓" : index + 1}</span>
          <span className="grid gap-0.5">
            <Text as="strong" weight="bold" className={progressText({ state: step.state })}>{step.label}</Text>
            <span className={cn("inline-flex items-center gap-1 text-label font-bold", progressText({ state: step.state }))}>
              {(() => {
                const { Icon, label: stateLabel } = statePresentation[step.state];
                return <><Icon size={14} aria-hidden="true" />{stateLabel}</>;
              })()}
            </span>
            {step.description ? <Text as="small" variant="caption" tone="secondary">{step.description}</Text> : null}
          </span>
        </li>
      ))}
    </ol>
  );
});
