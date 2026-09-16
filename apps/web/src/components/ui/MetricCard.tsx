import type { LucideIcon } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { Text } from "./Typography";
import { cn } from "./utils/cn";

export type MetricTone = "neutral" | "primary" | "success" | "warning" | "danger";

export interface MetricCardProps extends HTMLAttributes<HTMLElement> { variant?: "default"; label: string; value: string | number; unit?: string; helper?: string; icon?: LucideIcon; tone?: MetricTone; status?: ReactNode }
const metric = cva("grid gap-2 rounded-panel border border-border-default bg-surface-panel p-4", { variants: { variant: { default: "" } } });
const metricValue = cva("", { variants: { tone: {
  neutral: "text-content-primary", primary: "text-action-primary", success: "text-status-success-foreground", warning: "text-status-warning-foreground", danger: "text-status-danger-foreground"
} } });

export const MetricCard = forwardRef<HTMLElement, MetricCardProps>(function MetricCard({ variant = "default", label, value, unit, helper, icon: Icon, tone = "neutral", status, className, ...props }, ref) {
  return <section {...props} ref={ref} className={cn(metric({ variant }), className)} data-metric-card="" data-tone={tone} role="group" aria-label={label}>
    <div className="flex items-center gap-1.5 text-body-sm font-bold text-content-secondary" data-metric-label="">{Icon ? <Icon size={18} aria-hidden="true" /> : null}<span>{label}</span></div>
    <Text as="strong" variant="metric" className={metricValue({ tone })}><Text as="span" variant="metric" className={metricValue({ tone })}>{value}</Text>{unit ? <> <Text as="small" variant="body-lg" className={metricValue({ tone })}>{unit}</Text></> : null}</Text>
    {helper ? <Text variant="caption" tone="secondary">{helper}</Text> : null}{status}
  </section>;
});
