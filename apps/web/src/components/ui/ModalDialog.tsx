import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import "./ModalDialog.css";

const focusableSelector = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export interface ModalDialogProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  isPending?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFocusElement?: HTMLElement | null;
  role?: "dialog" | "alertdialog";
  className?: string;
}

export function ModalDialog({
  title,
  description,
  children,
  actions,
  onClose,
  isPending = false,
  initialFocusRef,
  returnFocusElement,
  role = "dialog",
  className = ""
}: ModalDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(returnFocusElement ?? null);

  useEffect(() => {
    if (!previousFocusRef.current) previousFocusRef.current = document.activeElement as HTMLElement | null;
    const target = initialFocusRef?.current
      ?? dialogRef.current?.querySelector<HTMLElement>(`.ui-modal-body ${focusableSelector}`)
      ?? dialogRef.current?.querySelector<HTMLElement>(focusableSelector)
      ?? dialogRef.current;
    target?.focus();

    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocusRef]);

  function requestClose() {
    if (!isPending) onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="ui-modal-backdrop"
      data-testid="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`ui-modal-dialog ${className}`.trim()}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="ui-modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <div id={descriptionId} className="ui-modal-description">{description}</div> : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="ui-modal-close"
            aria-label="닫기"
            title="닫기"
            disabled={isPending}
            onClick={requestClose}
          >
            <X size={20} aria-hidden="true" />
          </Button>
        </header>
        <div className="ui-modal-body">{children}</div>
        {actions ? <footer className="ui-modal-actions">{actions}</footer> : null}
      </div>
    </div>,
    document.body
  );
}
