import { afterEach, expect, it, vi } from "vitest";
import { getBioSensorPolicy, listBioSensorProfiles, requestBioSensorPreparation, getBioSensorPreparation, saveBioSensorPolicy, revokeBioSensorProfile } from "./automation";
afterEach(() => vi.unstubAllGlobals());
it("uses authenticated sanitized preparation/policy/profile routes and does not send raw discovery fields", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 }))); vi.stubGlobal("fetch", fetcher);
  await requestBioSensorPreparation({ siteId: "site", fixtureId: "fixture", clientRequestId: "request", operation: "query" });
  await getBioSensorPreparation("command/id"); await getBioSensorPolicy("site/id");
  await saveBioSensorPolicy("site/id", { enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null });
  await listBioSensorProfiles(); await revokeBioSensorProfile("profile/id");
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(["/api/bio-sensor-preparations", "/api/bio-sensor-preparations/command%2Fid",
    "/api/sites/site%2Fid/bio-sensor-policy", "/api/sites/site%2Fid/bio-sensor-policy", "/api/bio-sensor-profiles", "/api/bio-sensor-profiles/profile%2Fid/revoke"]);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ siteId: "site", fixtureId: "fixture", clientRequestId: "request", operation: "query" });
  expect(fetcher.mock.calls[3][1].method).toBe("PUT");
  expect(fetcher.mock.calls.every(call => call[1].credentials === "include")).toBe(true);
});
