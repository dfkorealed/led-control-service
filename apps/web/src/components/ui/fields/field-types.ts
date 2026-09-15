import type { ReactNode } from "react";
import { cva } from "class-variance-authority";

export type FieldSize = "sm" | "md" | "lg";
export type FieldVariant = "outline" | "filled" | "ghost";
export type SelectionVariant = Exclude<FieldVariant, "ghost">;
export interface FieldVisualProps {
  variant?: FieldVariant;
  size?: FieldSize;
  className?: string;
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
}
export interface FieldStateProps {
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
}
export interface SelectionVisualProps extends Omit<FieldVisualProps, "variant"> { variant?: SelectionVariant }
export type FieldKey = string | number;
export interface SelectItem<T extends FieldKey = FieldKey> {
  id: T;
  label: string;
  description?: string;
  isDisabled?: boolean;
}
export interface ChoiceItem {
  value: string;
  label: string;
  description?: string;
  isDisabled?: boolean;
}

// The shell only owns layout. Controls own state styles, with no legacy CSS hook.
export const fieldControl = cva("min-h-11 w-full rounded-control border text-content-primary outline-none focus-visible:shadow-focus data-focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60 data-disabled:cursor-not-allowed data-disabled:opacity-60 aria-invalid:border-status-danger-foreground data-invalid:border-status-danger-foreground", {
  variants: {
    variant: {
      outline: "border-border-strong bg-surface-panel",
      filled: "border-border-strong bg-surface-inset",
      ghost: "border-transparent bg-transparent"
    },
    size: { sm: "px-3 py-2 text-body-sm", md: "px-3 py-2.5 text-body", lg: "min-h-12 px-4 py-3 text-body-lg" }
  },
  defaultVariants: { variant: "outline", size: "md" }
});
export const choiceControl = cva("group flex min-h-11 cursor-pointer items-center gap-2 rounded-control border text-content-primary outline-none data-focus-visible:shadow-focus data-selected:border-action-primary data-selected:bg-action-primary-soft data-disabled:cursor-not-allowed data-disabled:opacity-60 data-invalid:border-status-danger-foreground", {
  variants: {
    variant: { outline: "border-border-strong bg-surface-panel", filled: "border-border-strong bg-surface-inset" },
    size: { sm: "px-3 py-2 text-body-sm", md: "px-3 py-2.5 text-body", lg: "min-h-12 px-4 py-3 text-body-lg" }
  },
  defaultVariants: { variant: "outline", size: "md" }
});
