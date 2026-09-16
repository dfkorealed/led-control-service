import { useLayoutEffect, useRef, type RefObject } from "react";
import { focusConnected, isTopOverlay, registerOverlay } from "./overlay-stack";

/**
 * @deprecated Task 8/11 page migrations replace this ref-only bridge with
 * ModalDialog. Without JSX ownership it cannot install FocusScope sentinels:
 * native Tab runs normally and escaped focus returns to the initial/root ref.
 * The temporary Escape-only document listener preserves legacy consumers.
 */
export function useDialogFocus({ open, dialogRef, returnFocusElement, fallbackFocusElement, onClose, initialFocusRef }: {
  open: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  returnFocusElement?: HTMLElement | null;
  fallbackFocusElement?: HTMLElement | null;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const latest = useRef({ onClose, returnFocusElement, fallbackFocusElement });
  latest.current = { onClose, returnFocusElement, fallbackFocusElement };
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const token = {};
    const unregister = registerOverlay(token);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocusRef?.current ?? dialog).focus();
    const onFocus = (event: FocusEvent) => {
      if (isTopOverlay(token) && event.target instanceof Node && !dialog.contains(event.target)) {
        (initialFocusRef?.current ?? dialog).focus();
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopOverlay(token) || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); latest.current.onClose();
    };
    document.addEventListener("focusin", onFocus);
    // This listener never handles Tab or other keys. New overlays own their
    // keyboard/focus behavior through React Aria, and supersede this registry.
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onEscape);
      if (unregister()) queueMicrotask(() => focusConnected([latest.current.returnFocusElement, opener, latest.current.fallbackFocusElement]));
    };
  }, [open, dialogRef, initialFocusRef]);
}
