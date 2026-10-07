import { describe, expect, it } from "vitest";
import type { CommandStatusResponse } from "../../api/commands";
import { commandHistoryRows } from "./command-history-presentation";

const item: Omit<CommandStatusResponse, "dispatches"> = {
  id: "actual-command-uuid", stage: "partial_failed", outcome: "partially_applied", brightness: 0,
  totalFixtureCount: 0, completedFixtureCount: 0, dispatchCount: 1, errorMessage: null,
  createdAt: "2026-09-12T01:00:00Z"
};
describe("commandHistoryRows", () => {
  it("adapts actual identity, zero brightness and target count without fabricating completion", () => {
    expect(commandHistoryRows([item], "Asia/Seoul")).toEqual([{
      id: item.id, timestampLabel: "2026-09-12 10:00:00", content: "0개 조명 · 0%", status: "일부 조명 적용 실패"
    }]);
    expect(commandHistoryRows([], "UTC")).toEqual([]);
  });
  it("preserves unknown time/brightness and the exact clock refusal safety explanation", () => {
    const unknown = commandHistoryRows([{ ...item, brightness: undefined, createdAt: undefined, stage: "verification_required", outcome: "unknown" }], "UTC")[0];
    expect(unknown).toMatchObject({ id: item.id, timestampLabel: "시각 미확인", content: "0개 조명 · —%", status: "실제 상태 확인 필요" });
    const refused = commandHistoryRows([{ ...item, stage: "failed", outcome: "not_applied", errorCode: "GATEWAY_CLOCK_UNTRUSTED" }], "UTC")[0];
    expect(refused.content).toContain("조명 전송 전 거부");
    expect(refused.status).toContain("자동 재실행되지 않습니다.");
    const inconclusive = commandHistoryRows([{ ...item, stage: "failed", outcome: "unknown", errorCode: "GATEWAY_CLOCK_UNTRUSTED" }], "UTC")[0];
    expect(inconclusive.status).toBe("명령 처리 실패");
  });
});
