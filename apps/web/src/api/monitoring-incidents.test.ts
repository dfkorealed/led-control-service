import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";

import * as api from "./monitoring-incidents";
afterEach(() => vi.unstubAllGlobals());

describe("monitoring incident API boundaries", () => {
  it("encodes tenant, all filters and cursor in the request without sharing tenant cache", async () => {
    expect(api.monitoringIncidentsOptions).toBeTypeOf("function");
    const fetch = vi.fn().mockResolvedValue(Response.json({ incidents: [], activeCount: 7, nextCursor: null }));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    const first = api.monitoringIncidentsOptions("a/b", { status: "resolved", type: "fixture_fault", limit: 12 });
    expect(first.queryKey).toEqual(["monitoring-incidents", "a/b", { status: "resolved", type: "fixture_fault", limit: 12 }]);
    await client.fetchInfiniteQuery({ ...first, initialPageParam: "page+2" });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/sites/a%2Fb/monitoring-incidents?status=resolved&type=fixture_fault&limit=12&cursor=page%2B2");
    expect(client.getQueryData(["monitoring-incidents", "other", { status: "resolved", type: "fixture_fault", limit: 12 }])).toBeUndefined();
    client.clear();
  });

  it("patches exact row revision and invalidates every incident filter only in its tenant", async () => {
    expect(api.saveMonitoringIncident).toBeTypeOf("function");
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "row/1" }));
    vi.stubGlobal("fetch", fetch);
    const client = seedCache();
    await api.saveMonitoringIncident(client, "site-a", "row/1", { action: "assign", userId: null, expectedUpdatedAt: "2026-09-12T01:00:00.000Z" });
    expect(fetch.mock.calls[0]).toEqual(["/api/sites/site-a/monitoring-incidents/row%2F1", expect.objectContaining({ method: "PATCH", body: '{"action":"assign","userId":null,"expectedUpdatedAt":"2026-09-12T01:00:00.000Z"}' })]);
    expect(client.getQueryState(["monitoring-incidents", "site-a", { status: "all" }])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["monitoring-incidents", "site-a", { status: "resolved" }])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["dashboard", "site-a"])?.isInvalidated).toBe(false);
    expect(client.getQueryState(["monitoring-incidents", "site-b"])?.isInvalidated).toBe(false);
    client.clear();
  });

  it("policy save invalidates policy, all dashboard and floor pages and incidents only for this site", async () => {
    expect(api.saveMonitoringPolicy).toBeTypeOf("function");
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "site-a" }));
    vi.stubGlobal("fetch", fetch);
    const client = seedCache();
    await api.saveMonitoringPolicy(client, "site-a", { gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 3600, expectedUpdatedAt: "v1" });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/sites/site-a/monitoring-policy");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 3600, expectedUpdatedAt: "v1" });
    for (const key of [["monitoring-policy", "site-a"], ["dashboard", "site-a"], ["dashboard", "site-a", "with-fixtures"], ["floor-fixtures", "site-a", "floor-1"], ["monitoring-incidents", "site-a", { status: "all" }]]) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    for (const key of [["dashboard", "site-b"], ["floor-map", "site-a", "floor-1"], ["monitoring-incidents", "site-b"]]) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    client.clear();
  });

  it("refreshes conflict lists and returns the original error without retrying the mutation", async () => {
    expect(api.saveMonitoringIncident).toBeTypeOf("function");
    const fetch = vi.fn().mockResolvedValue(Response.json({ code: "INCIDENT_STILL_ACTIVE" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const client = seedCache();
    await expect(api.saveMonitoringIncident(client, "site-a", "row", { action: "resolve", note: "수신 확인", expectedUpdatedAt: "v1" })).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(["monitoring-incidents", "site-a", { status: "all" }])?.isInvalidated).toBe(true);
    client.clear();
  });

  it("refreshes the default dashboard alias only when its cached site matches the saved policy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "site-a" })));
    const client = new QueryClient();
    client.setQueryData(["dashboard", "default"], { site: { id: "site-a" } });
    client.setQueryData(["dashboard", "default", "with-fixtures"], { site: { id: "site-b" } });
    await api.saveMonitoringPolicy(client, "site-a", { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180, expectedUpdatedAt: "v1" });
    expect(client.getQueryState(["dashboard", "default"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["dashboard", "default", "with-fixtures"])?.isInvalidated).toBe(false);
    client.clear();
  });
});

function seedCache() {
  const client = new QueryClient();
  for (const key of [["monitoring-policy", "site-a"], ["dashboard", "site-a"], ["dashboard", "site-a", "with-fixtures"], ["dashboard", "site-b"], ["floor-fixtures", "site-a", "floor-1"], ["floor-map", "site-a", "floor-1"], ["monitoring-incidents", "site-a", { status: "all" }], ["monitoring-incidents", "site-a", { status: "resolved" }], ["monitoring-incidents", "site-b"]]) client.setQueryData(key, {});
  return client;
}
