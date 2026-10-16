import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFixtureRegistrationRemovalPreview, requestFixtureRegistrationRemoval,
  getFixtureRegistrationRemoval, findFixtureRegistrationRemovalByRequest
} from "./fixture-registration-removals";

const scope = { siteId: "11111111-1111-4111-8111-111111111111", floorId: "22222222-2222-4222-8222-222222222222", fixtureId: "33333333-3333-4333-8333-333333333333" };
const operationId = "44444444-4444-4444-8444-444444444444";
const input = { clientRequestId: "55555555-5555-4555-8555-555555555555", expectedUpdatedAt: "2026-10-16T00:00:00.000Z" };
const view = { ...scope, operationId, status: "pending", errorCode: null, createdAt: input.expectedUpdatedAt, completedAt: null };
const base = `/api/sites/${scope.siteId}/floors/${scope.floorId}/fixtures/${scope.fixtureId}`;
afterEach(() => vi.unstubAllGlobals());

describe("fixture registration removal HTTP boundary", () => {
  it("uses authenticated exact preview, POST 202, operation and by-request paths", async () => {
    const preview = { fixtureId: scope.fixtureId, fixtureName: "B2-L01", serialNumber: "BIO-01", expectedUpdatedAt: input.expectedUpdatedAt, allowed: true, blockedReasons: [] };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(Response.json(view, { status: 202 }))
      .mockResolvedValueOnce(Response.json(view)).mockResolvedValueOnce(Response.json(null));
    vi.stubGlobal("fetch", fetch);
    expect(await getFixtureRegistrationRemovalPreview(scope)).toEqual(preview);
    expect(await requestFixtureRegistrationRemoval(scope, input)).toEqual(view);
    expect(await getFixtureRegistrationRemoval(scope, operationId)).toEqual(view);
    expect(await findFixtureRegistrationRemovalByRequest(scope, input.clientRequestId)).toBeNull();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${base}/registration-removal-preview`, `${base}/registration-removals`,
      `${base}/registration-removals/${operationId}`, `${base}/registration-removals/by-request/${input.clientRequestId}`
    ]);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify(input) });
  });

  it("rejects stale/invalid request bodies before network I/O", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(requestFixtureRegistrationRemoval(scope, { ...input, clientRequestId: "bad" })).rejects.toThrow();
    await expect(requestFixtureRegistrationRemoval(scope, { ...input, expectedUpdatedAt: "2026-10-16" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...view, status: "unknown" }, { ...view, status: "completed", completedAt: null },
    { ...view, siteId: operationId }, { ...view, fixtureId: operationId }, { ...view, floorId: operationId },
    { ...view, extra: true }, { ...view, operationId: input.clientRequestId }
  ])("rejects malformed or mismatched operation responses: %j", async response => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
    await expect(getFixtureRegistrationRemoval(scope, operationId)).rejects.toThrow();
  });

  it("rejects mismatched preview identity and contradictory permission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ fixtureId: operationId, fixtureName: "Other", serialNumber: null, expectedUpdatedAt: input.expectedUpdatedAt, allowed: true, blockedReasons: [] }))
      .mockResolvedValueOnce(Response.json({ fixtureId: scope.fixtureId, fixtureName: "Light", serialNumber: null, expectedUpdatedAt: input.expectedUpdatedAt, allowed: true, blockedReasons: [{ code: "OFFLINE", message: "offline" }] })));
    await expect(getFixtureRegistrationRemovalPreview(scope)).rejects.toThrow();
    await expect(getFixtureRegistrationRemovalPreview(scope)).rejects.toThrow();
  });

  it.each([undefined, "2026-10-16", "invalid"])("rejects a preview without a precise confirmation timestamp: %s", async expectedUpdatedAt => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ fixtureId: scope.fixtureId, fixtureName: "Light", serialNumber: null,
      expectedUpdatedAt, allowed: true, blockedReasons: [] })));
    await expect(getFixtureRegistrationRemovalPreview(scope)).rejects.toThrow();
  });
});
