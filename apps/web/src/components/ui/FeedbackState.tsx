import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type FeedbackTone = "neutral" | "danger";

export function FeedbackState({ tone = "neutral", icon: Icon, title, description, action }: { tone?: FeedbackTone; icon: LucideIcon; title: string; description?: string; action?: ReactNode }) {
  const liveProps = tone === "danger" ? { role: "alert" as const } : { role: "status" as const };

  return <section {...liveProps} className="ui-feedback-state" data-tone={tone}><Icon size={22} aria-hidden="true" /><div><strong>{title}</strong>{description ? <p>{description}</p> : null}{action}</div></section>;
}
