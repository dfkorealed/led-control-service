import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandVerificationCase } from "../../api/commands";
import { CommandRiskReconcileDialog } from "./CommandRiskReconcileDialog";

afterEach(cleanup);

const caseRecord: CommandVerificationCase = {
  caseId: "case-1", originalCommandId: "old-1", siteId: "site-1", targetCount: 2,
  verificationAttemptCount: 3, status: "verification_required", canRequestStatusCheck: false,
  lastCheckedAt: "2026-09-24T00:00:00.000Z", reasonCode: "attempts_exhausted"
};

describe("CommandRiskReconcileDialog", () => {
  it("requires an unchecked-by-default risk acknowledgement, method and bounded reason", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CommandRiskReconcileDialog open caseRecord={caseRecord} onClose={vi.fn()} onSubmit={onSubmit} />);

    const submit = screen.getByRole("button", { name: "위험 승인 및 차단 해제" });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /위험을 이해하고 승인/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "물리 상태 확인 완료" }));
    fireEvent.change(screen.getByRole("textbox", { name: "승인 사유" }), { target: { value: " 현장에서 2개 조명을 직접 확인했습니다. " } });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /위험을 이해하고 승인/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      acknowledgeRisk: true, verificationMethod: "verified_physical_state", reason: "현장에서 2개 조명을 직접 확인했습니다."
    }));
  });

  it("shows the unknown outcome and affected count before allowing unable-to-verify approval", () => {
    render(<CommandRiskReconcileDialog open caseRecord={caseRecord} timeZone="Asia/Seoul" onClose={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "물리 상태를 확인할 수 없음" }));
    expect(screen.getByRole("alert")).toHaveTextContent("결과가 불확실한 상태");
    expect(screen.getByRole("alert")).toHaveTextContent("2개 조명");
    expect(screen.getByRole("alert")).toHaveTextContent("마지막 확인");
    expect(screen.getByRole("alert")).toHaveTextContent("09:00");
  });

  it("does not submit blank or over-500-character reasons", () => {
    const onSubmit = vi.fn();
    render(<CommandRiskReconcileDialog open caseRecord={caseRecord} onClose={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("radio", { name: "물리 상태 확인 완료" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /위험을 이해하고 승인/ }));
    const reason = screen.getByRole("textbox", { name: "승인 사유" });
    const submit = screen.getByRole("button", { name: "위험 승인 및 차단 해제" });
    fireEvent.change(reason, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(reason, { target: { value: "x".repeat(501) } });
    expect(reason).toHaveAttribute("maxlength", "500");
    expect(submit).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
