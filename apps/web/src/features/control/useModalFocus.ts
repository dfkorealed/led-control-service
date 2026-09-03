import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function useModalFocus({
  open,
  suspended = false,
  dialogRef,
  returnFocusRef,
  onClose
}: {
  open: boolean;
  suspended?: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  const suspendedRef = useRef(suspended);
  onCloseRef.current = onClose;
  suspendedRef.current = suspended;

  useLayoutEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const dialogElement: HTMLElement = dialog;
    const activeElement = document.activeElement;
    const restoreTarget = returnFocusRef?.current
      ?? (activeElement instanceof HTMLElement ? activeElement : null);

    const focusableElements = () => Array.from(dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const initialTarget = focusableElements()[0] ?? dialogElement;
    initialTarget.focus();

    function handleKeyDown(event: KeyboardEvent) {
      // A nested modal owns Escape and Tab until it closes; keeping this effect mounted
      // preserves the parent dialog's original focus restoration target.
      if (suspendedRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        dialogElement.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogElement.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogElement.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, [dialogRef, open, returnFocusRef]);
}
