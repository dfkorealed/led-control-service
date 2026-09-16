import { Confirmation, type ConfirmDialogProps } from "./ui/ConfirmDialog";
export { useDialogFocus } from "./ui/overlays/useDialogFocus";

/** @deprecated Import from components/ui after page migration. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return <Confirmation {...props} closeLabel={props.closeLabel ?? `${props.title} 닫기`} compatibility="operator" />;
}
