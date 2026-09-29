import { forwardRef, type ButtonHTMLAttributes } from "react";
import { MetricContent, type MetricContentProps } from "./MetricContent";
import { cn } from "./utils/cn";
export interface MetricButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value">, MetricContentProps { selected?: boolean }
export const MetricButton = forwardRef<HTMLButtonElement, MetricButtonProps>(function MetricButton({
  label, value, unit, helper, icon, tone = "neutral", status, selected = false, className, ...props
}, ref) {
  return <button {...props} type="button" ref={ref} aria-label={label} aria-pressed={selected} data-metric-card="" data-tone={tone}
    className={cn("grid min-h-11 cursor-pointer gap-2 rounded-panel border border-border-default bg-surface-panel p-4 text-left focus-visible:outline-3 focus-visible:outline-border-focus disabled:cursor-default disabled:opacity-50", className, selected && "ring-2 ring-inset ring-border-focus")}>
    <MetricContent {...{ label, value, unit, helper, icon, tone, status }} />
  </button>;
});
