import { X } from "lucide-react";
import { forwardRef, useEffect, useId, useLayoutEffect, useRef, type Ref } from "react";
import { mergeRefs, useFocusManager } from "react-aria";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "../Button";
import type { ModalDialogProps } from "../ModalDialog";
import { cn } from "../utils/cn";
import { focusConnected, registerOverlay } from "./overlay-stack";

// Only adapters select these hooks. Important utilities isolate the new visual
// source from unlayered operator/editor CSS until their page migrations.
export type DialogCompatibility = "operator" | "editor";
interface DialogBaseProps extends ModalDialogProps { compatibility?: DialogCompatibility }

export const DialogBase = /* @__PURE__ */ forwardRef<HTMLElement, DialogBaseProps>(function DialogBase(
  { isOpen, open, isPending = false, onClose, ...props }, ref
) {
  const visible = isOpen ?? open ?? true;
  const closing = useRef(false);
  const backdrop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { closing.current = false; }, [visible, isPending]);
  function requestClose() {
    if (isPending || closing.current) return;
    closing.current = true;
    onClose();
    queueMicrotask(() => { closing.current = false; });
  }
  return <ModalOverlay ref={backdrop} isOpen={visible} isDismissable={!isPending} isKeyboardDismissDisabled={isPending}
    shouldCloseOnInteractOutside={(target) => target !== backdrop.current}
    onOpenChange={(next) => { if (!next) requestClose(); }}
    className={cn("ui-modal-backdrop fixed! inset-0! z-1000! grid! items-end! justify-items-center! overflow-y-auto! bg-surface-inverse/50! p-3! compact:items-center! compact:p-6!", props.compatibility === "operator" && "operator-dialog-backdrop", props.compatibility === "editor" && "editor-dialog-backdrop")}
    data-testid="modal-backdrop"
    render={(domProps) => <div {...domProps} onMouseDown={(event) => {
      domProps.onMouseDown?.(event);
      if (event.target === event.currentTarget) requestClose();
    }} />}>
    <Modal className="w-full max-w-lg outline-none">
      <DialogContent {...props} isPending={isPending} onClose={requestClose} rootRef={ref} />
    </Modal>
  </ModalOverlay>;
});

function DialogContent({ title, description, children, actions, onClose, isPending, initialFocusRef,
  returnFocusRef, fallbackFocusRef, returnFocusElement, fallbackFocusElement, role = "dialog", closeLabel = "닫기", className, compatibility, rootRef
}: Omit<DialogBaseProps, "isOpen" | "open"> & { rootRef: Ref<HTMLElement> }) {
  const descriptionId = useId();
  const dialog = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const manager = useFocusManager();
  const token = useRef({});
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const latest = useRef({ returnFocusRef, fallbackFocusRef, returnFocusElement, fallbackFocusElement });
  latest.current = { returnFocusRef, fallbackFocusRef, returnFocusElement, fallbackFocusElement };
  useLayoutEffect(() => {
    const unregister = registerOverlay(token.current);
    return () => {
      if (!unregister()) return;
      // React removes sibling triggers after layout cleanup; refs stay live so
      // fallbacks mounted by the closing update can receive focus too.
      queueMicrotask(() => {
        const targets = latest.current;
        focusConnected([targets.returnFocusRef?.current, targets.returnFocusElement, opener.current,
          targets.fallbackFocusRef?.current, targets.fallbackFocusElement]);
      });
    };
    // Initial focus is a mount contract, never a rerender side effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // FocusScope registers its nodes in the parent's layout effect. The public
    // focus manager is ready in this passive effect, before user interaction.
    if (initialFocusRef?.current) initialFocusRef.current.focus();
    else if (!manager?.focusFirst({ tabbable: true, accept: (node) => !!body.current?.contains(node) })) dialog.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Dialog ref={mergeRefs(dialog, rootRef)} role={role} aria-describedby={description ? descriptionId : undefined}
    render={(domProps) => <section {...domProps} aria-modal="true" />}
    className={cn("ui-modal-dialog w-full! max-h-[calc(100dvh-48px)] overflow-y-auto rounded-panel! border! border-border-default! bg-surface-panel! p-4.5! text-body text-content-primary shadow-popover! outline-none compact:p-6!", compatibility === "operator" && "operator-dialog", compatibility === "editor" && "editor-confirm-dialog", className)}>
    <header className={cn("ui-modal-header mb-4.5! flex! items-start! justify-between! gap-4!", compatibility === "operator" && "operator-dialog-header")}>
      <div className="min-w-0">
        <Heading slot="title" className="m-0! text-card-title! font-bold text-content-primary!">{title}</Heading>
        {description ? <div id={descriptionId} className="ui-modal-description mt-1.5 text-body-sm text-content-secondary">{description}</div> : null}
      </div>
      <Button type="button" variant="ghost" className={cn("ui-modal-close h-11! min-h-11! w-11! min-w-11! shrink-0 p-0!", compatibility === "operator" && "icon-button")}
        aria-label={closeLabel} title={closeLabel} disabled={isPending} onClick={onClose}><X size={20} aria-hidden="true" /></Button>
    </header>
    <div ref={body} className="ui-modal-body min-w-0 break-words">{children}</div>
    {actions ? <footer className={cn("ui-modal-actions mt-5! flex! flex-wrap! justify-end! gap-2!", compatibility === "operator" && "operator-dialog-actions", compatibility === "editor" && "floor-editor-actions")}>{actions}</footer> : null}
  </Dialog>;
}
