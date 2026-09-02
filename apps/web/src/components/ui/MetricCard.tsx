import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type MetricTone = "neutral" | "primary" | "success" | "warning" | "danger";

export function MetricCard({ label, value, unit, helper, icon: Icon, tone = "neutral", status }: { label: string; value: string | number; unit?: string; helper?: string; icon?: LucideIcon; tone?: MetricTone; status?: ReactNode }) {
  return <section className="ui-metric-card" data-tone={tone} role="group" aria-label={label}><div className="ui-metric-label">{Icon ? <Icon size={18} aria-hidden="true" /> : null}<span>{label}</span></div><strong><span>{value}</span>{unit ? <> <small>{unit}</small></> : null}</strong>{helper ? <p>{helper}</p> : null}{status}</section>;
}
