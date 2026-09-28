import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export type CardTone = "landingDemo" | "landingDemoSurface" | "default" | "selected" | "danger" | "landingGlass" | "landingFeature" | "landingPlan" | "landingPlanFeatured";

export interface CardProps extends HTMLAttributes<HTMLElement> { tone?: CardTone; variant?: CardTone; children: ReactNode }
const landingPlanFrame = "flex flex-col min-w-0 p-landing-pricing-card-inset";

export const card = cva("rounded-panel border bg-surface-panel", {
  variants: {
    variant: {
      landingDemo: "w-full overflow-hidden rounded-landing-demo-card border-border-default bg-surface-panel text-brand-navy shadow-landing-demo-card",
      landingDemoSurface: "rounded-landing-demo-surface border-border-default bg-surface-panel",
      landingFeature: "grid grid-cols-[minmax(0,1fr)_172px] items-center gap-4.5 min-w-0 min-h-[310px] p-landing-feature-card-inset overflow-hidden border-border-default shadow-landing-feature-card landing-wide:grid-cols-[minmax(0,1fr)_130px] landing-wide:p-6 landing-wide:landing-stack:grid-cols-[minmax(0,1fr)_145px] landing-wide:landing-stack:landing-narrow:grid-cols-[1fr_100px] landing-wide:landing-stack:landing-narrow:gap-2.5 landing-wide:landing-stack:landing-narrow:min-h-[240px] landing-wide:landing-stack:landing-narrow:p-landing-feature-card-narrow-inset",
      landingPlan: `${landingPlanFrame} border-border-default shadow-landing-pricing-card`,
      landingPlanFeatured: `${landingPlanFrame} border-brand-blue shadow-landing-pricing-featured-card`,
      landingGlass: "rounded-landing-glass-panel border-surface-panel/45 shadow-landing-glass-panel backdrop-blur-[16px]",
      default: "border-border-default",
      selected: "border-action-primary",
      danger: "border-status-danger-border"
    }
  },
  defaultVariants: { variant: "default" }
});

export const Card = forwardRef<HTMLElement, CardProps>(function Card({ tone = "default", variant = tone, className, children, ...props }, ref) {
  return <section {...props} ref={ref} data-variant={variant} className={cn(card({ variant }), className)}>{children}</section>;
});
