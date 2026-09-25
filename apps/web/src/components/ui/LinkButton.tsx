import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cn } from "./utils/cn";

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: "primary" | "secondary" | "text";
}

/** Navigation keeps native link semantics, including open-in-new-tab and fragment focus. */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton(
  { variant = "primary", className, children, ...props }, ref
) {
  return <a ref={ref} {...props} className={cn(
    "inline-flex min-h-12 items-center justify-center gap-2 rounded-control border px-5 py-3 text-body font-bold motion-safe:transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-focus",
    variant === "primary" && "border-action-primary bg-action-primary text-content-inverse hover:bg-action-primary-hover",
    variant === "secondary" && "border-border-strong bg-surface-panel text-action-primary hover:bg-action-primary-soft",
    variant === "text" && "border-transparent text-action-primary hover:bg-action-primary-soft",
    className
  )}>{children}</a>;
});
