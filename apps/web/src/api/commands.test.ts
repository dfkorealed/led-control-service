import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeDimmingCommandInput,
  getCommandStatusRefetchInterval,
  listCommands,
  createCommandStatusCheck,
  type CommandStatusResponse
} from "./commands";

const requestedCommandId = "00000000-0000-4000-8000-000000009001";

describe("getCommandStatusRefetchInterval", () => {
  it("keeps polling until a newly accepted verification dispatch is visible in detail", () => {
    expect(getCommandStatusRefetchInterval(requestedCommandId, createStatus(requestedCommandId, "verification_required"), ["new-check"])).toBe(1000);
  });
  it.each(["verification_required", "verified_applied", "verified_not_applied", "verified_partial"] as const)("stops polling settled %s", (stage) => {
    expect(getCommandStatusRefetchInterval(requestedCommandId, createStatus(requestedCommandId, stage))).toBe(false);
  });

  it.each(["pending", "published", "accepted", "timed_out"])("polls verification only while its dispatch is in flight: %s", (status) => {
    const command = createStatus(requestedCommandId, "verification_required");
    command.dispatches = [{ id: "check", kind: "status_check", verificationAttempt: 1, status, gateway: { id: "gw", name: "GW" }, errorMessage: null, results: [] }];
    expect(getCommandStatusRefetchInterval(requestedCommandId, command)).toBe(status === "timed_out" ? false : 1000);
  });
  it("keeps polling a matching nonterminal command", () => {
    expect(getCommandStatusRefetchInterval(
      requestedCommandId,
      createStatus(requestedCommandId, "accepted")
    )).toBe(1000);
  });

  it("stops polling a matching terminal command", () => {
    expect(getCommandStatusRefetchInterval(
      requestedCommandId,
      createStatus(requestedCommandId, "completed")
    )).toBe(false);
  });

  it("keeps polling a terminal response for a different command", () => {
    expect(getCommandStatusRefetchInterval(
      requestedCommandId,
      createStatus("00000000-0000-4000-8000-000000009002", "completed")
    )).toBe(1000);
  });

  it("keeps polling while no status is available", () => {
    expect(getCommandStatusRefetchInterval(requestedCommandId, null)).toBe(1000);
  });
});

describe("command recovery API", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("encodes history search, stage and opaque cursor without losing their scope", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], nextCursor: null }) });
    vi.stubGlobal("fetch", fetch);
    await listCommands({ siteId: "site", query: "B2 조명&", stage: "verification_required", cursor: "a+b/=", limit: 20 });
    expect(fetch.mock.calls[0][0]).toBe("/api/commands?siteId=site&query=B2+%EC%A1%B0%EB%AA%85%26&stage=verification_required&cursor=a%2Bb%2F%3D&limit=20");
  });
  it("replays a status-check HTTP request with the caller's same idempotency key", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ dispatchId: "check", dispatchIds: ["check"], verificationAttempt: 1, terminalStatusUrl: "/commands/id" }) });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await createCommandStatusCheck("id", "same-request", controller.signal);
    await createCommandStatusCheck("id", "same-request", controller.signal);
    expect(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body), init.signal])).toEqual([
      ["/api/commands/id/status-checks", { clientRequestId: "same-request" }, controller.signal],
      ["/api/commands/id/status-checks", { clientRequestId: "same-request" }, controller.signal]
    ]);
  });
});

describe("canonicalizeDimmingCommandInput", () => {
  it("sorts a copied multi-fixture target without mutating the caller payload", () => {
    const fixtureIds = [
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002"
    ];
    const input = {
      siteId: "00000000-0000-4000-8000-000000000001",
      clientRequestId: "00000000-0000-4000-8000-000000000004",
      target: { type: "fixtures" as const, fixtureIds },
      brightness: 30
    };

    const canonical = canonicalizeDimmingCommandInput(input);
    expect(canonical.target).toEqual({
      type: "fixtures",
      fixtureIds: [...fixtureIds].sort()
    });
    expect(input.target.fixtureIds).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002"
    ]);
    expect(canonical.target).not.toBe(input.target);
  });
});

function createStatus(
  id: string,
  stage: CommandStatusResponse["stage"]
): CommandStatusResponse {
  return {
    id,
    stage,
    dispatchCount: 0,
    completedFixtureCount: 0,
    totalFixtureCount: 0,
    errorMessage: null,
    dispatches: []
  };
}
