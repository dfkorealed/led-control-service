import type { LucideIcon } from "lucide-react";
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export interface IconTooltipButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  icon: LucideIcon;
  label: string;
  isLoading?: boolean;
  loadingLabel?: string;
  variant?: "default";
  isDisabled?: boolean;
}

const tooltipButton = cva("ui-icon-tooltip-button inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border-0 bg-transparent p-0 text-action-primary cursor-pointer hover:bg-action-primary-soft focus-visible:bg-action-primary-soft focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60", { variants: { variant: { default: "" } } });

export const IconTooltipButton = forwardRef<HTMLButtonElement, IconTooltipButtonProps>(function IconTooltipButton(
  {
    icon: Icon,
    label,
    isLoading = false,
    loadingLabel = "처리 중",
    className = "",
    disabled,
    isDisabled,
    variant = "default",
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
      className="ui-icon-tooltip relative inline-flex shrink-0"
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
        className={cn(tooltipButton({ variant }), className)}
        aria-label={accessibleLabel}
        aria-describedby={isTooltipOpen ? tooltipId : undefined}
        aria-busy={isLoading || undefined}
        disabled={disabled || isDisabled || isLoading}
      >
        <Icon size={18} aria-hidden="true" />
      </button>
      {isTooltipOpen ? (
        <span id={tooltipId} className="ui-icon-tooltip-label absolute top-full left-1/2 z-60 mt-2 -translate-x-1/2 rounded-control bg-surface-inverse px-2 py-1.5 text-caption font-bold whitespace-nowrap text-content-inverse shadow-popover" role="tooltip">
          {accessibleLabel}
        </span>
      ) : null}
    </span>
  );
});
