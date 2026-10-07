import { Text } from "../Typography";

export interface InlineStatusSummaryProps {
  label: string;
  items: readonly { id: string; label: string; value: number | null; tone: "info" | "success" | "warning" | "danger" | "neutral" }[];
}

export function InlineStatusSummary({ label, items }: InlineStatusSummaryProps) {
  return <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
    {items.map(item => <span key={item.id} className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <Text as="span" variant="body-sm" tone="secondary">{item.label}</Text>
      <Text as="strong" variant="body" weight="semibold" className="tabular-nums"
        tone={item.tone === "info" || item.tone === "neutral" ? "primary" : item.tone}>{item.value ?? "—"}</Text>
    </span>)}
  </div>;
}
