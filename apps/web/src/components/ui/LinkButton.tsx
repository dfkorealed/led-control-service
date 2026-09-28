import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cn } from "./utils/cn";

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: "primary" | "secondary" | "text" | "landingCta" | "landingHeader";
}

/** Navigation keeps native link semantics, including open-in-new-tab and fragment focus. */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton(
  { variant = "primary", className, children, ...props }, ref
) {
  const isLanding = variant === "landingCta" || variant === "landingHeader";
  return <a ref={ref} {...props} className={cn(
    "inline-flex min-h-12 items-center justify-center gap-2 rounded-control border px-5 py-3 text-body font-bold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-focus",
    !isLanding && "motion-safe:transition-colors",
    variant === "primary" && "border-action-primary bg-action-primary text-content-inverse hover:bg-action-primary-hover",
    variant === "secondary" && "border-border-strong bg-surface-panel text-action-primary hover:bg-action-primary-soft",
    variant === "text" && "border-transparent text-action-primary hover:bg-action-primary-soft",
    isLanding && "gap-3 rounded-landing-button border-transparent p-landing-button-inset text-landing-button font-extrabold transition-[transform,background,border-color] duration-200 ease-[ease] hover:transform-[translateY(-2px)]",
    variant === "landingCta" && "bg-brand-coral text-brand-navy hover:bg-surface-panel",
    variant === "landingHeader" && "min-h-[39px] border-surface-panel/42 bg-transparent text-surface-panel hover:bg-surface-panel/13 landing-wide:landing-stack:min-h-[35px] landing-wide:landing-stack:px-landing-navigation-login-stacked-inline-inset landing-wide:landing-stack:text-landing-navigation-stacked landing-wide:landing-stack:landing-narrow:px-landing-navigation-login-narrow-inline-inset landing-wide:landing-stack:landing-narrow:text-landing-navigation-narrow",
    className
  )}>{children}</a>;
});
