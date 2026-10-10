import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { card } from "./Card";
import { cn } from "./utils/cn";

export interface SidePanelProps extends HTMLAttributes<HTMLElement> { variant?: "default"; surface?: "card" | "plain"; children: ReactNode }
export const SidePanel = forwardRef<HTMLElement, SidePanelProps>(function SidePanel({ variant = "default", surface = "card", className, children, ...props }, ref) {
  return <aside {...props} ref={ref} data-variant={variant} className={cn(surface === "card" && card({ variant }), "min-w-0 max-w-full overflow-x-hidden overflow-y-auto overscroll-contain wrap-anywhere [&>*]:min-w-0 [&>*]:max-w-full", className)}>{children}</aside>;
});
