import { ChevronDown, ChevronUp, Lightbulb, RadioTower } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button, Heading, Text } from "../../../../components/ui";

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
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Button
            key={option.value}
            variant="secondary"
            type="button"
            className={`min-h-12 ${selected ? "border-action-primary bg-action-primary-soft" : ""}`}
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
  triggerRef,
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
  triggerRef?: Ref<HTMLButtonElement>;
  onOpen: () => void;
}) {
  const Icon = kind === "sensor" ? RadioTower : Lightbulb;
  return (
    <div
      ref={fieldRef}
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-panel border p-3 ${error ? "border-status-danger-foreground" : "border-border-default"} ${empty ? "bg-surface-inset" : "bg-surface-panel"}`}
      role="group"
      aria-label={label}
      aria-invalid={Boolean(error)}
      aria-describedby={error && errorId ? errorId : undefined}
      aria-errormessage={error && errorId ? errorId : undefined}
      tabIndex={-1}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-control bg-action-primary-soft text-action-primary"><Icon size={20} aria-hidden="true" /></span>
      <span className="grid min-w-0 gap-1">
        <Text as="strong" weight="semibold">{title}</Text>
        <Text as="small" variant="caption" tone="secondary">{description}</Text>
      </span>
      <Button ref={triggerRef} variant="secondary" type="button" disabled={disabled} aria-label={`${label} ${empty ? "선택" : "변경"}`} onClick={onOpen}>
        {empty ? "선택" : "변경"}
      </Button>
      {error && errorId ? <Text as="span" id={errorId} className="col-span-full" variant="caption" tone="danger">{error}</Text> : null}
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
    <section className="grid gap-3 rounded-panel border border-border-default bg-surface-panel p-3">
      <Button
        variant="ghost"
        className="w-full justify-start"
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
        <span>{label}</span>
      </Button>
      {open ? <div className="grid gap-4" role="region" aria-label={label}>{children}</div> : null}
    </section>
  );
}

export function AutomationSummaryBar({ children }: { children: ReactNode }) {
  return <Text className="rounded-control bg-surface-inset p-3" role="status" aria-live="polite">{children}</Text>;
}

export function AutomationTargetPickerView({
  title,
  description,
  disabled,
  doneLabel = "선택 완료",
  doneDisabled = false,
  className,
  children,
  onDone
}: {
  title: string;
  description: string;
  disabled: boolean;
  doneLabel?: string;
  doneDisabled?: boolean;
  className?: string;
  children: ReactNode;
  onDone: () => void;
}) {
  return (
    <div className={className ?? "grid gap-4"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <Heading as="h3" variant="card-title">{title}</Heading>
          <Text tone="secondary">{description}</Text>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" type="button" disabled={disabled} onClick={onDone}>설정으로 돌아가기</Button>
          <Button variant="primary" type="button" disabled={disabled || doneDisabled} onClick={onDone}>{doneLabel}</Button>
        </div>
      </div>
      {children}
    </div>
  );
}
