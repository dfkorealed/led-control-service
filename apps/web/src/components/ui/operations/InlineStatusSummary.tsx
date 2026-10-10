import { Text } from "../Typography";

export interface InlineStatusSummaryProps {
  label: string;
  items: readonly { id: string; label: string; value: number | null; tone: "info" | "success" | "warning" | "danger" | "neutral" }[];
}
const dotTone = { info: "bg-status-info-foreground", success: "bg-status-success-foreground", warning: "bg-status-warning-foreground", danger: "bg-status-danger-foreground", neutral: "bg-content-muted" };

export function InlineStatusSummary({ label, items }: InlineStatusSummaryProps) {
  return <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
    {items.map(item => <span key={item.id} className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span aria-hidden="true" className={`size-1.5 shrink-0 self-center rounded-pill ${dotTone[item.tone]}`} />
      <Text as="span" variant="body" tone="secondary">{item.label}</Text>
      <Text as="strong" variant="body-lg" weight="semibold" className="tabular-nums">{item.value ?? "—"}</Text>
    </span>)}
  </div>;
}
