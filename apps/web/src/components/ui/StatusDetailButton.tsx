import { CircleAlert } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "./Button";
import { Popover } from "./overlays/Popover";
import { Text } from "./Typography";
import { cn } from "./utils/cn";

export interface StatusDetailButtonProps {
  label: string;
  description: string;
  action?: { label: string; onClick: (trigger: HTMLButtonElement | null) => void; isBusy?: boolean };
  variant?: "warning" | "danger" | "info";
  className?: string;
}

const variantClass = {
  warning: "border-status-warning-border bg-status-warning-background text-status-warning-foreground",
  danger: "border-status-danger-border bg-status-danger-background text-status-danger-foreground",
  info: "border-status-info-border bg-status-info-background text-status-info-foreground"
} as const;

export function StatusDetailButton({ label, description, action, variant = "warning", className }: StatusDetailButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const accessibleLabel = `${label} 안내`;

  return <span className="inline-flex min-w-0" role="status">
    <Button ref={triggerRef} type="button" size="sm" variant="secondary"
      className={cn("max-w-full", variantClass[variant], className)}
      aria-label={accessibleLabel} aria-haspopup="dialog" aria-expanded={isOpen} aria-controls={panelId}
      onClick={() => setIsOpen((current) => !current)}>
      <CircleAlert size={16} aria-hidden="true" />
      <span className="min-w-0 text-left">{label}</span>
    </Button>
    <Popover id={panelId} triggerRef={triggerRef} isOpen={isOpen} onOpenChange={setIsOpen}
      placement="bottom end" aria-label={accessibleLabel} className="w-80">
      <div className="grid gap-3">
        <Text as="strong" variant="body-sm" weight="bold">{label}</Text>
        <Text variant="body-sm" tone="secondary">{description}</Text>
        {action?.isBusy ? <Text as="span" variant="body-sm" tone="secondary" role="status">확인 중</Text> : null}
        {action && !action.isBusy ? <Button type="button" size="sm" className="justify-self-start" onClick={() => {
          setIsOpen(false);
          action.onClick(triggerRef.current);
          // An explicit recovery action closes this controlled popover before
          // React Aria's dismissal path can restore keyboard focus to its trigger.
          triggerRef.current?.focus();
        }}>{action.label}</Button> : null}
      </div>
    </Popover>
  </span>;
}
