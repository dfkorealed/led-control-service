import { forwardRef, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { ButtonProps as AriaButtonProps } from "react-aria-components";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Pick<AriaButtonProps, "isDisabled" | "onPress"> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "link" | "landingCta" | "landingHeaderContact" | "landingHeroContact" | "landingPlanPrimary" | "landingPlanSecondary";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

const landingPlanFrame = "min-h-12 gap-3 rounded-landing-button border-transparent p-landing-button-inset text-landing-button font-extrabold transition-[transform,background,border-color] duration-200 ease-[ease] hover:transform-[translateY(-2px)]";

const button = cva("inline-flex min-h-11 items-center justify-center gap-2 rounded-control border font-bold cursor-pointer focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60", {
  variants: {
    variant: {
      landingPlanPrimary: `${landingPlanFrame} bg-action-primary text-content-inverse hover:enabled:bg-action-primary-hover`,
      landingPlanSecondary: `${landingPlanFrame} bg-action-secondary text-action-primary`,
      landingCta: "min-h-12 gap-3 rounded-landing-button border-transparent bg-brand-coral p-landing-button-inset text-landing-button font-extrabold text-brand-navy transition-[transform,background,border-color] duration-200 ease-[ease] hover:transform-[translateY(-2px)] hover:enabled:bg-surface-panel",
      landingHeaderContact: "leading-landing-text-action border-0 bg-transparent px-0 py-2 text-landing-navigation font-[750] text-surface-panel underline underline-offset-4 hover:enabled:text-brand-coral landing-wide:landing-stack:text-landing-navigation-stacked landing-wide:landing-stack:landing-narrow:text-landing-navigation-narrow",
      landingHeroContact: "leading-landing-text-action border-0 bg-transparent px-0 py-2.5 text-landing-action font-[750] text-surface-panel no-underline hover:enabled:text-brand-coral",
      primary: "border-action-primary bg-action-primary text-content-inverse hover:enabled:border-action-primary-hover hover:enabled:bg-action-primary-hover active:enabled:bg-action-primary-active",
      secondary: "border-border-default bg-action-secondary text-action-primary",
      ghost: "border-border-default bg-surface-panel text-action-primary",
      danger: "border-action-danger-border bg-action-danger-background text-action-danger-foreground",
      link: "border-transparent bg-transparent text-action-primary underline underline-offset-4 hover:enabled:text-action-primary-hover"
    },
    size: { "sm": "px-3 py-0 text-body-sm", "md": "px-4 py-0 text-body", "lg": "min-h-12 px-6 py-2 text-body-lg" }
  },
  defaultVariants: { variant: "secondary", size: "md" }
});

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", isLoading = false, loadingLabel = "저장 중", children, className, disabled, isDisabled, onPress, onClick, onKeyDown, onPointerDown, onBlur, ...props },
  ref
) {
  const activation = useRef<{ key?: string; pointerType?: "mouse" | "touch" | "pen" }>({});
  // Keep native button submission and activation semantics. The adapter only
  // observes the browser click origin and never synthesizes a second action.
  // Public landing variants own their exact frame independently of app control density.
  const classes = button({ variant, size: variant.startsWith("landing") ? null : size });
  return <button ref={ref} {...props} disabled={disabled || isDisabled || isLoading} aria-busy={isLoading || props["aria-busy"]} data-variant={variant} className={cn(classes, className)}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (!event.defaultPrevented && (event.key === "Enter" || event.key === " ")) activation.current = { key: event.key };
    }}
    onPointerDown={(event) => {
      onPointerDown?.(event);
      activation.current = { pointerType: event.pointerType === "touch" || event.pointerType === "pen" ? event.pointerType : "mouse" };
    }}
    onBlur={(event) => { activation.current = {}; onBlur?.(event); }}
    onClick={(event) => {
      const origin = activation.current;
      activation.current = {};
      onClick?.(event);
      if (!onPress || event.defaultPrevented) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      let propagate = false;
      onPress({
        type: "press", target: event.currentTarget,
        pointerType: origin.key ? "keyboard" : origin.pointerType ?? (event.detail === 0 ? "virtual" : "mouse"),
        key: origin.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
        // Keyboard-generated clicks have zero viewport coordinates. A press
        // without a physical pointer is located at the control's center.
        x: origin.key || (!origin.pointerType && event.detail === 0) ? bounds.width / 2 : event.clientX - bounds.left,
        y: origin.key || (!origin.pointerType && event.detail === 0) ? bounds.height / 2 : event.clientY - bounds.top,
        continuePropagation: () => { propagate = true; }
      });
      if (!propagate) event.stopPropagation();
    }}
  >{isLoading ? loadingLabel : children}</button>;
});
