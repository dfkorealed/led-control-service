import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixtureIdentifyPanel } from "./FixtureIdentifyPanel";
import { useFloorEditorStore } from "./editor-store";
import { ApiError, apiPost } from "../../api/client";
const api = vi.hoisted(() => ({ identifyFixture: vi.fn(), acquireFloorEditorLease: vi.fn() }));
vi.mock("../../api/floor-editor", () => api);
const response = { commandId: "cmd", sessionId: "session", fixtureId: "f1", action: "start", expiresAt: new Date(Date.now() + 10000).toISOString(), dispatchStatus: "broker_accepted", status: "attention_confirmed" };
describe("fixture identify", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.clearAllMocks();
    useFloorEditorStore.getState().initialize({ floor: { id: "floor", siteId: "site", name: "B1", level: 1, mapRevision: 1, floorPlan: null }, objects: [], fixtures: [1, 2].map((i) => ({ id: `f${i}`, name: `L${i}`, x: i * 100, y: 100, ratedWatt: 40, brightness: 70, status: "online", placementStatus: "placed", positionVerifiedAt: null })) });
    useFloorEditorStore.getState().selectFixture("f1");
  });
  it("does not mark human position verified on Attention ACK", async () => {
    api.identifyFixture.mockResolvedValue(response);
    render(<FixtureIdentifyPanel floorId="floor" readOnly={false} leaseToken="token" leaseFence={1} />);
    fireEvent.click(screen.getByRole("button", { name: "확인 시작" }));
    await screen.findByText("점멸 응답 확인");
    expect(useFloorEditorStore.getState().state!.fixtures[0].positionVerifiedAt).toBeNull();
    expect(useFloorEditorStore.getState().state!.fixtures[0].positionVerified).not.toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "위치 확인" }));
    expect(useFloorEditorStore.getState().state!.fixtures[0].positionVerified).toBe(true);
  });
  it("retains an uncertain session for stop and blocks next until stopped", async () => {
    api.identifyFixture.mockResolvedValue({ ...response, status: "timed_out", reason: "attention_timeout" });
    render(<FixtureIdentifyPanel floorId="floor" readOnly={false} leaseToken="token" leaseFence={1} />);
    fireEvent.click(screen.getByRole("button", { name: "확인 시작" }));
    await screen.findByText(/응답 미확인/);
    fireEvent.click(screen.getByRole("button", { name: "다음 조명" }));
    await waitFor(() => expect(api.identifyFixture).toHaveBeenCalledTimes(2));
    expect(api.identifyFixture.mock.calls[1][2]).toMatchObject({ action: "stop", sessionId: "session" });
    expect(useFloorEditorStore.getState().selection?.id).toBe("f1");
  });
  it("stops the matching session when the lease is lost", async () => {
    api.identifyFixture.mockResolvedValue(response);
    const view = render(<FixtureIdentifyPanel floorId="floor" readOnly={false} leaseToken="token" leaseFence={1} />);
    fireEvent.click(screen.getByRole("button", { name: "확인 시작" }));
    await screen.findByText("점멸 응답 확인");
    await act(async () => view.rerender(<FixtureIdentifyPanel floorId="floor" readOnly leaseToken="token" leaseFence={1} />));
    expect(api.identifyFixture).toHaveBeenLastCalledWith("floor", "f1", expect.objectContaining({ action: "stop", sessionId: "session" }));
  });
  it("renews a nearly expired lease before retrying with a new session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, headers: new Headers({ "Content-Type": "application/json" }), json: async () => ({ message: "floor editor lease requires renewal" }) }));
    const error = await apiPost("/floors/floor/fixtures/f1/identify", { action: "start" }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("POST /floors/floor/fixtures/f1/identify failed with 409");
    api.identifyFixture.mockRejectedValueOnce(error).mockResolvedValue(response);
    api.acquireFloorEditorLease.mockResolvedValue({ editable: true, token: "token", fence: 1 });
    render(<FixtureIdentifyPanel floorId="floor" readOnly={false} leaseToken="token" leaseFence={1} />);
    fireEvent.click(screen.getByRole("button", { name: "확인 시작" }));
    await screen.findByText("점멸 응답 확인");
    expect(api.acquireFloorEditorLease).toHaveBeenCalledWith("floor", "token");
    expect(api.identifyFixture.mock.calls[0][2].sessionId).not.toBe(api.identifyFixture.mock.calls[1][2].sessionId);
  });
});
