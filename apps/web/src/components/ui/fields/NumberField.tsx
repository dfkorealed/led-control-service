import { forwardRef } from "react";
import { Input, NumberField as AriaNumberField, type NumberFieldProps as AriaNumberFieldProps } from "react-aria-components";
import { FormField, fieldAria } from "./FormField";
import type { FieldVisualProps } from "./field-types";

export interface NumberFieldProps extends FieldVisualProps, Omit<AriaNumberFieldProps, keyof FieldVisualProps | "children" | "style" | "render" | "value" | "defaultValue" | "onChange"> {
  value?: number | null;
  defaultValue?: number | null;
  onChange?(value: number | null): void;
  placeholder?: string;
}
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  { label, description, errorMessage, variant, size, className, id, placeholder, value, defaultValue, onChange, ...props }, ref
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaNumberField {...props} {...fieldAria(attributes, props)} className="contents"
      // React Aria represents an empty numeric field with NaN. The public
      // contract uses null; undefined remains exclusively uncontrolled mode.
      value={value === null ? NaN : value} defaultValue={defaultValue === null ? NaN : defaultValue}
      onChange={(next) => onChange?.(Number.isNaN(next) ? null : next)}>
      <Input id={attributes.id} ref={ref} placeholder={placeholder} className={attributes.className} />
    </AriaNumberField>}
  </FormField>;
});
