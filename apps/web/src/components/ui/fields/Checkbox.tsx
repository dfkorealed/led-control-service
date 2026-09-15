import { forwardRef, useId } from "react";
import { Checkbox as AriaCheckbox, CheckboxGroup as AriaCheckboxGroup, type CheckboxProps as AriaCheckboxProps, type CheckboxGroupProps as AriaCheckboxGroupProps } from "react-aria-components";
import { Text } from "../Typography";
import { FormField, fieldAria } from "./FormField";
import { choiceControl, type ChoiceItem, type SelectionVisualProps } from "./field-types";

export interface CheckboxProps extends SelectionVisualProps, Omit<AriaCheckboxProps, keyof SelectionVisualProps | "children" | "style" | "render" | "inputRef"> {}
export interface CheckboxGroupProps extends SelectionVisualProps, Omit<AriaCheckboxGroupProps, keyof SelectionVisualProps | "children" | "style" | "render"> { items: ReadonlyArray<ChoiceItem> }

export function CheckboxIndicator() {
  return <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface-panel text-content-inverse group-data-selected:border-action-primary group-data-selected:bg-action-primary"><span className="invisible group-data-selected:visible">✓</span></span>;
}
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, errorMessage, variant, size, className, id, ...props }, ref
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} labelPlacement="inline" isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes, inlineLabel) => <AriaCheckbox {...props} {...fieldAria(attributes, props)} inputRef={ref} validationBehavior="aria" className={choiceControl({ variant, size })}>
      <CheckboxIndicator />{inlineLabel}
    </AriaCheckbox>}
  </FormField>;
});
function CheckboxOption({ item, variant, size }: { item: ChoiceItem } & Pick<SelectionVisualProps, "variant" | "size">) {
  const descriptionId = useId();
  const labelId = useId();
  return <AriaCheckbox value={item.value} isDisabled={item.isDisabled} aria-labelledby={labelId} aria-describedby={item.description ? descriptionId : undefined} className={choiceControl({ variant, size })}>
    <CheckboxIndicator /><span className="flex flex-col gap-1"><span id={labelId}>{item.label}</span>{item.description && <Text as="span" id={descriptionId} variant="caption">{item.description}</Text>}</span>
  </AriaCheckbox>;
}
export const CheckboxGroup = forwardRef<HTMLDivElement, CheckboxGroupProps>(function CheckboxGroup(
  { label, description, errorMessage, variant, size, className, id, items, ...props }, ref
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} isGroup isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaCheckboxGroup {...props} {...fieldAria(attributes, props)} id={attributes.id} ref={ref} validationBehavior="aria" className="flex flex-col gap-2">
      {items.map((item) => <CheckboxOption key={item.value} item={item} variant={variant} size={size} />)}
    </AriaCheckboxGroup>}
  </FormField>;
});
