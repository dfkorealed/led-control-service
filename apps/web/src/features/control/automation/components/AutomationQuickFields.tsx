import { ChevronDown, ChevronUp, Lightbulb, RadioTower } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button } from "../../../../components/ui";

export function AutomationPresetGroup<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="automation-preset-group" role="group" aria-label={label}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Button
            key={option.value}
            variant="secondary"
            type="button"
            className={selected ? "automation-preset active" : "automation-preset"}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

export function AutomationSelectionCard({
  label,
  title,
  description,
  empty,
  disabled,
  kind = "light",
  error,
  errorId,
  fieldRef,
  onOpen
}: {
  label: string;
  title: string;
  description: string;
  empty: boolean;
  disabled: boolean;
  kind?: "light" | "sensor";
  error?: string;
  errorId?: string;
  fieldRef?: Ref<HTMLDivElement>;
  onOpen: () => void;
}) {
  const Icon = kind === "sensor" ? RadioTower : Lightbulb;
  return (
    <div
      ref={fieldRef}
      className={`automation-selection-card${empty ? " empty" : ""}${error ? " invalid" : ""}`}
      role="group"
      aria-label={label}
      aria-invalid={Boolean(error)}
      aria-describedby={error && errorId ? errorId : undefined}
      aria-errormessage={error && errorId ? errorId : undefined}
      tabIndex={-1}
    >
      <span className="automation-selection-icon"><Icon size={20} aria-hidden="true" /></span>
      <span className="automation-selection-copy">
        <strong>{title}</strong>
        <small className="automation-selection-description">{description}</small>
      </span>
      <Button variant="secondary" type="button" disabled={disabled} aria-label={`${label} ${empty ? "선택" : "변경"}`} onClick={onOpen}>
        {empty ? "선택" : "변경"}
      </Button>
      {error && errorId ? <span id={errorId} className="field-error automation-selection-error">{error}</span> : null}
    </div>
  );
}

export function AutomationAdvancedSection({
  label,
  open,
  disabled = false,
  children,
  onOpenChange
}: {
  label: string;
  open: boolean;
  disabled?: boolean;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <section className={`automation-advanced${open ? " open" : ""}`}>
      <button
        className="automation-advanced-toggle"
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
        <span>{label}</span>
      </button>
      {open ? <div className="automation-advanced-content" role="region" aria-label={label}>{children}</div> : null}
    </section>
  );
}

export function AutomationSummaryBar({ children }: { children: ReactNode }) {
  return <div className="automation-summary-bar" role="status" aria-live="polite">{children}</div>;
}

export function AutomationTargetPickerView({
  title,
  description,
  disabled,
  children,
  onDone
}: {
  title: string;
  description: string;
  disabled: boolean;
  children: ReactNode;
  onDone: () => void;
}) {
  return (
    <div className="automation-picker-view">
      <div className="automation-picker-heading">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <Button variant="primary" type="button" disabled={disabled} onClick={onDone}>선택 완료</Button>
      </div>
      {children}
    </div>
  );
}
