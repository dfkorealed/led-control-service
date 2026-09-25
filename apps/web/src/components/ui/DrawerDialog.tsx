import { forwardRef } from "react";
import type { ModalDialogProps } from "./ModalDialog";
import { DialogBase } from "./overlays/DialogBase";

export type DrawerDialogProps = ModalDialogProps;

export const DrawerDialog = /* @__PURE__ */ forwardRef<HTMLElement, DrawerDialogProps>(function DrawerDialog(props, ref) {
  return <DialogBase {...props} ref={ref} surface="drawer" />;
});
