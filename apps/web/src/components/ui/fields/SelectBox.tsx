import { forwardRef, type ReactElement, type Ref } from "react";
import { Button, ListBox, ListBoxItem, Popover, Select, SelectValue, Text, type SelectProps } from "react-aria-components";
import { FormField, fieldAria } from "./FormField";
import { cn } from "../utils/cn";
import type { FieldKey, SelectItem, SelectionVisualProps } from "./field-types";

export interface SelectBoxProps<T extends FieldKey> extends SelectionVisualProps, Omit<SelectProps<SelectItem<T>>, keyof SelectionVisualProps | "children" | "style" | "render" | "selectedKey" | "defaultSelectedKey" | "onSelectionChange" | "value" | "defaultValue" | "onChange" | "disabledKeys" | "selectionMode"> {
  items: ReadonlyArray<SelectItem<T>>;
  selectedKey?: T | null;
  defaultSelectedKey?: T | null;
  onSelectionChange?(key: T | null): void;
}

/** Resolve via the collection to retain numeric/string identity, including key 0. */
export function selectedItemKey<T extends FieldKey>(items: ReadonlyArray<SelectItem<T>>, key: FieldKey | null): T | null {
  return key === null ? null : items.find((item) => item.id === key)?.id ?? null;
}
export function SelectionOptions<T extends FieldKey>({ items }: { items: ReadonlyArray<SelectItem<T>> }) {
  return <Popover className="max-h-80 min-w-48 overflow-auto rounded-popover border border-border-default bg-surface-panel p-1 shadow-popover">
    <ListBox items={items} className="flex flex-col gap-1 outline-none">
      {(item) => <ListBoxItem id={item.id} textValue={item.label} className="flex min-h-11 cursor-pointer flex-col justify-center gap-1 rounded-control px-3 py-2 text-body text-content-primary outline-none data-focused:bg-action-primary-soft data-focus-visible:shadow-focus data-selected:bg-action-primary-soft data-selected:font-semibold data-disabled:cursor-not-allowed data-disabled:text-content-disabled">
        <Text slot="label">{item.label}</Text>
        {item.description && <Text slot="description" className="text-caption text-content-primary">{item.description}</Text>}
      </ListBoxItem>}
    </ListBox>
  </Popover>;
}
export const SelectBox = forwardRef(function SelectBox<T extends FieldKey>(
  { label, description, errorMessage, variant, size, className, id, items, selectedKey, defaultSelectedKey, onSelectionChange, ...props }: SelectBoxProps<T>, ref: Ref<HTMLButtonElement>
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <Select {...props} {...fieldAria(attributes, props)} className="contents" selectedKey={selectedKey} defaultSelectedKey={defaultSelectedKey}
      disabledKeys={items.filter((item) => item.isDisabled).map((item) => item.id)} onSelectionChange={(key) => onSelectionChange?.(selectedItemKey(items, key))}>
      <Button id={attributes.id} ref={ref} data-invalid={props.isInvalid || undefined} aria-labelledby={fieldAria(attributes, props)["aria-labelledby"]} className={cn(attributes.className, "flex items-center justify-between gap-2 text-left")}>
        <SelectValue /><span aria-hidden="true">▾</span>
      </Button>
      <SelectionOptions items={items} />
    </Select>}
  </FormField>;
}) as <T extends FieldKey>(props: SelectBoxProps<T> & { ref?: Ref<HTMLButtonElement> }) => ReactElement | null;
