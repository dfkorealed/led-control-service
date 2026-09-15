import { forwardRef, useId } from "react";
import { Radio, RadioGroup as AriaRadioGroup, type RadioGroupProps as AriaRadioGroupProps } from "react-aria-components";
import { Text } from "../Typography";
import { FormField, fieldAria } from "./FormField";
import { choiceControl, type ChoiceItem, type SelectionVisualProps } from "./field-types";

export interface RadioGroupProps extends SelectionVisualProps, Omit<AriaRadioGroupProps, keyof SelectionVisualProps | "children" | "style" | "render"> { items: ReadonlyArray<ChoiceItem> }
function RadioOption({ item, variant, size }: { item: ChoiceItem } & Pick<SelectionVisualProps, "variant" | "size">) {
  const descriptionId = useId();
  const labelId = useId();
  return <Radio value={item.value} isDisabled={item.isDisabled} aria-labelledby={labelId} aria-describedby={item.description ? descriptionId : undefined} className={choiceControl({ variant, size })}>
    <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-pill border border-border-strong bg-surface-panel group-data-selected:border-action-primary"><span className="h-3 w-3 rounded-pill group-data-selected:bg-action-primary" /></span>
    <span className="flex flex-col gap-1"><span id={labelId}>{item.label}</span>{item.description && <Text as="span" id={descriptionId} variant="caption">{item.description}</Text>}</span>
  </Radio>;
}
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  { label, description, errorMessage, variant, size, className, id, items, ...props }, ref
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} isGroup isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaRadioGroup {...props} {...fieldAria(attributes, props)} id={attributes.id} ref={ref} validationBehavior="aria" className={props.orientation === "horizontal" ? "flex flex-row flex-wrap gap-2" : "flex flex-col gap-2"}>
      {items.map((item) => <RadioOption key={item.value} item={item} variant={variant} size={size} />)}
    </AriaRadioGroup>}
  </FormField>;
});
