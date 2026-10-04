import { forwardRef, useContext, useState, type ReactNode, type RefObject } from "react";
import { Dialog, OverlayTriggerStateContext, Popover as AriaPopover } from "react-aria-components";
import { cn } from "../utils/cn";
import { RegisteredPopoverContent } from "./RegisteredPopoverContent";

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
  const triggerState = useContext(OverlayTriggerStateContext);
  const [localOpen, setLocalOpen] = useState(props.defaultOpen ?? false);
  const controlledOpen = isOpen ?? open;
  const changeOpen = (next: boolean) => { setLocalOpen(next); props.onOpenChange?.(next); };
  const close = () => { if (controlledOpen != null || !triggerState) changeOpen(false); else triggerState.close(); };
  return <AriaPopover {...props} ref={ref} isOpen={controlledOpen ?? (triggerState ? undefined : localOpen)} onOpenChange={controlledOpen != null || !triggerState ? changeOpen : props.onOpenChange} placement={placement}
    className={cn("z-1000 max-h-80 max-w-[calc(100vw-24px)] overflow-auto rounded-popover border border-border-default bg-surface-panel text-body text-content-primary shadow-popover outline-none", variant === "menu" ? "min-w-48 p-1" : "p-4", className)}>
    <RegisteredPopoverContent onBack={close} isActive={controlledOpen ?? triggerState?.isOpen ?? localOpen} disabled={props.isKeyboardDismissDisabled}>{variant === "panel" ? <Dialog aria-label={ariaLabel ?? label} aria-labelledby={labelledBy} className="outline-none">{children}</Dialog> : children}</RegisteredPopoverContent>
  </AriaPopover>;
});
