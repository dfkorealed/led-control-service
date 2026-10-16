import { createElement, forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./utils/cn";

export type PanelPadding = "none" | "customer" | "regular" | "compact";

export function panelPaddingClass(padding: PanelPadding): string {
  if (padding === "none") return "";
  return padding === "compact" ? "p-4" : "p-5 max-compact:p-4";
}

export interface FunctionalLayoutProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "section";
  children: ReactNode;
}

export const PageStack = forwardRef<HTMLElement, FunctionalLayoutProps>(function PageStack({ as: Element = "div", className, ...props }, ref) {
  return createElement(Element, { ...props, ref, className: cn("grid min-w-0 content-start gap-5", className) });
});

export const CardGrid = forwardRef<HTMLElement, FunctionalLayoutProps>(function CardGrid({ as: Element = "div", className, ...props }, ref) {
  return createElement(Element, { ...props, ref, className: cn("grid min-w-0 gap-4.5", className) });
});
