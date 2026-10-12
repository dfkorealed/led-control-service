import { X } from "lucide-react";
import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { useFocusManager } from "react-aria";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "../Button";
import type { ModalDialogProps } from "../ModalDialog";
import { cn } from "../utils/cn";
import { focusConnected, registerOverlay } from "./overlay-stack";

type DialogSurface = "modal" | "drawer" | "sheet";
type DialogBaseProps = ModalDialogProps & { surface?: DialogSurface };

const overlayClass = {
  modal: "fixed! inset-0! z-1000! grid! items-end! justify-items-center! overflow-y-auto! bg-surface-inverse/50! p-3! compact:items-center! compact:p-6!",
  drawer: "fixed! inset-0! z-1000! grid! items-stretch! justify-items-end! overflow-hidden! bg-surface-inverse/50! p-0!",
  sheet: "fixed! inset-0! z-1000! grid! items-end! justify-items-center! overflow-hidden! bg-surface-inverse/50! p-0!"
} satisfies Record<DialogSurface, string>;

const surfaceClass = {
  modal: "w-[min(var(--container-lg),100%)] max-h-[calc(100dvh-48px)] overflow-y-auto rounded-panel! border! border-border-default! bg-surface-panel! p-4.5! text-body text-content-primary shadow-popover! outline-none compact:p-6!",
  drawer: "h-dvh w-full max-w-status-drawer overflow-y-auto border-l! border-border-default! bg-surface-panel! p-4.5! text-body text-content-primary shadow-popover! outline-none compact:p-6!",
  sheet: "flex max-h-dvh min-h-0 w-full flex-col overflow-hidden rounded-panel! border! border-border-default! bg-surface-panel! p-0! text-body text-content-primary shadow-popover! outline-none"
} satisfies Record<DialogSurface, string>;

export const DialogBase = /* @__PURE__ */ forwardRef<HTMLElement, DialogBaseProps>(function DialogBase(
  { isOpen, open, isPending = false, onClose, surface = "modal", placement, ...props }, ref
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
    className={surface === "modal" && placement === "center"
      ? "fixed! inset-0! z-1000! grid! items-center! justify-items-center! overflow-y-auto! bg-surface-inverse/50! p-3! compact:p-6!"
      : overlayClass[surface]}
    data-testid="modal-backdrop"
    render={(domProps) => <div {...domProps} onMouseDown={(event) => {
      domProps.onMouseDown?.(event);
      if (event.target === event.currentTarget) requestClose();
    }} />}>
    {/* The public Dialog root owns width. A layout-neutral wrapper avoids
        clamping caller CSS and leaves the surrounding backdrop dismissable. */}
    <Modal className="contents outline-none">
      <DialogContent {...props} isPending={isPending} onClose={requestClose} rootRef={ref} surface={surface} />
    </Modal>
  </ModalOverlay>;
});

function DialogContent({ title, description, children, actions, onClose, isPending, initialFocusRef,
  returnFocusRef, fallbackFocusRef, returnFocusElement, fallbackFocusElement, role = "dialog", closeLabel = "닫기", className, bodyClassName, safeArea = false, rootRef, surface = "modal"
}: Omit<DialogBaseProps, "isOpen" | "open"> & { rootRef: Ref<HTMLElement> }) {
  const descriptionId = useId();
  const dialog = useRef<HTMLElement>(null);
  // Keep RAC's internal ref identity stable: replacing a merged callback reruns
  // its initial-focus effect and steals focus from a portalled child. Forward
  // the live physical root separately; React cleans/reassigns external refs
  // when their identity changes without restarting the dialog focus contract.
  useImperativeHandle(rootRef, () => dialog.current!, []);
  const body = useRef<HTMLDivElement>(null);
  const manager = useFocusManager();
  const token = useRef({});
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const latest = useRef({ returnFocusRef, fallbackFocusRef, returnFocusElement, fallbackFocusElement, onClose, isPending });
  latest.current = { returnFocusRef, fallbackFocusRef, returnFocusElement, fallbackFocusElement, onClose, isPending };
  useLayoutEffect(() => {
    const unregister = registerOverlay(token.current, () => { if (!latest.current.isPending) latest.current.onClose(); });
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
  const isSheet = surface === "sheet";
  const content = <>
    <header className="mb-4.5! flex! items-start! justify-between! gap-4!" data-dialog-header="">
      <div className="min-w-0">
        <Heading slot="title" className="m-0! text-card-title! font-bold text-content-primary!">{title}</Heading>
        {description ? <div id={descriptionId} className="mt-1.5 text-body-sm text-content-secondary" data-dialog-description="">{description}</div> : null}
      </div>
      <Button type="button" variant="ghost" className="size-13! min-h-13! min-w-13! shrink-0 p-0!" data-dialog-close=""
        aria-label={closeLabel} title={closeLabel} disabled={isPending} onClick={onClose}><X size={20} aria-hidden="true" /></Button>
    </header>
    <div ref={body} className={cn("min-w-0 break-words", isSheet && "min-h-0 flex-1 overflow-y-auto pb-4.5", bodyClassName)} data-dialog-body="">{children}</div>
    {actions ? <footer className={cn("mt-5! flex! flex-wrap! justify-end! gap-2!", isSheet && "shrink-0 pb-4.5")} data-dialog-actions="">{actions}</footer> : null}
  </>;
  return <Dialog ref={dialog} role={role} aria-describedby={description ? descriptionId : undefined} data-dialog-surface="" data-dialog-variant={surface}
    render={(domProps) => <section {...domProps} aria-modal="true" />}
    className={cn(surfaceClass[surface], className, safeArea && "p-0! compact:p-0!")}>
    {/* The opt-in wrapper or legacy sheet wrapper owns the insets, never both.
        Body/actions must not add shell navigation space or duplicate insets. */}
    {safeArea ? <div data-dialog-safe-area="" className="flex min-h-0 flex-1 flex-col overflow-hidden pt-safe-area-top pb-safe-area-bottom">
      {/* Insets belong only to this wrapper. Preserve the ordinary surface
          spacing inside it, without shell-nav space or a second sheet inset. */}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", isSheet ? "px-4.5 pt-4.5" : "p-4.5 compact:p-6")}>{content}</div>
    </div> : isSheet ? <div className="flex min-h-0 flex-col overflow-hidden px-4.5 pt-4.5 pb-safe-area-bottom">{content}</div> : content}
  </Dialog>;
}
