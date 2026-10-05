import { forwardRef, type ReactElement, type Ref } from "react";
import { Ellipsis } from "lucide-react";
import { DropdownMenu, type DropdownMenuProps, type MenuKey } from "./overlays/DropdownMenu";

export type RowActionsProps<K extends MenuKey> = Omit<DropdownMenuProps<K>, "label" | "triggerIcon"> & { rowLabel: string };
/** Existing menu semantics own keyboard/focus. Destructive confirmation stays in the row's caller. */
export const RowActions = /* @__PURE__ */ forwardRef(function RowActions<K extends MenuKey>(
  { rowLabel, variant = "ghost", size = "sm", items, isDisabled = false, onAction, ...props }: RowActionsProps<K>, ref: Ref<HTMLButtonElement>
) {
  // Disabling the trigger alone does not lock a menu which is already open.
  // Keep its typed collection, keyboard semantics and caller-owned permission.
  const guardedItems = isDisabled ? items.map(item => ({ ...item, isDisabled: true })) : items;
  return <DropdownMenu {...props} items={guardedItems} isDisabled={isDisabled} onAction={key => { if (!isDisabled) onAction(key); }}
    ref={ref} label={`${rowLabel} 작업`} triggerIcon={Ellipsis} variant={variant} size={size} />;
}) as <K extends MenuKey>(props: RowActionsProps<K> & { ref?: Ref<HTMLButtonElement> }) => ReactElement;
