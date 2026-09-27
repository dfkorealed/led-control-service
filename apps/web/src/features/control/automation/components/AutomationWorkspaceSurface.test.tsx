import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationWorkspaceSummary } from "./AutomationWorkspaceSurface";

describe("AutomationWorkspaceSummary", () => {
  afterEach(cleanup);

  it("never turns an unknown total into zero during loading or error", () => {
    const { rerender } = render(<AutomationWorkspaceSummary label="스케줄 요약" timeZone="Asia/Seoul" loadedStatuses={[]} state="loading" />);
    const summary = screen.getByRole("group", { name: "스케줄 요약" });
    expect(within(summary).getAllByText("확인 중")).toHaveLength(2);
    expect(summary).not.toHaveTextContent("0건");

    rerender(<AutomationWorkspaceSummary label="스케줄 요약" timeZone="Asia/Seoul" loadedStatuses={[]} state="error" />);
    expect(within(summary).getAllByText("확인 불가")).toHaveLength(2);
    expect(summary).not.toHaveTextContent("0건");
  });

  it("distinguishes empty site from a partially loaded list", () => {
    const { rerender } = render(<AutomationWorkspaceSummary label="이벤트 요약" timeZone="Asia/Seoul" total={0} loadedStatuses={[]} state="ready" />);
    const summary = screen.getByRole("group", { name: "이벤트 요약" });
    expect(summary).toHaveTextContent("현장 전체 규칙 0건");
    expect(summary).toHaveTextContent("적용 대상 없음");

    rerender(<AutomationWorkspaceSummary label="이벤트 요약" timeZone="Asia/Seoul" total={120} loadedStatuses={["APPLIED", "REJECTED"]} state="ready" />);
    expect(summary).toHaveTextContent("현장 전체 규칙 120건");
    expect(summary).toHaveTextContent("적용 완료 1건 · 확인 필요 1건 · 불러온 2건 기준");
  });

  it("uses the site-wide rule summary instead of the currently loaded rows", () => {
    render(<AutomationWorkspaceSummary label="스케줄 요약" timeZone="Asia/Seoul" total={120}
      siteSummary={{ ruleCount: 120, syncRuleCounts: { APPLIED: 20, PENDING: 90, REJECTED: 10 } }}
      loadedStatuses={["APPLIED"]} state="ready" />);
    const summary = screen.getByRole("group", { name: "스케줄 요약" });
    expect(summary).toHaveTextContent("현장 전체 규칙 120건");
    expect(summary).toHaveTextContent("적용 완료 20건 · 적용 대기 90건 · 적용 실패 10건");
    expect(summary).not.toHaveTextContent("불러온 1건 기준");
  });
});
