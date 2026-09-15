import { forwardRef } from "react";
import { SwitchField, SwitchButton, type SwitchFieldProps } from "react-aria-components";
import { FormField, fieldAria } from "./FormField";
import { choiceControl, type SelectionVisualProps } from "./field-types";

export interface SwitchProps extends SelectionVisualProps, Omit<SwitchFieldProps, keyof SelectionVisualProps | "children" | "style" | "render" | "inputRef"> {}
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, description, errorMessage, variant, size, className, id, ...props }, ref
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} labelPlacement="inline" isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes, inlineLabel) => <SwitchField {...props} {...fieldAria(attributes, props)} id={attributes.id} inputRef={ref} className="contents">
      <SwitchButton className={choiceControl({ variant, size })}>
        <span aria-hidden="true" className="flex h-6 w-10 items-center rounded-pill border border-border-strong bg-surface-inset p-0.5 group-data-selected:border-action-primary group-data-selected:bg-action-primary"><span className="h-4 w-4 rounded-pill bg-surface-panel group-data-selected:translate-x-4" /></span>
        {inlineLabel}
      </SwitchButton>
    </SwitchField>}
  </FormField>;
});
