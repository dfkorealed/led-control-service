export type ProgressStepState = "complete" | "current" | "pending" | "error";

export interface ProgressStep {
  id: string;
  label: string;
  state: ProgressStepState;
  description?: string;
}

export function ProgressSteps({ label, steps }: { label: string; steps: readonly ProgressStep[] }) {
  return (
    <ol className="ui-progress-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.id} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
          <span className="ui-progress-index" aria-hidden="true">{step.state === "complete" ? "✓" : index + 1}</span>
          <span>
            <strong>{step.label}</strong>
            {step.description ? <small>{step.description}</small> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
