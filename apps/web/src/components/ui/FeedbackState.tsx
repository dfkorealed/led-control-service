import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type FeedbackTone = "neutral" | "info" | "success" | "warning" | "danger";

export function FeedbackState({ tone = "neutral", icon: Icon, title, description, action, liveRole }: { tone?: FeedbackTone; icon: LucideIcon; title: string; description?: string; action?: ReactNode; liveRole?: "status" | "alert" }) {
  const liveProps = { role: liveRole ?? (tone === "danger" ? "alert" : "status") };

  return <section {...liveProps} className="ui-feedback-state" data-tone={tone}><Icon size={22} aria-hidden="true" /><div><strong>{title}</strong>{description ? <p>{description}</p> : null}{action}</div></section>;
}
