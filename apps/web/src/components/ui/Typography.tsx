import { cva, type VariantProps } from "class-variance-authority";
import { createElement, forwardRef, type ComponentPropsWithRef, type ComponentPropsWithoutRef, type ReactElement, type Ref } from "react";
import { cn } from "./utils/cn";

const typography = cva("m-0", {
  variants: {
    variant: {
      display: "text-display font-bold", "page-title": "text-page-title font-bold",
      "section-title": "text-section-title font-bold", "card-title": "text-card-title font-bold",
      "body-lg": "text-body-lg font-normal", body: "text-body font-normal", "body-sm": "text-body-sm font-normal",
      label: "text-label font-semibold", caption: "text-caption font-normal", overline: "text-overline font-bold",
      metric: "text-metric font-bold tabular-nums"
    },
    tone: {
      primary: "text-content-primary", secondary: "text-content-secondary", muted: "text-content-muted",
      inverse: "text-content-inverse", danger: "text-status-danger-foreground", success: "text-status-success-foreground", warning: "text-status-warning-foreground"
    },
    weight: { normal: "font-normal", medium: "font-medium", semibold: "font-semibold", bold: "font-bold" }
  },
  defaultVariants: { variant: "body", tone: "primary" }
});

export type TypographyVariant = NonNullable<VariantProps<typeof typography>["variant"]>;
export type TextTone = NonNullable<VariantProps<typeof typography>["tone"]>;
export type TextWeight = NonNullable<VariantProps<typeof typography>["weight"]>;
type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
type TextTag = "p" | "span" | "div" | "label" | "strong" | "small" | "time" | "legend" | "output";
type TypographyOptions = { variant?: TypographyVariant; tone?: TextTone; weight?: TextWeight; className?: string };
export type HeadingProps<T extends HeadingTag = "h2"> = TypographyOptions & { as?: T } & Omit<ComponentPropsWithoutRef<T>, keyof TypographyOptions | "as">;
export type TextProps<T extends TextTag = "p"> = TypographyOptions & { as?: T } & Omit<ComponentPropsWithoutRef<T>, keyof TypographyOptions | "as">;

function typographyClass({ variant, tone, weight, className }: TypographyOptions) {
  // External layout owns gaps; typography never owns an outside margin.
  return cn(typography({ variant, tone, weight }), className, "m-0");
}

export const Heading = forwardRef(function Heading(
  { as = "h2", variant = "section-title", tone, weight, className, ...props }: HeadingProps<HeadingTag>,
  ref: Ref<HTMLHeadingElement>
) {
  return createElement(as, { ...props, ref, className: typographyClass({ variant, tone, weight, className }) });
});

// forwardRef erases the tag generic. Restore its public call signature so e.g.
// label accepts htmlFor and a label ref, while time accepts dateTime and a time ref.
export const Text = forwardRef(function Text(
  { as = "p", variant = "body", tone, weight, className, ...props }: TextProps<TextTag>,
  ref: Ref<HTMLElement>
) {
  return createElement(as, { ...props, ref, className: typographyClass({ variant, tone, weight, className }) });
}) as <T extends TextTag = "p">(props: TextProps<T> & { ref?: ComponentPropsWithRef<T>["ref"] }) => ReactElement | null;
