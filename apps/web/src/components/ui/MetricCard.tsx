import { forwardRef, type HTMLAttributes } from "react";
import { MetricContent, type MetricContentProps } from "./MetricContent";
import { cn } from "./utils/cn";
export type { MetricTone } from "./MetricContent";
export interface MetricCardProps extends HTMLAttributes<HTMLElement>, MetricContentProps { variant?: "default" }
export const MetricCard = forwardRef<HTMLElement, MetricCardProps>(function MetricCard({ variant: _variant, label, value, unit, helper, icon, tone = "neutral", status, className, ...props }, ref) {
  return <section {...props} ref={ref} className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-panel border border-border-default bg-surface-panel p-4", className)} data-metric-card="" data-tone={tone} role="group" aria-label={label}>
    <MetricContent {...{ label, value, unit, helper, icon, tone, status }} />
  </section>;
});
