import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export type CardTone = "default" | "selected" | "danger";

export interface CardProps extends HTMLAttributes<HTMLElement> { tone?: CardTone; variant?: CardTone; children: ReactNode }
export const card = cva("rounded-panel border bg-surface-panel", {
  variants: { variant: { default: "border-border-default", selected: "border-action-primary", danger: "border-status-danger-border" } },
  defaultVariants: { variant: "default" }
});

export const Card = forwardRef<HTMLElement, CardProps>(function Card({ tone = "default", variant = tone, className, children, ...props }, ref) {
  return <section {...props} ref={ref} data-variant={variant} className={cn(card({ variant }), className)}>{children}</section>;
});
