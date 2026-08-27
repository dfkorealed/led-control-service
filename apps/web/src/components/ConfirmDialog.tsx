import { X } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function useDialogFocus({
  open,
  dialogRef,
  returnFocusElement,
  onClose,
  initialFocusRef
}: {
  open: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  returnFocusElement?: HTMLElement | null;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    // Capture the narrowed element for callbacks created inside this effect.
    const dialogElement: HTMLElement = dialog;
    const restoreTarget = returnFocusElement ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusable = () => Array.from(dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    (initialFocusRef?.current ?? focusable()[0] ?? dialogElement).focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const elements = focusable();
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

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, [dialogRef, initialFocusRef, open, returnFocusElement]);
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  isPending?: boolean;
  confirmDisabled?: boolean;
  destructive?: boolean;
  returnFocusElement?: HTMLElement | null;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "취소",
  isPending = false,
  confirmDisabled = false,
  destructive = false,
  returnFocusElement,
  initialFocusRef,
  children,
  onConfirm,
  onClose
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus({ open, dialogRef, returnFocusElement, onClose, initialFocusRef });

  if (!open) return null;
  const titleId = "confirm-dialog-title";
  const descriptionId = description ? "confirm-dialog-description" : undefined;

  return (
    <div className="operator-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !isPending) onClose();
    }}>
      <section
        ref={dialogRef}
        className="operator-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="operator-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" type="button" aria-label={`${title} 닫기`} onClick={onClose} disabled={isPending}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {description ? <p id={descriptionId} className="operator-dialog-description">{description}</p> : null}
        {children}
        <footer className="operator-dialog-actions">
          <button type="button" onClick={onClose} disabled={isPending}>{cancelLabel}</button>
          <button
            className={destructive ? "danger-button" : "primary-button"}
            type="button"
            onClick={onConfirm}
            disabled={isPending || confirmDisabled}
          >
            {isPending ? "처리 중" : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
