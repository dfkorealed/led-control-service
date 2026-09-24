import { describe, expect, it } from "vitest";
import { presentFixtureStatus } from "./fixture-status-presentation";

describe("presentFixtureStatus", () => {
  it.each([
    [{ status: "offline", statusReason: "provisioning_waiting_state", health: null }, "상태 확인 대기", "최초 상태 수신 대기", "warning", "provisioning_waiting_state"],
    [{ status: "offline", statusReason: "gateway_offline", health: null }, "게이트웨이 오프라인", "게이트웨이 연결 확인", "danger", "gateway_offline"],
    [{ status: "offline", statusReason: "fixture_stale", health: null }, "상태 수신 지연", "조명 통신 상태 확인", "warning", "fixture_stale"],
    [{ status: "offline", statusReason: "command_failed", health: null }, "명령 처리 실패", "명령 이력 및 조명 연결 확인", "danger", "command_failed"],
    [{ status: "online", statusReason: "reported", health: { faultCodes: [4], observedAt: "2026-09-12T00:00:00.000Z" } }, "장애", "조명 상태와 연결 확인", "danger", "fault"],
    [{ status: "online", statusReason: "reported", health: null }, "정상", "조치 불필요", "success", "online"],
    [{ status: "offline", statusReason: "reported", health: null }, "오프라인", "조명 연결 확인", "neutral", "offline"]
  ] as const)("returns one shared presentation for %o", (input, label, action, tone, state) => {
    const presentation = presentFixtureStatus(input);

    expect(presentation).toMatchObject({ label, recommendedAction: action, tone, state });
    expect(presentation.description).not.toHaveLength(0);
  });

  it("explains a device fault without an internal protocol term", () => {
    const presentation = presentFixtureStatus({ status: "fault", health: { faultCodes: [4], observedAt: "2026-09-12T00:00:00.000Z" } });
    expect(presentation.description).toBe("조명에서 점검이 필요한 상태를 보고했습니다.");
    expect(presentation.description).not.toMatch(/Health|Current|fault/i);
  });
});
