import { forwardRef, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { ButtonProps as AriaButtonProps } from "react-aria-components";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Pick<AriaButtonProps, "isDisabled" | "onPress"> {
  variant?: "landingConceptDismiss" | "landingConceptSubmit" | "landingConceptHeaderContact" | "landingConceptHeroContact" | "landingConceptReplay" | "landingReportFormat" | "landingMapTool" | "landingMapCancel" | "landingMapMarker" | "landingReplay" | "landingFixture" | "primary" | "secondary" | "ghost" | "danger" | "link" | "landingCta" | "landingHeaderContact" | "landingHeroContact" | "landingPlanPrimary" | "landingPlanSecondary";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

const landingPlanFrame = "min-h-12 gap-3 rounded-landing-button border-transparent p-landing-button-inset text-landing-button font-extrabold transition-[transform,background,border-color] duration-200 ease-[ease] hover:transform-[translateY(-2px)]";

const landingMapToolFrame = "min-h-[34px] gap-3 rounded-landing-map-tool border-transparent px-2.5 py-0 text-landing-demo-control-label font-extrabold leading-landing-compact-button transition-[transform,background,border-color] duration-200 ease-[ease] hover:transform-[translateY(-2px)]";

const button = cva("inline-flex min-h-11 items-center justify-center gap-2 rounded-control border font-bold cursor-pointer focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60", {
  variants: {
    variant: {
      landingConceptDismiss: "inquiry-dialog__close grid size-9 min-h-0 flex-none place-items-center gap-0 rounded-landing-compact-control border-border-subtle bg-surface-panel p-0 text-landing-concept-inquiry-dismiss font-normal leading-landing-concept-document text-brand-navy hover:enabled:bg-brand-paper aria-disabled:opacity-45 aria-disabled:cursor-wait",
      landingConceptSubmit: "w-full min-h-[50px] gap-3 rounded-landing-button border-transparent bg-brand-blue p-landing-button-inset text-landing-button font-extrabold text-surface-panel transition-[transform,background,border-color] duration-200 ease-[ease] hover:transform-[translateY(-2px)] hover:enabled:bg-action-primary-hover aria-disabled:opacity-60 aria-disabled:cursor-wait aria-disabled:transform-none",
      landingConceptHeaderContact: "block min-h-0 gap-0 rounded-none border-0 bg-transparent px-0 py-2 text-landing-navigation font-[750] leading-landing-concept-document text-surface-panel hover:enabled:text-brand-coral landing-stack:text-landing-navigation-stacked",
      landingConceptHeroContact: "block min-h-0 gap-0 rounded-none border-0 border-b border-surface-panel/48 bg-transparent px-0 py-2.5 text-landing-action font-[750] leading-landing-concept-document text-surface-panel hover:enabled:text-brand-coral",
      landingConceptReplay: "block min-h-[38px] flex-none rounded-landing-compact-control border-border-subtle bg-surface-panel px-2.5 py-0 text-landing-compact-action font-[750] leading-landing-concept-document text-brand-blue hover:enabled:bg-action-primary-soft first-letter:text-landing-replay-icon landing-narrow:min-w-[34px] landing-narrow:min-h-[34px]",
      landingReportFormat: "block min-h-[30px] gap-0 items-normal justify-normal rounded-landing-compact-choice-control border-border-subtle bg-surface-panel p-landing-report-format-inset text-landing-demo-control-label font-extrabold text-content-secondary cursor-default focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-current focus-visible:outline-offset-0 focus-visible:shadow-none aria-pressed:border-brand-blue aria-pressed:bg-action-primary-soft aria-pressed:text-brand-blue",
      landingMapTool: `${landingMapToolFrame} touch-none bg-brand-blue text-surface-panel`,
      landingMapCancel: `${landingMapToolFrame} border-border-subtle bg-surface-panel text-brand-navy hover:border-brand-blue`,
      landingMapMarker: "absolute z-2 block size-4.5 min-h-0 items-normal justify-normal gap-0 rounded-landing-ellipse border-4 border-brand-blue bg-surface-panel p-0 font-normal cursor-default ring-5 ring-action-primary-soft touch-none focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-current focus-visible:outline-offset-0 focus-visible:shadow-none",
      landingReplay: "leading-landing-text-action min-h-[38px] flex-none rounded-landing-compact-control border-border-subtle bg-surface-panel px-2.5 py-0 text-landing-compact-action font-[750] text-brand-blue hover:enabled:bg-action-primary-soft first-letter:text-landing-replay-icon landing-narrow:min-w-[34px] landing-narrow:min-h-[34px]",
      landingFixture: "group absolute z-2 grid size-8 min-h-0 place-items-center justify-normal gap-0 font-normal focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-border-focus focus-visible:outline-offset-2 focus-visible:shadow-none rounded-landing-ellipse border-0 border-none bg-transparent p-0 transform-[translate(-50%,-50%)]",
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
