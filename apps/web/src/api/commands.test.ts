import { describe, expect, it } from "vitest";
import {
  canonicalizeDimmingCommandInput,
  getCommandStatusRefetchInterval,
  type CommandStatusResponse
} from "./commands";

const requestedCommandId = "00000000-0000-4000-8000-000000009001";

describe("getCommandStatusRefetchInterval", () => {
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
