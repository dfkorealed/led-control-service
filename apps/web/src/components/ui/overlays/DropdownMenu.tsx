import { forwardRef, type ReactElement, type Ref } from "react";
import { Button, Menu, MenuItem, MenuTrigger, Text } from "react-aria-components";
import { cn } from "../utils/cn";
import { Popover, type PopoverPlacement } from "./Popover";

export type MenuKey = string | number;
export interface DropdownItem<T extends MenuKey> { id: T; label: string; description?: string; isDisabled?: boolean }
export interface DropdownMenuProps<T extends MenuKey> {
  label: string;
  menuLabel?: string;
  items: ReadonlyArray<DropdownItem<T>>;
  onAction(key: T): void;
  isDisabled?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  placement?: PopoverPlacement;
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(isOpen: boolean): void;
  id?: string;
}
const variants = {
  primary: "border-action-primary bg-action-primary text-content-inverse data-hovered:bg-action-primary-hover",
  secondary: "border-border-default bg-action-secondary text-action-primary",
  ghost: "border-transparent bg-transparent text-action-primary"
};
const sizes = { sm: "px-3 py-2 text-body-sm", md: "px-4 py-2.5 text-body", lg: "min-h-12 px-6 py-3 text-body-lg" };

export const DropdownMenu = /* @__PURE__ */ forwardRef(function DropdownMenu<T extends MenuKey>(
  { label, menuLabel = label, items, onAction, isDisabled, variant = "secondary", size = "md", className, placement, isOpen, defaultOpen, onOpenChange, id }: DropdownMenuProps<T>, ref: Ref<HTMLButtonElement>
) {
  return <MenuTrigger isOpen={isOpen} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
    <Button ref={ref} id={id} isDisabled={isDisabled} className={cn("inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-control border font-semibold outline-none data-focus-visible:shadow-focus data-disabled:cursor-not-allowed data-disabled:opacity-60", variants[variant], sizes[size], className)}>{label}<span aria-hidden="true">▾</span></Button>
    <Popover variant="menu" placement={placement}>
      <Menu aria-label={menuLabel} items={items} disabledKeys={items.filter(item => item.isDisabled).map(item => item.id)} className="flex flex-col gap-1 outline-none"
        onAction={(key) => {
          // Resolve through the typed collection to retain identity, including
          // numeric 0 and string "0", without casting React Aria's wider Key.
          const item = items.find(item => item.id === key);
          if (item && !item.isDisabled) onAction(item.id);
        }}>
        {item => <MenuItem id={item.id} textValue={item.label} className="flex min-h-11 cursor-pointer flex-col justify-center gap-1 rounded-control px-3 py-2 text-body text-content-primary outline-none data-focused:bg-action-primary-soft data-focus-visible:shadow-focus data-disabled:cursor-not-allowed data-disabled:text-content-disabled">
          <Text slot="label">{item.label}</Text>
          {item.description && <Text slot="description" className="text-caption text-content-secondary">{item.description}</Text>}
        </MenuItem>}
      </Menu>
    </Popover>
  </MenuTrigger>;
}) as <T extends MenuKey>(props: DropdownMenuProps<T> & { ref?: Ref<HTMLButtonElement> }) => ReactElement | null;
