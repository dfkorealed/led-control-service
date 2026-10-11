import { forwardRef, useContext, useEffect, useState, type ReactNode, type RefObject } from "react";
import { Dialog, Modal, ModalOverlay, OverlayTriggerStateContext, Popover as AriaPopover } from "react-aria-components";
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
  mobilePresentation?: "popover" | "bottom-sheet";
}

export const Popover = /* @__PURE__ */ forwardRef<HTMLElement, PopoverProps>(function Popover(
  { variant = "panel", placement = "bottom start", className, label, children, isOpen, open, mobilePresentation = "popover", "aria-label": ariaLabel, "aria-labelledby": labelledBy, ...props }, ref
) {
  const [mobile, setMobile] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(width < 760px)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(width < 760px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update); update();
    return () => query.removeEventListener("change", update);
  }, []);
  const triggerState = useContext(OverlayTriggerStateContext);
  const [localOpen, setLocalOpen] = useState(props.defaultOpen ?? false);
  const controlledOpen = isOpen ?? open;
  const changeOpen = (next: boolean) => { setLocalOpen(next); props.onOpenChange?.(next); };
  const close = () => { if (controlledOpen != null || !triggerState) changeOpen(false); else triggerState.close(); };
  if (mobilePresentation === "bottom-sheet" && mobile) return <ModalOverlay
    isOpen={controlledOpen ?? (triggerState ? undefined : localOpen)}
    onOpenChange={controlledOpen != null || !triggerState ? changeOpen : props.onOpenChange}
    isDismissable={!props.isKeyboardDismissDisabled} isKeyboardDismissDisabled={props.isKeyboardDismissDisabled}
    shouldCloseOnInteractOutside={props.shouldCloseOnInteractOutside}
    className="fixed inset-0 z-1000 grid items-end bg-surface-inverse/50">
    <Modal className="min-h-0 w-full translate-y-0 transition-transform duration-200 data-entering:translate-y-full data-exiting:translate-y-full motion-reduce:transition-none">
      <RegisteredPopoverContent onBack={close} isActive={controlledOpen ?? triggerState?.isOpen ?? localOpen} disabled={props.isKeyboardDismissDisabled}>
        <Dialog ref={ref} id={props.id} aria-label={ariaLabel ?? label} aria-labelledby={labelledBy}
          render={domProps => <section {...domProps} aria-modal="true" />}
          // The approved panel token owns top corners; zero bottom corners keep
          // this full-width surface flush with the viewport edge.
          style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}
          className="max-h-[calc(100dvh-24px)] min-w-0 overflow-y-auto rounded-panel border border-border-default bg-surface-panel p-4 pb-safe-area-bottom text-body text-content-primary shadow-popover outline-none">
          {children}
        </Dialog>
      </RegisteredPopoverContent>
    </Modal>
  </ModalOverlay>;
  return <AriaPopover {...props} ref={ref} isOpen={controlledOpen ?? (triggerState ? undefined : localOpen)} onOpenChange={controlledOpen != null || !triggerState ? changeOpen : props.onOpenChange} placement={placement}
    className={cn("z-1000 max-h-80 max-w-[calc(100vw-24px)] overflow-auto rounded-popover border border-border-default bg-surface-panel text-body text-content-primary shadow-popover outline-none", variant === "menu" ? "min-w-48 p-1" : "p-4", className)}>
    <RegisteredPopoverContent onBack={close} isActive={controlledOpen ?? triggerState?.isOpen ?? localOpen} disabled={props.isKeyboardDismissDisabled}>{variant === "panel" ? <Dialog aria-label={ariaLabel ?? label} aria-labelledby={labelledBy} className="outline-none">{children}</Dialog> : children}</RegisteredPopoverContent>
  </AriaPopover>;
});
