import type { HTMLAttributes, ReactNode } from "react";

export type CardTone = "default" | "selected" | "danger";

export function Card({ tone = "default", className = "", children, ...props }: HTMLAttributes<HTMLElement> & { tone?: CardTone; children: ReactNode }) {
  return <section {...props} className={`ui-card ui-card-${tone} ${className}`.trim()}>{children}</section>;
}
