import { forwardRef, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Dialog, Popover as AriaPopover } from "react-aria-components";
import { cn } from "../utils/cn";
import { registerOverlay } from "./overlay-stack";

export type PopoverPlacement = "top" | "bottom" | "left" | "right" | "top start" | "top end" | "bottom start" | "bottom end" | "left top" | "left bottom" | "right top" | "right bottom";
export interface PopoverProps {
  children: ReactNode;
  variant?: "panel" | "menu";
  placement?: PopoverPlacement;
  className?: string;
  label?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  isOpen?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(isOpen: boolean): void;
  triggerRef?: RefObject<Element | null>;
  isNonModal?: boolean;
  isKeyboardDismissDisabled?: boolean;
  shouldCloseOnInteractOutside?(element: Element): boolean;
  offset?: number;
  id?: string;
}

export const Popover = /* @__PURE__ */ forwardRef<HTMLElement, PopoverProps>(function Popover(
  { variant = "panel", placement = "bottom start", className, label, children, isOpen, open, "aria-label": ariaLabel, "aria-labelledby": labelledBy, ...props }, ref
) {
  return <AriaPopover {...props} ref={ref} isOpen={isOpen ?? open} placement={placement}
    className={cn("z-1000 max-h-80 max-w-[calc(100vw-24px)] overflow-auto rounded-popover border border-border-default bg-surface-panel text-body text-content-primary shadow-popover outline-none", variant === "menu" ? "min-w-48 p-1" : "p-4", className)}>
    <RegisteredPopover>{variant === "panel" ? <Dialog aria-label={ariaLabel ?? label} aria-labelledby={labelledBy} className="outline-none">{children}</Dialog> : children}</RegisteredPopover>
  </AriaPopover>;
});

function RegisteredPopover({ children }: { children: ReactNode }) {
  const token = useRef({});
  useLayoutEffect(() => { const unregister = registerOverlay(token.current); return () => { unregister(); }; }, []);
  return children;
}
