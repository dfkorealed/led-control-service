import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

export function ConfirmDialog({ title, children, confirmLabel, onCancel, onConfirm, disabled = false }: {
  title: string; children: ReactNode; confirmLabel: string; onCancel: () => void; onConfirm: () => void; disabled?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(
    <div className="editor-dialog-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="editor-dialog-title" className="editor-confirm-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          if (event.key !== "Tab") return;
          const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
          if (!buttons?.length) return;
          if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1].focus(); }
          if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus(); }
        }}>
        <h3 id="editor-dialog-title">{title}</h3>
        <div>{children}</div>
        <div className="floor-editor-actions">
          <Button ref={cancel} variant="secondary" onClick={onCancel}>취소</Button>
          <Button variant="primary" onClick={onConfirm} disabled={disabled}>{confirmLabel}</Button>
        </div>
      </div>
    </div>, document.body
  );
}
