import { forwardRef, type ReactNode, type RefObject } from "react";
import { DialogBase } from "./overlays/DialogBase";

export interface ModalDialogProps {
  isOpen?: boolean;
  /** @deprecated Prefer isOpen, which takes precedence over open. */
  open?: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  isPending?: boolean;
  /** Also accepts a field handle whose focus method targets its editable segment. */
  initialFocusRef?: RefObject<{ focus(): void } | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  returnFocusElement?: HTMLElement | null;
  fallbackFocusElement?: HTMLElement | null;
  role?: "dialog" | "alertdialog";
  closeLabel?: string;
  className?: string;
  bodyClassName?: string;
}

export const ModalDialog = /* @__PURE__ */ forwardRef<HTMLElement, ModalDialogProps>(function ModalDialog(props, ref) {
  return <DialogBase {...props} ref={ref} />;
});
