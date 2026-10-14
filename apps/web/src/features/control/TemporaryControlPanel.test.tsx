import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemporaryControlView } from "@led-control/shared/temporary-control-contracts";
import { TemporaryControlPanel } from "./TemporaryControlPanel";
const siteId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const fixtureId = "33333333-3333-4333-8333-333333333333";
const gatewayId = "44444444-4444-4444-8444-444444444444";
function session(state: TemporaryControlView["state"] = "pending"): TemporaryControlView {
  const view: TemporaryControlView = { id: sessionId, siteId, gatewayId, state, sessionRevision: 1,
    now: "2026-10-15T00:00:00.000Z", startedAt: "2026-10-15T00:00:00.000Z", endsAt: "2026-10-15T00:15:00.000Z", brightness: 70,
    targets: [{ fixtureId, meshNodeId: "55555555-5555-4555-8555-555555555555", nativeUuid: "abcdef123456", logicalAddress: "0x1001", applyGeneration: "1", releaseGeneration: "2" }], results: [], reason: null, detailsRedacted: false };
  if (["holding", "partial", "unknown", "recovery_pending", "restored"].includes(state)) {
    view.results = [{ schemaVersion: 1, sessionId, siteId, gatewayId, assignmentVersion: 1, admissionRevision: 3,
      originCommandHash: `sha256:${"a".repeat(64)}`, originSequence: 1, fixtureId, applyConfirmed: state === "holding" || state === "restored",
      releaseConfirmed: false, configurationMayHaveChanged: true, partialMutation: state === "partial" ? "high_brightness" : state === "unknown" ? "unverified" : "none",
      configurationReadback: ["holding", "restored"].includes(state) ? { configuredHighBrightnessPercent: 70, bioMode: "force-on" } : null,
      rfWriteEvidence: "observed", reason: null, eventId: "66666666-6666-4666-8666-666666666666", sessionRevision: 1,
      kind: "apply", targetGeneration: "1", restorationRevision: null, restorationPayloadHash: null, observedAt: "2026-10-15T00:00:01.000Z", resultHash: `sha256:${"b".repeat(64)}` }];
    if (state === "restored") {
      view.sessionRevision = 2;
      view.results.push({ ...view.results[0], eventId: "77777777-7777-4777-8777-777777777777", sessionRevision: 2, kind: "release", targetGeneration: "2",
        releaseConfirmed: true, restorationRevision: 4, restorationPayloadHash: `sha256:${"c".repeat(64)}`, observedAt: "2026-10-15T00:15:01.000Z",
        configurationReadback: { configuredHighBrightnessPercent: 50, bioMode: "sensor" } });
    }
  }
  return view;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const controller = () => ({ session: null as TemporaryControlView | null, controlsLocked: false, error: null, start: vi.fn(), end: vi.fn(), refresh: vi.fn() });
const props = { brightness: 70, fixtureIds: [fixtureId], compact: false, durationMinutes: 15, onDurationChange: vi.fn() };
describe("temporary control presentation", () => {
  it("offers exact period presets and labels a preview as estimated before acceptance", () => {
    render(<TemporaryControlPanel {...props} controller={controller()} />);
    for (const minutes of [15,30,60,120]) expect(screen.getByRole("button", { name: `${minutes}분` })).toBeInTheDocument();
    expect(screen.getByText(/예상 종료/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "120분" })); expect(props.onDurationChange).toHaveBeenCalledWith(120);
  });
  it("countdown zero never confirms restoration or sends an End", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const now = vi.spyOn(performance, "now").mockReturnValue(0); const owner = { ...controller(), session: session("holding"), controlsLocked: true };
    render(<TemporaryControlPanel {...props} controller={owner} />);
    now.mockReturnValue(1_000_000); act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText(/남은 시간 0초/)).toBeInTheDocument();
    expect(screen.getByText(/지정 밝기 유지/)).toBeInTheDocument();
    expect(screen.queryByText(/^자동 운전 복귀 확인$/)).not.toBeInTheDocument(); expect(owner.end).not.toHaveBeenCalled();
  });
  it.each(["partial", "unknown", "recovery_pending"] as const)("shows %s uncertainty and configuration mutation without unlocking inputs", state => {
    render(<TemporaryControlPanel {...props} controller={{ ...controller(), session: session(state), controlsLocked: true }} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30분" })).toBeDisabled();
    expect(screen.getByText(/설정 변경 가능/)).toBeInTheDocument();
  });
});
