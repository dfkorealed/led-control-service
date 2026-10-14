import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemporaryControlView } from "@led-control/shared/temporary-control-contracts";
import { TemporaryControlHistory } from "./TemporaryControlHistory";
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

afterEach(cleanup);
describe("temporary evidence history", () => {
  it("keeps partial configuration mutation separate from confirmed output and restoration", () => {
    render(<TemporaryControlHistory session={session("partial")} onClose={vi.fn()} />);
    expect(screen.getByText(/high_brightness|밝기 설정/)).toBeInTheDocument();
    expect(screen.getByText(/설정 변경 가능/)).toBeInTheDocument();
    expect(screen.queryByText(/^자동 운전 복귀 확인$/)).not.toBeInTheDocument();
  });
  it("shows redacted terminal history without fabricating targets, brightness or a new session", () => {
    render(<TemporaryControlHistory session={{ ...session("restored"), detailsRedacted: true, brightness: null, targets: [], results: [] }} onClose={vi.fn()} />);
    expect(screen.getByText(/상세 보관 종료/)).toBeInTheDocument();
    expect(screen.queryByText(/70%/)).not.toBeInTheDocument();
  });
});

it("validates actual HTTP evidence and scope rather than trusting a holding label", async () => {
  const { getTemporaryControl, listTemporaryControls } = await import("../../api/temporary-controls");
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...session(), state: "holding" }) });
  vi.stubGlobal("fetch", fetcher);
  await expect(getTemporaryControl(siteId, sessionId)).rejects.toMatchObject({ status: 502 });
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ items: [session()], nextCursor: "opaque" }) });
  expect((await listTemporaryControls(siteId, { limit: 20, cursor: "opaque previous" })).items[0].id).toBe(sessionId);
  expect(fetcher).toHaveBeenLastCalledWith(`/api/sites/${siteId}/temporary-controls?limit=20&cursor=opaque+previous`, expect.objectContaining({ credentials: "include" }));
  vi.unstubAllGlobals();
});
