import { describe, expect, it, vi } from "vitest";
import { ApiTimeoutError } from "../../../api/client";
import type { BioSensorPreparationOperation } from "../../../api/automation";
import type { Dashboard } from "../../../api/queries";
import { BioEventSetup } from "./bio-event-setup";

function fixture(ready = false): Dashboard {
  return { site: { id: "site" }, capabilities: { commission: true }, floors: [{ fixtures: [{ id: "sensor", name: "센서등",
    status: "online", controllable: true, gateway: { id: "gateway", assignmentVersion: 1, connectionStatus: "online" },
    vehicleEventSource: { sensorProtocol: "bio-usb-pulse", sourceEligible: ready, readiness: ready ? "ready" : "off" },
    bioSensorPreparation: { preparationCandidate: true, status: ready ? "ready" : "unverified", commandId: null }
  }] }] } as Dashboard;
}
function receipt(status: BioSensorPreparationOperation["status"] = "pending"): BioSensorPreparationOperation {
  return { commandId: "command", siteId: "site", fixtureId: "sensor", operation: "ensure_sensor", catalogRevision: 1,
    status, requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(), supersededAt: null,
    observedAt: null, profileKey: null, modeVerified: status === "ready", linkVerified: status === "ready", blockReason: null, errorCode: null };
}
function harness() {
  let dashboard = fixture(); let current = true;
  const request = vi.fn(async () => receipt());
  const read = vi.fn(async (_commandId: string) => receipt("ready"));
  const refresh = vi.fn(async () => { dashboard = fixture(true); return dashboard; });
  const setup = new BioEventSetup({ request, read, wait: async () => {} });
  const input = { siteId: "site", gatewayId: "gateway", fixtureIds: ["sensor"], scopeKey: "principal:site:0",
    current: () => current, dashboard: () => dashboard, refresh };
  return { setup, input, request, read, refresh, setDashboard: (v: Dashboard) => { dashboard = v; }, cancel: () => { current = false; } };
}
describe("automatic BIO event setup", () => {
  it("uses existing ready evidence without a new device preparation", async () => {
    const h = harness(); h.setDashboard(fixture(true)); await h.setup.prepare(h.input);
    expect(h.request).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });
  it("prepares an unready source once and waits for server eligibility, not only its receipt", async () => {
    const h = harness(); let refreshes = 0;
    h.refresh.mockImplementation(async () => { const d = fixture(++refreshes > 1); h.setDashboard(d); return d; });
    await h.setup.prepare(h.input);
    expect(h.request).toHaveBeenCalledTimes(1); expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ operation: "ensure_sensor", fixtureId: "sensor" }));
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });
  it("resumes a pending server operation without superseding it", async () => {
    const h = harness(), d = fixture(); d.floors[0].fixtures[0].bioSensorPreparation = { preparationCandidate: true, status: "pending", commandId: "existing", profileKey: null, observedAt: null, blockedReasons: [] };
    h.setDashboard(d); h.read.mockResolvedValue({ ...receipt("ready"), commandId: "existing" });
    await h.setup.prepare(h.input); expect(h.request).not.toHaveBeenCalled(); expect(h.read).toHaveBeenCalledWith("existing");
  });
  it("automatically renews a historical ready checkpoint when live eligibility is lost", async () => {
    const h = harness(), d = fixture(); d.floors[0].fixtures[0].bioSensorPreparation = { preparationCandidate: true,
      status: "ready", commandId: "historical", profileKey: "profile", observedAt: "2026-10-01T00:00:00.000Z", blockedReasons: ["link_unverified"] };
    h.setDashboard(d); h.read.mockImplementation(async commandId => ({ ...receipt("ready"), commandId }));
    await h.setup.prepare(h.input); expect(h.request).toHaveBeenCalledTimes(1);
  });
  it("reuses the exact request identity after an uncertain POST outcome", async () => {
    const h = harness(); h.request.mockRejectedValueOnce(new ApiTimeoutError());
    await expect(h.setup.prepare(h.input)).rejects.toBeInstanceOf(ApiTimeoutError);
    await h.setup.prepare(h.input);
    expect(h.request.mock.calls[0]).toEqual(h.request.mock.calls[1]);
  });
  it("reuses the known command after a lost GET instead of another SET", async () => {
    const h = harness(); h.read.mockRejectedValueOnce(new ApiTimeoutError());
    await expect(h.setup.prepare(h.input)).rejects.toBeInstanceOf(ApiTimeoutError);
    await h.setup.prepare(h.input); expect(h.request).toHaveBeenCalledTimes(1);
  });
  it.each(["unverified", "failed", "timed_out", "unsupported"] as const)("does not promote %s into usable evidence", async status => {
    const h = harness(); h.read.mockResolvedValue(receipt(status));
    await expect(h.setup.prepare(h.input)).rejects.toThrow(/설정|연결/); expect(h.refresh).not.toHaveBeenCalled();
  });
  it("stops after scope loss while a preparation response is in flight", async () => {
    const h = harness(); h.request.mockImplementation(async () => { h.cancel(); return receipt(); });
    await expect(h.setup.prepare(h.input)).rejects.toThrow(); expect(h.read).not.toHaveBeenCalled(); expect(h.refresh).not.toHaveBeenCalled();
  });
  it("stops follow-up requests when commission permission is revoked in flight", async () => {
    const h = harness(); h.request.mockImplementation(async () => {
      const d = fixture(); d.capabilities!.commission = false; h.setDashboard(d); return receipt();
    });
    await expect(h.setup.prepare(h.input)).rejects.toThrow(/권한/); expect(h.read).not.toHaveBeenCalled();
  });
  it.each(["site", "gateway", "permission", "offline"])("rejects changed %s before issuing device work", async reason => {
    const h = harness(), d = fixture();
    if (reason === "site") d.site.id = "other";
    if (reason === "gateway") d.floors[0].fixtures[0].gateway!.id = "other";
    if (reason === "permission") d.capabilities!.commission = false;
    if (reason === "offline") d.floors[0].fixtures[0].status = "offline";
    h.setDashboard(d); await expect(h.setup.prepare(h.input)).rejects.toThrow(); expect(h.request).not.toHaveBeenCalled();
  });
  it("rejects mismatched receipts and never refreshes them into eligibility", async () => {
    const h = harness(); h.read.mockResolvedValue({ ...receipt("ready"), fixtureId: "other" });
    await expect(h.setup.prepare(h.input)).rejects.toThrow(); expect(h.refresh).not.toHaveBeenCalled();
  });
});
