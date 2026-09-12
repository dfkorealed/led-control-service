import { parseIncidentMutation, parseIncidentQuery, parseMonitoringPolicy, encodeIncidentCursor } from "./monitoring-incidents.dto";

const timestamp = "2026-09-12T00:00:00.000Z";
const siteId = "11111111-1111-4111-8111-111111111111";

describe("monitoring incident strict inputs", () => {
  it.each([[30, 60], [900, 3600]])("accepts inclusive threshold boundaries %i/%i", (gateway, fixture) => {
    expect(parseMonitoringPolicy({ gatewayOfflineAfterSeconds: gateway, fixtureStaleAfterSeconds: fixture, expectedUpdatedAt: timestamp }))
      .toEqual({ gatewayOfflineAfterSeconds: gateway, fixtureStaleAfterSeconds: fixture, expectedUpdatedAt: timestamp });
  });
  it.each([
    { gatewayOfflineAfterSeconds: 29 }, { gatewayOfflineAfterSeconds: 901 },
    { fixtureStaleAfterSeconds: 59 }, { fixtureStaleAfterSeconds: 3601 },
    { fixtureStaleAfterSeconds: 60.5 }, { gatewayOfflineAfterSeconds: "90" },
    { expectedUpdatedAt: undefined }, { expectedUpdatedAt: "invalid" }, { extra: true }
  ])("rejects malformed policy %j", (patch) => {
    expect(() => parseMonitoringPolicy({ gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180, expectedUpdatedAt: timestamp, ...patch }))
      .toThrow(expect.objectContaining({ status: 400 }));
  });
  it.each([
    { action: "acknowledge" }, { action: "assign", userId: null },
    { action: "assign", userId: siteId }, { action: "resolve", note: "상태 정상 확인" }
  ])("accepts action-specific body %j", (action) => {
    expect(parseIncidentMutation({ ...action, expectedUpdatedAt: timestamp })).toEqual({ ...action, expectedUpdatedAt: timestamp });
  });
  it.each([
    { action: "open" }, { action: "assign" }, { action: "assign", userId: "bad" },
    { action: "acknowledge", note: "extra" }, { action: "resolve", note: " " },
    { action: "resolve", note: "x".repeat(2001) }, { action: "resolve", note: "ok", assignedToUserId: siteId },
    { action: "acknowledge", expectedUpdatedAt: undefined }
  ])("rejects malformed mutation %j", (action) => {
    expect(() => parseIncidentMutation({ expectedUpdatedAt: timestamp, ...action })).toThrow(expect.objectContaining({ status: 400 }));
  });
  it("bounds query limits and binds cursor to site and filters", () => {
    expect(parseIncidentQuery({}, siteId)).toEqual({ limit: 25, status: "all" });
    const cursor = encodeIncidentCursor({ siteId, status: "all", active: true, openedAt: new Date(timestamp), id: siteId });
    expect(parseIncidentQuery({ cursor, limit: "100" }, siteId)).toMatchObject({ limit: 100, cursor: { active: true, id: siteId } });
    for (const query of [{ limit: "101" }, { limit: "0" }, { limit: ["10"] }, { cursor: "x".repeat(1025) }, { cursor, status: "resolved" }, { cursor, type: "fixture_fault" }, { status: "active" }, { type: "other" }, { unknown: 1 }]) {
      expect(() => parseIncidentQuery(query, siteId)).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(() => parseIncidentQuery({ cursor }, "22222222-2222-4222-8222-222222222222")).toThrow();
  });
});
