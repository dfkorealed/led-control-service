import { describe, expect, it } from "vitest";
import { StubBleMeshAdapter } from "../gateway";
import { handleGatewayDimmingCommand } from "./gateway-command-handler";

const command = {
  commandId: "11111111-1111-4111-8111-111111111111",
  dispatchId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "33333333-3333-4333-8333-333333333333",
  sequence: 1,
  siteId: "44444444-4444-4444-8444-444444444444",
  gatewayId: "55555555-5555-4555-8555-555555555555",
  targetType: "fixture" as const,
  targetId: "66666666-6666-4666-8666-666666666666",
  targetFixtureIds: ["66666666-6666-4666-8666-666666666666"],
  brightness: 65,
  requestedBy: "77777777-7777-4777-8777-777777777777",
  requestedAt: "2026-07-11T00:00:00.000Z"
};

describe("handleGatewayDimmingCommand", () => {
  it("returns acceptance then device status and reuses terminal result for duplicates", async () => {
    const records = new Map<string, any>();
    const journal = {
      get: async (key: string) => records.get(key) ?? null,
      accept: async (key: string, value: unknown) => {
        records.set(key, { state: "accepted", command: value });
        return true;
      },
      complete: async (key: string, result: unknown) => {
        records.set(key, { ...records.get(key), state: "completed", result });
      }
    };
    const adapter = new StubBleMeshAdapter();

    const first = await handleGatewayDimmingCommand(adapter, journal, command);
    const duplicate = await handleGatewayDimmingCommand(adapter, journal, command);

    expect(first.acceptance.status).toBe("accepted");
    expect(first.deviceStatus).toMatchObject({ status: "succeeded", results: [{ status: "succeeded", brightness: 65 }] });
    expect(duplicate).toEqual(first);
    expect(adapter.commands).toHaveLength(1);
  });
});
