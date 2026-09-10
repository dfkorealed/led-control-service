import type { HTMLAttributes, ReactNode } from "react";

export function SidePanel({ className = "", children, ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return <aside {...props} className={`ui-card ui-side-panel ${className}`.trim()}>{children}</aside>;
}
