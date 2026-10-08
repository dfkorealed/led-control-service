import { describe, expect, it } from "vitest";
import type { CommandStage, CommandStatusResponse } from "../../api/commands";

// The initial RED also proves the new feature's export is missing without a
// collection/import error masking the actual expected behavior.
const modules = import.meta.glob<{ presentRecentCommandResult: (status: CommandStatusResponse | null) => unknown }>("./command-result-presentation.ts", { eager: true });
function present(status: CommandStatusResponse | null) {
  const module = modules["./command-result-presentation.ts"];
  expect(module?.presentRecentCommandResult).toBeTypeOf("function");
  return module.presentRecentCommandResult(status);
}
function status(stage: CommandStage, outcome: CommandStatusResponse["outcome"]): CommandStatusResponse {
  return { id: "command-1", stage, outcome, dispatchCount: 1, completedFixtureCount: 1, totalFixtureCount: 1, errorMessage: null, dispatches: [] };
}
describe("presentRecentCommandResult", () => {
  it.each([
    ["completed", "applied", "success", "성공"], ["verified_applied", "applied", "success", "성공"],
    ["partial_failed", "partially_applied", "partial", "일부 성공"], ["verified_partial", "partially_applied", "partial", "일부 성공"],
    ["failed", "not_applied", "failure", "실패"], ["verified_not_applied", "not_applied", "failure", "실패"]
  ] as const)("classifies only conclusive %s/%s", (stage, outcome, result, label) => {
    expect(present(status(stage, outcome))).toEqual({ kind: "completed", result, label });
  });
  it.each(["queued", "published", "accepted"] as const)("keeps %s pending", stage => {
    expect(present(status(stage, "pending"))).toEqual({ kind: "pending" });
  });
  it("keeps verification separate even when every fixture has a processed count", () => {
    expect(present(status("verification_required", "unknown"))).toEqual({ kind: "verification" });
  });
  it.each([
    ["completed", "unknown"], ["completed", undefined], ["completed", null], ["failed", "applied"],
    ["verified_partial", "not_applied"], ["timed_out", "unknown"], ["timed_out", "not_applied"], ["queued", "applied"]
  ] as const)("never confirms missing or inconsistent %s/%s", (stage, outcome) => {
    expect(present(status(stage, outcome))).toEqual({ kind: "unknown" });
  });
  it("keeps a pending verification dispatch outside the conclusive result", () => {
    expect(present({ ...status("completed", "applied"), dispatches: [{ id: "get-1", kind: "status_check", status: "pending", gateway: { id: "gw", name: "GW" }, errorMessage: null, results: [] }] })).toEqual({ kind: "verification" });
  });
  it("does not manufacture a result without a fresh command", () => expect(present(null)).toEqual({ kind: "empty" }));
});
