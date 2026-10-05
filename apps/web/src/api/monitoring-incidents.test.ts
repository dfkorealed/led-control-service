import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissAllMonitoringIncidents, dismissMonitoringIncident, listMonitoringIncidents, markMonitoringIncidentRead } from "./monitoring-incidents";

const incidentId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const instant = "2026-10-01T15:00:00.123Z";
const incident = {
  id: incidentId, siteId, type: "gateway_offline", status: "open", targetKey: "gateway:gateway-1",
  fixtureId: null, gatewayId: "gateway-1", openedAt: instant, lastObservedAt: instant,
  acknowledgedAt: null, acknowledgedByUserId: null, assignedToUserId: null, resolvedAt: null,
  resolvedByUserId: null, resolutionKind: null, resolutionNote: null, createdAt: instant, updatedAt: instant,
  acknowledgedBy: null, assignedTo: null, resolvedBy: null,
  target: { kind: "gateway", id: "gateway-1", name: "입구 Gateway" }, isRead: false, readAt: null,
  isDismissed: false, dismissedAt: null
};
const response = { incidents: [incident], activeCount: 1, unreadCount: 7, nextCursor: "cursor_2" };
afterEach(() => vi.unstubAllGlobals());

describe("monitoring incident API", () => {
  it("sends strict independent dismissal bodies and validates the server result identity", async () => {
    const clientRequestId = "00000000-0000-4000-8000-000000000003";
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ incidentId, isDismissed: true, dismissedAt: instant }))
      .mockResolvedValueOnce(Response.json({ siteId, clientRequestId, snapshotAt: instant, dismissedCount: 42 }));
    vi.stubGlobal("fetch", fetch);
    expect(await dismissMonitoringIncident(siteId, incidentId)).toEqual({ incidentId, isDismissed: true, dismissedAt: instant });
    expect(fetch.mock.calls[0][0]).toBe(`/api/sites/${siteId}/monitoring-incidents/${incidentId}/dismiss`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "PUT", body: "{}" });
    expect(await dismissAllMonitoringIncidents(siteId, clientRequestId)).toEqual({ siteId, clientRequestId, snapshotAt: instant, dismissedCount: 42 });
    expect(fetch.mock.calls[1][0]).toBe(`/api/sites/${siteId}/monitoring-incidents/dismiss-all`);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ clientRequestId }) });
  });
  it.each([
    { siteId: "other" }, { clientRequestId: "other" }, { dismissedCount: -1 }, { dismissedCount: 0.5 },
    { snapshotAt: "invalid" }, { isRead: true }
  ])("rejects a wrong-scope malformed or extra-field bulk result", async change => {
    const clientRequestId = "00000000-0000-4000-8000-000000000003";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ siteId, clientRequestId, snapshotAt: instant, dismissedCount: 1, ...change })));
    await expect(dismissAllMonitoringIncidents(siteId, clientRequestId)).rejects.toThrow("Invalid monitoring incident dismissal result");
  });
  it("requests personal view explicitly without changing read or incident state", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetch);
    await listMonitoringIncidents(siteId, { view: "personal" });
    expect(fetch.mock.calls[0][0]).toBe(`/api/sites/${siteId}/monitoring-incidents?view=personal`);
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });

  it.each([
    { ...incident, isDismissed: undefined },
    { ...incident, isDismissed: true, dismissedAt: null },
    { ...incident, isDismissed: false, dismissedAt: instant },
    { ...incident, isDismissed: true, dismissedAt: "invalid" }
  ])("rejects malformed dismissal state instead of accepting an old row shape", async row => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...response, incidents: [row] })));
    await expect(listMonitoringIncidents(siteId)).rejects.toThrow("Invalid monitoring incidents response");
  });
  it("validates the actual incidents envelope and keeps canonical unread count independent of the page", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(response));
    vi.stubGlobal("fetch", fetch);
    expect(await listMonitoringIncidents(siteId, { limit: 25, cursor: "cursor_1", status: "all", type: "gateway_offline" })).toEqual(response);
    expect(fetch.mock.calls[0][0]).toBe(`/api/sites/${siteId}/monitoring-incidents?limit=25&cursor=cursor_1&status=all&type=gateway_offline`);
  });

  it.each([
    { ...response, incidents: undefined, items: [incident] },
    { ...response, unreadCount: -1 },
    { ...response, unreadCount: "7" },
    { ...response, unreadCount: 0 },
    { ...response, activeCount: 0.5 },
    { ...response, incidents: [{ ...incident, isRead: undefined }] },
    { ...response, incidents: [{ ...incident, isRead: true, readAt: null }] },
    { ...response, incidents: [{ ...incident, type: "invented" }] },
    { ...response, incidents: [{ ...incident, type: ["gateway_offline"] }] },
    { ...response, incidents: [{ ...incident, status: ["open"] }] },
    { ...response, incidents: [{ ...incident, resolutionKind: ["automatic_recovery"] }] },
    { ...response, incidents: [{ ...incident, target: null }] },
    { ...response, incidents: [{ ...incident, openedAt: "invalid" }] },
    { ...response, incidents: [{ ...incident, openedAt: "2026-02-30T15:00:00.123Z" }] },
    { ...response, incidents: [{ ...incident, siteId: "other-site" }] }
  ])("rejects malformed or wrong-site responses instead of presenting false counts", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(listMonitoringIncidents(siteId, { limit: 1 })).rejects.toThrow();
  });

  it("sends an empty PUT and validates the successful personal receipt", async () => {
    const receipt = { incidentId, isRead: true, readAt: instant };
    const fetch = vi.fn().mockResolvedValue(Response.json(receipt));
    vi.stubGlobal("fetch", fetch);
    expect(await markMonitoringIncidentRead("site / 1", incidentId)).toEqual(receipt);
    expect(fetch.mock.calls[0][0]).toBe(`/api/sites/site%20%2F%201/monitoring-incidents/${incidentId}/read`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "PUT", body: "{}", credentials: "include" });
  });

  it("accepts the existing automatic recovery status and preserves read timestamp precision", async () => {
    const readAt = "2026-10-01T15:00:00.123456Z";
    const recovered = { ...incident, status: "resolved", resolvedAt: instant, resolutionKind: "automatic_recovery", isRead: true, readAt };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...response, incidents: [recovered] })));
    expect((await listMonitoringIncidents(siteId)).incidents[0].readAt).toBe(readAt);
  });

  it.each([
    { incidentId, isRead: false, readAt: instant },
    { incidentId, isRead: true, readAt: null },
    { incidentId: "another-incident", isRead: true, readAt: instant }
  ])("rejects an invalid receipt without manufacturing read success", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(markMonitoringIncidentRead(siteId, incidentId)).rejects.toThrow();
  });
});
