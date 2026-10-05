import type { CommandStatusResponse } from "../../api/commands";

export type RecentCommandResult = { kind: "empty" | "pending" | "verification" | "unknown" }
  | { kind: "completed"; result: "success" | "partial" | "failure"; label: "성공" | "일부 성공" | "실패" };

export function presentRecentCommandResult(status: CommandStatusResponse | null): RecentCommandResult {
  if (!status) return { kind: "empty" };
  if (status.stage === "verification_required" || status.dispatches.some(dispatch => dispatch.kind === "status_check" && ["pending", "published", "accepted"].includes(dispatch.status))) return { kind: "verification" };
  // A processed count includes failures and cannot establish a physical outcome.
  if (["completed", "verified_applied"].includes(status.stage) && status.outcome === "applied") return { kind: "completed", result: "success", label: "성공" };
  if (["partial_failed", "verified_partial"].includes(status.stage) && status.outcome === "partially_applied") return { kind: "completed", result: "partial", label: "일부 성공" };
  if (["failed", "verified_not_applied"].includes(status.stage) && status.outcome === "not_applied") return { kind: "completed", result: "failure", label: "실패" };
  if (["queued", "published", "accepted"].includes(status.stage) && status.outcome === "pending") return { kind: "pending" };
  return { kind: "unknown" };
}
