import { createElement, forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export interface UnderlineNavigationProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "nav";
  variant?: "default";
  trackClassName?: string;
}

const navigation = cva("w-full min-w-0 max-w-full self-start overflow-x-auto border-b border-border-default", { variants: { variant: { default: "" } } });
const navigationLabel = cva("inline-flex items-center justify-center gap-2", { variants: { variant: { default: "" } } });

export const UnderlineNavigation = forwardRef<HTMLElement, UnderlineNavigationProps>(function UnderlineNavigation({
  as = "nav",
  variant = "default",
  children,
  className,
  trackClassName,
  ...props
}, ref) {
  return createElement(
    as,
    { ...props, ref, className: cn(navigation({ variant }), className) },
    <div data-navigation-track className={cn("flex w-max min-w-full gap-2", trackClassName)}>{children}</div>
  );
});

export interface UnderlineNavigationLabelProps extends HTMLAttributes<HTMLSpanElement> { variant?: "default"; icon?: ReactNode }
export const UnderlineNavigationLabel = forwardRef<HTMLSpanElement, UnderlineNavigationLabelProps>(function UnderlineNavigationLabel({
  children,
  icon,
  variant = "default",
  className,
  ...props
}, ref) {
  return (
    <span {...props} ref={ref} className={cn(navigationLabel({ variant }), className)}>
      {icon ? <span className="inline-flex shrink-0" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </span>
  );
});
