import { forwardRef, type InputHTMLAttributes } from "react";
import { FormField, fieldAria } from "./FormField";
import type { FieldStateProps, FieldVisualProps } from "./field-types";

export interface FileFieldProps extends FieldVisualProps, FieldStateProps, Omit<InputHTMLAttributes<HTMLInputElement>, keyof FieldVisualProps | "type" | "value" | "defaultValue" | "onChange" | "children" | "readOnly"> {
  onChange?(files: FileList | null): void;
}

export const FileField = forwardRef<HTMLInputElement, FileFieldProps>(function FileField(
  { label, description, errorMessage, variant, size, className, id, isDisabled, isRequired, isInvalid, isReadOnly, disabled, required, onChange, ...props }, ref
) {
  // File selection is browser-owned. Never assign value or clone FileList;
  // consumers may clear the native ref or reset the owning form to reselect.
  return <FormField {...{ label, description, errorMessage, variant, size, className, id, isInvalid }} isDisabled={isDisabled || disabled} isRequired={isRequired || required}>
    {(attributes) => <input {...props} {...attributes} {...fieldAria(attributes, props)} ref={ref} type="file" onChange={(event) => onChange?.(event.currentTarget.files)} />}
  </FormField>;
});
