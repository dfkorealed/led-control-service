import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemporaryControlView } from "@led-control/shared/temporary-control-contracts";
import { ApiError } from "../../api/client";
import { useTemporaryControlSession } from "./useTemporaryControlSession";
const api = vi.hoisted(() => ({ startTemporaryControl: vi.fn(), endTemporaryControl: vi.fn(), getTemporaryControl: vi.fn(), listTemporaryControls: vi.fn() }));
vi.mock("../../api/temporary-controls", async original => ({ ...(await original<typeof import("../../api/temporary-controls")>()), ...api }));
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

const input = { clientRequestId: "88888888-8888-4888-8888-888888888888", target: { type: "fixtures" as const, fixtureIds: [fixtureId] }, brightness: 70, durationMinutes: 15 };
const options = { siteId, principalKey: "actor-a", fixtureIds: [fixtureId] };
beforeEach(() => { localStorage.clear(); Object.values(api).forEach(mock => mock.mockReset()); api.startTemporaryControl.mockResolvedValue(session()); api.getTemporaryControl.mockResolvedValue(session()); api.endTemporaryControl.mockResolvedValue({ ...session(), state: "releasing", sessionRevision: 2 }); api.listTemporaryControls.mockResolvedValue({ items: [], nextCursor: null }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
describe("temporary session owner", () => {
  it("keeps 202 pending locked and never posts a second start while unresolved", async () => {
    const hook = renderHook(() => useTemporaryControlSession(options));
    await act(async () => { await hook.result.current.start(input); });
    expect(hook.result.current.session?.state).toBe("pending"); expect(hook.result.current.controlsLocked).toBe(true);
    await act(async () => { await hook.result.current.start({ ...input, clientRequestId: "99999999-9999-4999-8999-999999999999" }); });
    expect(api.startTemporaryControl).toHaveBeenCalledTimes(1);
  });
  it("discards a response from the previous principal even after A→B→A", async () => {
    let resolve!: (value: TemporaryControlView) => void;
    api.startTemporaryControl.mockReturnValue(new Promise<TemporaryControlView>(done => { resolve = done; }));
    const hook = renderHook(({ principalKey }) => useTemporaryControlSession({ ...options, principalKey }), { initialProps: { principalKey: "actor-a" } });
    let write!: Promise<void>;
    act(() => { write = hook.result.current.start(input); });
    hook.rerender({ principalKey: "actor-b" }); hook.rerender({ principalKey: "actor-a" });
    await act(async () => { resolve(session("holding")); await write; });
    expect(hook.result.current.session).toBeNull(); expect(api.startTemporaryControl).toHaveBeenCalledTimes(1);
  });
  it("restores an identity after remount by GET and releases only from a server-settled result", async () => {
    const hook = renderHook(() => useTemporaryControlSession(options));
    await act(async () => { await hook.result.current.start(input); }); hook.unmount();
    api.getTemporaryControl.mockResolvedValue(session("holding"));
    const restored = renderHook(() => useTemporaryControlSession(options));
    await waitFor(() => expect(restored.result.current.session?.state).toBe("holding"));
    expect(api.startTemporaryControl).toHaveBeenCalledTimes(1);
    await act(async () => { await restored.result.current.end({ clientRequestId: input.clientRequestId }); });
    expect(restored.result.current.session?.state).toBe("releasing"); expect(restored.result.current.controlsLocked).toBe(true);
    api.getTemporaryControl.mockResolvedValue(session("restored"));
    await act(async () => { await restored.result.current.refresh(); });
    expect(restored.result.current.controlsLocked).toBe(false);
  });
  it("does not replace accepted End revision with an earlier in-flight GET", async () => {
    let resolve!: (value: TemporaryControlView) => void;
    api.startTemporaryControl.mockResolvedValue(session("holding"));
    api.getTemporaryControl.mockReturnValue(new Promise<TemporaryControlView>(done => { resolve = done; }));
    const hook = renderHook(() => useTemporaryControlSession(options));
    await act(async () => { await hook.result.current.start(input); });
    await waitFor(() => expect(api.getTemporaryControl).toHaveBeenCalled());
    await act(async () => { await hook.result.current.end({ clientRequestId: input.clientRequestId }); });
    await act(async () => { resolve(session("holding")); });
    expect(hook.result.current.session?.state).toBe("releasing");
    expect(hook.result.current.session?.sessionRevision).toBe(2);
  });

  it("keeps response-loss recovery explicit and reuses the exact original request", async () => {
    api.startTemporaryControl.mockRejectedValueOnce(new Error("lost"));
    const hook = renderHook(() => useTemporaryControlSession(options));
    await act(async () => { await hook.result.current.start(input); }); hook.unmount();
    const restored = renderHook(() => useTemporaryControlSession(options));
    expect(restored.result.current.controlsLocked).toBe(true); expect(api.startTemporaryControl).toHaveBeenCalledTimes(1);
    await act(async () => { await restored.result.current.refresh(); });
    expect(api.startTemporaryControl).toHaveBeenCalledTimes(2);
    expect(api.startTemporaryControl.mock.calls[1][1]).toEqual(input);
  });
  it("blocks RF admission when the browser cannot preserve the recovery identity", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const hook = renderHook(() => useTemporaryControlSession(options));
    await act(async () => { await hook.result.current.start(input); });
    expect(api.startTemporaryControl).not.toHaveBeenCalled(); expect(hook.result.current.controlsLocked).toBe(true);
    expect(hook.result.current.error).toMatch(/복구/);
  });
  it.each([401, 403, 404])("preserves an uncertain start through recovery HTTP %s and reuses it after access returns", async status => {
    api.startTemporaryControl.mockRejectedValueOnce(new Error("response lost"));
    const hook = renderHook(() => useTemporaryControlSession(options));
    await act(async () => { await hook.result.current.start(input); });
    api.startTemporaryControl.mockRejectedValueOnce(new ApiError("access changed", status, { code: "temporary_control_access_unavailable" }));
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.controlsLocked).toBe(true);
    expect(hook.result.current.error).toBeTruthy();
    hook.unmount();
    const recovered = renderHook(() => useTemporaryControlSession(options));
    expect(recovered.result.current.controlsLocked).toBe(true);
    api.startTemporaryControl.mockResolvedValueOnce(session("holding"));
    api.getTemporaryControl.mockResolvedValue(session("holding"));
    await act(async () => { await recovered.result.current.refresh(); });
    expect(recovered.result.current.session?.state).toBe("holding");
    expect(api.startTemporaryControl).toHaveBeenCalledTimes(3);
    expect(api.startTemporaryControl.mock.calls[2]).toEqual([siteId, input]);
  });
  it.each([401,403,409,503])("keeps HTTP %s explicit without a permanent-control fallback", async status => {
    api.startTemporaryControl.mockRejectedValue(new ApiError("blocked", status, { code: "temporary_control_configuration_unapplied" }));
    const hook = renderHook(() => useTemporaryControlSession(options));
    await act(async () => { await hook.result.current.start(input); });
    expect(hook.result.current.session).toBeNull(); expect(hook.result.current.error).toBeTruthy();
    expect(api.endTemporaryControl).not.toHaveBeenCalled();
  });
});
