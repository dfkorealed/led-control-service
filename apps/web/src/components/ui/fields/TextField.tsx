import { forwardRef, type InputHTMLAttributes } from "react";
import { Input, TextArea as AriaTextArea, TextField as AriaTextField, type TextFieldProps as AriaTextFieldProps } from "react-aria-components";
import { FormField, fieldAria } from "./FormField";
import type { FieldVisualProps } from "./field-types";

export interface TextFieldProps extends FieldVisualProps, Omit<AriaTextFieldProps, keyof FieldVisualProps | "children" | "style" | "render" | "type" | "autoCapitalize" | "autoCorrect" | "spellCheck"> {
  type?: "text" | "search" | "password" | "email" | "tel" | "url";
  placeholder?: string;
  autoCapitalize?: InputHTMLAttributes<HTMLInputElement>["autoCapitalize"];
  autoCorrect?: InputHTMLAttributes<HTMLInputElement>["autoCorrect"];
  spellCheck?: InputHTMLAttributes<HTMLInputElement>["spellCheck"];
}
export interface TextAreaProps extends Omit<TextFieldProps, "type"> { rows?: number; cols?: number; wrap?: "hard" | "soft" | "off" }

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, description, errorMessage, variant, size, className, id, placeholder, autoCapitalize, autoCorrect, spellCheck, ...props }, ref
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaTextField {...props} {...fieldAria(attributes, props)} className="contents">
      <Input id={attributes.id} ref={ref} placeholder={placeholder} autoCapitalize={autoCapitalize} autoCorrect={autoCorrect} spellCheck={spellCheck} className={attributes.className} />
    </AriaTextField>}
  </FormField>;
});
export const SearchField = forwardRef<HTMLInputElement, Omit<TextFieldProps, "type">>(function SearchField(props, ref) {
  return <TextField {...props} type="search" ref={ref} />;
});
export const PasswordField = forwardRef<HTMLInputElement, Omit<TextFieldProps, "type">>(function PasswordField(props, ref) {
  return <TextField {...props} type="password" ref={ref} />;
});
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, description, errorMessage, variant, size, className, id, placeholder, rows, cols, wrap, autoCapitalize, autoCorrect, spellCheck, ...props }, ref
) {
  return <FormField {...{ label, description, errorMessage, variant, size, className, id }} isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaTextField {...props} {...fieldAria(attributes, props)} className="contents">
      <AriaTextArea id={attributes.id} ref={ref} placeholder={placeholder} rows={rows} cols={cols} wrap={wrap} autoCapitalize={autoCapitalize} autoCorrect={autoCorrect} spellCheck={spellCheck} className={attributes.className} />
    </AriaTextField>}
  </FormField>;
});
