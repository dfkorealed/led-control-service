import { forwardRef, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { ButtonProps as AriaButtonProps } from "react-aria-components";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Pick<AriaButtonProps, "isDisabled" | "onPress"> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "link";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  loadingLabel?: string;
  children: ReactNode;
}

const button = cva("ui-button inline-flex min-h-11 items-center justify-center gap-2 rounded-control border font-bold cursor-pointer focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60", {
  variants: {
    variant: {
      primary: "ui-button-primary border-action-primary bg-action-primary text-content-inverse hover:enabled:border-action-primary-hover hover:enabled:bg-action-primary-hover active:enabled:bg-action-primary-active",
      secondary: "ui-button-secondary border-border-default bg-action-secondary text-action-primary",
      ghost: "ui-button-ghost border-border-default bg-surface-panel text-action-primary",
      danger: "ui-button-danger border-action-danger-border bg-action-danger-background text-action-danger-foreground",
      link: "ui-button-link border-transparent bg-transparent text-action-primary underline underline-offset-4 hover:enabled:text-action-primary-hover"
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
  // Keep a native button until the legacy modal focus selector is migrated.
  // React Aria Button injects tabindex=0, which changes that selector's initial
  // focus target. Native keyboard activation already emits exactly one click;
  // the adapter observes its origin and never synthesizes a second activation.
  return <button ref={ref} {...props} disabled={disabled || isDisabled || isLoading} aria-busy={isLoading || props["aria-busy"]} className={cn(button({ variant, size }), className)}
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
        x: event.clientX - bounds.left, y: event.clientY - bounds.top,
        continuePropagation: () => { propagate = true; }
      });
      if (!propagate) event.stopPropagation();
    }}
  >{isLoading ? loadingLabel : children}</button>;
});
