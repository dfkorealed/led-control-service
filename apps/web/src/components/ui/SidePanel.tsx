import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { card } from "./Card";
import { cn } from "./utils/cn";

export interface SidePanelProps extends HTMLAttributes<HTMLElement> { variant?: "default"; children: ReactNode }
export const SidePanel = forwardRef<HTMLElement, SidePanelProps>(function SidePanel({ variant = "default", className, children, ...props }, ref) {
  return <aside {...props} ref={ref} className={cn(card({ variant }), "ui-side-panel min-w-0 max-w-full overflow-x-hidden overflow-y-auto overscroll-contain wrap-anywhere", className)}>{children}</aside>;
});
