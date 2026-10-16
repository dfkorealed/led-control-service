import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cva } from "class-variance-authority";
import { Text } from "./Typography";
export type MetricTone = "neutral" | "primary" | "success" | "warning" | "danger";
export interface MetricContentProps { label: string; value: string | number; unit?: string; helper?: string; icon?: LucideIcon; tone?: MetricTone; status?: ReactNode }
const metricValue = cva("", { variants: { tone: {
  neutral: "text-content-primary", primary: "text-action-primary", success: "text-status-success-foreground", warning: "text-status-warning-foreground", danger: "text-status-danger-foreground"
} } });

export function MetricContent({ label, value, unit, helper, icon: Icon, tone = "neutral", status }: MetricContentProps) {
  return <>
    <div className="flex min-w-0 items-center gap-1.5 text-body-sm font-bold text-content-secondary" data-metric-label="">{Icon ? <Icon size={18} className="shrink-0" aria-hidden="true" /> : null}<span className="min-w-0 wrap-anywhere">{label}</span></div>
    {/* Keep every digit and unit readable when a metric has less inline space;
        units can move to another line without shrinking the approved type. */}
    <Text as="strong" variant="metric" className={`${metricValue({ tone })} flex min-w-0 flex-wrap items-baseline gap-x-1 wrap-anywhere`}><Text as="span" variant="metric" className={`${metricValue({ tone })} min-w-0 max-w-full wrap-anywhere`}>{value}</Text>{unit ? <> <Text as="small" variant="body-lg" className={metricValue({ tone })}>{unit}</Text></> : null}</Text>
    {helper ? <Text variant="caption" tone="secondary" className="min-w-0 wrap-anywhere">{helper}</Text> : null}{status}
  </>;
}
