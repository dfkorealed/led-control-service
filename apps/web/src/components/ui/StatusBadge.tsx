import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "danger" | "neutral" | "info";

export function StatusBadge({ tone, icon: Icon, children, className = "" }: { tone: StatusTone; icon: LucideIcon; children: ReactNode; className?: string }) {
  return <span className={`ui-status-badge ${className}`.trim()} data-tone={tone}><Icon size={14} aria-hidden="true" /><span>{children}</span></span>;
}
