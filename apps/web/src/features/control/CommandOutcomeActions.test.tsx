import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandStatusResponse } from "../../api/commands";
import { CommandOutcomeActions } from "./CommandOutcomeActions";

const unknown: CommandStatusResponse = {
  id: "command", stage: "verification_required", outcome: "unknown", verificationAttemptCount: 0,
  dispatchCount: 1, completedFixtureCount: 1, totalFixtureCount: 1, errorMessage: "STATUS_TIMEOUT",
  dispatches: []
};
afterEach(cleanup);

describe("CommandOutcomeActions", () => {
  it("offers only an actual-state check for unknown, never Set replay", () => {
    const onCheck = vi.fn();
    render(<CommandOutcomeActions status={unknown} onCheck={onCheck} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "실제 상태 확인" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /적용|재전송/ })).not.toBeInTheDocument();
    expect(screen.getByText(/현장 상태를 확인하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText("조명 상태 응답 시간 초과")).toBeInTheDocument();
    expect(screen.queryByText("STATUS_TIMEOUT")).not.toBeInTheDocument();
  });
  it("requires field inspection after three checks and exposes no further action", () => {
    render(<CommandOutcomeActions status={{ ...unknown, verificationAttemptCount: 3 }} onCheck={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(/현장 확인이 필요합니다/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("permits same HTTP check recovery at the attempt limit without creating a new check", () => {
    render(<CommandOutcomeActions status={{ ...unknown, verificationAttemptCount: 3 }} checkResponseLost onCheck={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "동일 상태 확인 요청 조회" })).toBeEnabled();
  });
  it("locks status checking while a Get dispatch is running", () => {
    render(<CommandOutcomeActions status={{ ...unknown, dispatches: [{ id: "check", kind: "status_check", verificationAttempt: 1, status: "accepted", gateway: { id: "gw", name: "GW" }, results: [], errorMessage: null }] }} onCheck={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole("button", { name: "실제 상태 확인 중" })).toBeDisabled();
  });
  it("offers safe application only after verified_not_applied", () => {
    const onRetry = vi.fn();
    render(<CommandOutcomeActions status={{ ...unknown, stage: "verified_not_applied", outcome: "not_applied" }} onCheck={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "안전하게 다시 적용" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "실제 상태 확인" })).not.toBeInTheDocument();
  });
  it.each(["verified_applied", "verified_partial", "failed"] as const)("does not replay %s", (stage) => {
    render(<CommandOutcomeActions status={{ ...unknown, stage, outcome: stage === "verified_partial" ? "partially_applied" : stage === "failed" ? null : "applied" }} onCheck={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("shows current per-fixture values from the latest verification for partial results", () => {
    render(<CommandOutcomeActions status={{ ...unknown, stage: "verified_partial", outcome: "partially_applied", verificationAttemptCount: 2,
      dispatches: [1, 2].map((attempt) => ({ id: String(attempt), kind: "status_check", verificationAttempt: attempt, status: "completed", gateway: { id: "gw", name: "GW" }, errorMessage: null, results: [{ fixtureId: "fixture", fixtureName: "입구 조명", status: "succeeded", brightness: attempt === 2 ? 30 : 70, errorMessage: null }] }))
    }} onCheck={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText("입구 조명: 현재 30%")).toBeInTheDocument();
    expect(screen.queryByText("입구 조명: 현재 70%")).not.toBeInTheDocument();
  });
});
