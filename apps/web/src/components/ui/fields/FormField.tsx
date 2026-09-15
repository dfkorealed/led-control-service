import { forwardRef, useId, type AriaAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Text } from "../Typography";
import { Label } from "react-aria-components";
import { cn } from "../utils/cn";
import { fieldControl, type FieldStateProps, type FieldVisualProps } from "./field-types";

export interface FieldControlAttributes extends Pick<InputHTMLAttributes<HTMLInputElement>, "id" | "aria-labelledby" | "aria-describedby" | "aria-invalid" | "disabled" | "required" | "readOnly" | "className"> {}
export interface FormFieldProps extends FieldVisualProps, FieldStateProps {
  id?: string;
  /** Groups label their root via aria-labelledby; they must not render a label for a group element. */
  isGroup?: boolean;
  /** Slot-based controls (e.g. Slider) need the label inside their React Aria context. */
  labelMode?: "native" | "aria";
  labelPlacement?: "above" | "inline";
  children: (attributes: FieldControlAttributes, inlineLabel: ReactNode) => ReactNode;
}

export const FormField = forwardRef<HTMLDivElement, FormFieldProps>(function FormField(
  { id, label, description, errorMessage, variant = "outline", size = "md", className, isGroup, labelMode = "native", labelPlacement = "above", isDisabled, isReadOnly, isRequired, isInvalid, children }, ref
) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = `${controlId}-label`;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  const hasError = isInvalid && errorMessage != null;
  const attributes: FieldControlAttributes = {
    id: controlId,
    "aria-labelledby": label != null ? labelId : undefined,
    "aria-describedby": [description != null && descriptionId, hasError && errorId].filter(Boolean).join(" ") || undefined,
    "aria-invalid": isInvalid || undefined,
    disabled: isDisabled, readOnly: isReadOnly, required: isRequired,
    className: fieldControl({ variant, size })
  };
  return <div ref={ref} data-field="" data-size={size} data-variant={variant} data-invalid={isInvalid || undefined} data-disabled={isDisabled || undefined} className={cn("flex min-w-0 flex-col gap-2", className)}>
    {label != null && labelPlacement === "above" && (labelMode === "aria"
      ? <Label className="m-0 text-label font-semibold text-content-primary">{label}</Label>
      : isGroup
      ? <Text as="span" id={labelId} variant="label">{label}</Text>
      : <Text as="label" id={labelId} htmlFor={controlId} variant="label">{label}</Text>)}
    {children(attributes, label != null ? <Text as="span" id={labelId} variant={size === "sm" ? "body-sm" : size === "lg" ? "body-lg" : "body"}>{label}</Text> : null)}
    {/* Secondary content is only 4.45:1 on the canvas. Keep help readable on
        both the page canvas and panel surfaces using the approved primary token. */}
    {description != null && <Text id={descriptionId} variant="caption">{description}</Text>}
    {hasError && <Text id={errorId} variant="caption" tone="danger" role="alert">{errorMessage}</Text>}
  </div>;
});

/** Only the ARIA relationship belongs on a compound root. Native flags/class go to its control. */
export function fieldAria(attributes: FieldControlAttributes, caller: AriaAttributes = {}) {
  const descriptionIds = [attributes["aria-describedby"], caller["aria-describedby"]].filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
  return {
    "aria-labelledby": attributes["aria-labelledby"] ?? caller["aria-labelledby"],
    "aria-describedby": [...new Set(descriptionIds)].join(" ") || undefined,
    "aria-invalid": attributes["aria-invalid"] ?? caller["aria-invalid"]
  };
}
