import type { LucideIcon } from "lucide-react";
import { forwardRef, useId, type ButtonHTMLAttributes } from "react";

export interface IconTooltipButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  icon: LucideIcon;
  label: string;
  isLoading?: boolean;
  loadingLabel?: string;
}

export const IconTooltipButton = forwardRef<HTMLButtonElement, IconTooltipButtonProps>(function IconTooltipButton(
  {
    icon: Icon,
    label,
    isLoading = false,
    loadingLabel = "처리 중",
    className = "",
    disabled,
    ...props
  },
  ref
) {
  const tooltipId = useId();
  const accessibleLabel = isLoading ? loadingLabel : label;

  return (
    <span className="ui-icon-tooltip">
      <button
        ref={ref}
        type="button"
        {...props}
        className={`ui-icon-tooltip-button ${className}`.trim()}
        aria-label={accessibleLabel}
        aria-describedby={tooltipId}
        aria-busy={isLoading || undefined}
        disabled={disabled || isLoading}
      >
        <Icon size={18} aria-hidden="true" />
      </button>
      <span id={tooltipId} className="ui-icon-tooltip-label" role="tooltip">
        {accessibleLabel}
      </span>
    </span>
  );
});
