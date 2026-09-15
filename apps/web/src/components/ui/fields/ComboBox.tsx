import { forwardRef, type ReactElement, type Ref } from "react";
import { Button, ComboBox as AriaComboBox, Input, type ComboBoxProps as AriaComboBoxProps } from "react-aria-components";
import { FormField, fieldAria } from "./FormField";
import { SelectionOptions, selectedItemKey } from "./SelectBox";
import type { FieldKey, SelectItem, SelectionVisualProps } from "./field-types";

export interface ComboBoxProps<T extends FieldKey> extends SelectionVisualProps, Omit<AriaComboBoxProps<SelectItem<T>>, keyof SelectionVisualProps | "children" | "style" | "render" | "items" | "defaultItems" | "selectedKey" | "defaultSelectedKey" | "onSelectionChange" | "value" | "defaultValue" | "onChange" | "disabledKeys" | "selectionMode"> {
  items: ReadonlyArray<SelectItem<T>>;
  selectedKey?: T | null;
  defaultSelectedKey?: T | null;
  onSelectionChange?(key: T | null): void;
  placeholder?: string;
}
export const ComboBox = forwardRef(function ComboBox<T extends FieldKey>(
  { label, description, errorMessage, variant, size, className, id, items, placeholder, selectedKey, defaultSelectedKey, onSelectionChange, ...props }: ComboBoxProps<T>, ref: Ref<HTMLInputElement>
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaComboBox {...props} {...fieldAria(attributes, props)} validationBehavior="aria" className="contents" defaultItems={items} selectedKey={selectedKey} defaultSelectedKey={defaultSelectedKey}
      disabledKeys={items.filter((item) => item.isDisabled).map((item) => item.id)} onSelectionChange={(key) => onSelectionChange?.(selectedItemKey(items, key))}>
      <div className="flex items-center gap-2">
        <Input id={attributes.id} ref={ref} placeholder={placeholder} className={attributes.className} />
        <Button className="flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border-strong bg-surface-panel text-content-primary outline-none data-focus-visible:shadow-focus data-disabled:opacity-60"><span aria-hidden="true">▾</span></Button>
      </div>
      <SelectionOptions items={items} />
    </AriaComboBox>}
  </FormField>;
}) as <T extends FieldKey>(props: ComboBoxProps<T> & { ref?: Ref<HTMLInputElement> }) => ReactElement | null;
