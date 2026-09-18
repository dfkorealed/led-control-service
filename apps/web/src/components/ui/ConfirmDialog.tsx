import { forwardRef, useRef, type Ref } from "react";
import { Button } from "./Button";
import type { ModalDialogProps } from "./ModalDialog";
import { DialogBase } from "./overlays/DialogBase";
import { cn } from "./utils/cn";

interface ConfirmDialogBaseProps extends Omit<ModalDialogProps, "actions" | "onClose"> {
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  disabled?: boolean;
  confirmDisabled?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
}

/** At least one dismissal callback is required; onCancel wins when both exist. */
export type ConfirmDialogProps = ConfirmDialogBaseProps & (
  | { onCancel: () => void; onClose?: () => void }
  | { onCancel?: never; onClose: () => void }
);

export const ConfirmDialog = /* @__PURE__ */ forwardRef<HTMLElement, ConfirmDialogProps>(function ConfirmDialog(props, ref) {
  return <Confirmation {...props} className={cn("max-w-110!", props.className)} rootRef={ref} />;
});

/** Shared confirmation renderer keeps focus and dismissal behavior centralized. */
export function Confirmation({ confirmLabel, cancelLabel = "취소", tone, destructive, disabled, confirmDisabled, onCancel, onClose, onConfirm,
  initialFocusRef, isPending = false, rootRef, ...props
}: ConfirmDialogProps & { rootRef?: Ref<HTMLElement> }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const dismiss = () => { if (!isPending) (onCancel ?? onClose)?.(); };
  return <DialogBase {...props} ref={rootRef} isPending={isPending} initialFocusRef={initialFocusRef ?? cancel} onClose={dismiss}
    actions={<>
      <Button ref={cancel} type="button" variant="secondary" disabled={isPending} onClick={dismiss}>{cancelLabel}</Button>
      <Button type="button" variant={tone ?? (destructive ? "danger" : "primary")} disabled={isPending || disabled || confirmDisabled}
        onClick={() => { if (!isPending && !disabled && !confirmDisabled) onConfirm(); }}>{isPending ? "처리 중" : confirmLabel}</Button>
    </>} />;
}
