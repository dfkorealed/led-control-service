import { CircleAlert, CircleCheck, Clock3 } from "lucide-react";

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

export function ProgressSteps({ label, steps }: { label: string; steps: readonly ProgressStep[] }) {
  return (
    <ol className="ui-progress-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.id} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
          <span className="ui-progress-index" aria-hidden="true">{step.state === "complete" ? "✓" : index + 1}</span>
          <span>
            <strong>{step.label}</strong>
            <span className="ui-progress-state">
              {(() => {
                const { Icon, label: stateLabel } = statePresentation[step.state];
                return <><Icon size={14} aria-hidden="true" />{stateLabel}</>;
              })()}
            </span>
            {step.description ? <small>{step.description}</small> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
