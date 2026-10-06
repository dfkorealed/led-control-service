import { forwardRef } from "react";
import type { ModalDialogProps } from "./ModalDialog";
import { DialogBase } from "./overlays/DialogBase";

export type DetailSheetProps = ModalDialogProps;

export const DetailSheet = /* @__PURE__ */ forwardRef<HTMLElement, DetailSheetProps>(function DetailSheet(props, ref) {
  return <DialogBase {...props} ref={ref} surface="sheet" />;
});
