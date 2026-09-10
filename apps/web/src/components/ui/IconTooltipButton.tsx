import type { LucideIcon } from "lucide-react";
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes } from "react";

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
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const isDismissedByEscape = useRef(false);
  const accessibleLabel = isLoading ? loadingLabel : label;

  useEffect(() => {
    if (!isTooltipOpen) return undefined;

    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      isDismissedByEscape.current = true;
      setIsTooltipOpen(false);
    };

    document.addEventListener("keydown", dismissOnEscape, true);
    return () => document.removeEventListener("keydown", dismissOnEscape, true);
  }, [isTooltipOpen]);

  return (
    <span
      className="ui-icon-tooltip"
      onMouseEnter={() => {
        if (!isDismissedByEscape.current) setIsTooltipOpen(true);
      }}
      onMouseLeave={(event) => {
        const tooltipRoot = event.currentTarget;

        // Removing the tooltip can emit a synthetic leave while the pointer is
        // still over the trigger. Only reset an Escape dismissal after the
        // pointer has genuinely left the complete trigger/tooltip region.
        requestAnimationFrame(() => {
          if (!tooltipRoot.matches(":hover")) {
            isDismissedByEscape.current = false;
            setIsTooltipOpen(false);
          }
        });
      }}
      onFocus={() => {
        isDismissedByEscape.current = false;
        setIsTooltipOpen(true);
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          isDismissedByEscape.current = false;
          setIsTooltipOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          isDismissedByEscape.current = true;
          setIsTooltipOpen(false);
        }
      }}
    >
      <button
        ref={ref}
        type="button"
        {...props}
        className={`ui-icon-tooltip-button ${className}`.trim()}
        aria-label={accessibleLabel}
        aria-describedby={isTooltipOpen ? tooltipId : undefined}
        aria-busy={isLoading || undefined}
        disabled={disabled || isLoading}
      >
        <Icon size={18} aria-hidden="true" />
      </button>
      {isTooltipOpen ? (
        <span id={tooltipId} className="ui-icon-tooltip-label" role="tooltip">
          {accessibleLabel}
        </span>
      ) : null}
    </span>
  );
});
