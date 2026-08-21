import { describe, expect, it, vi } from "vitest";
import { mqttTopics, type MeshGroupSubscriptionSyncPayload } from "@led-control/shared";
import { GroupSubscriptionHandler } from "./group-subscription-handler";

function command(overrides: Partial<MeshGroupSubscriptionSyncPayload> = {}): MeshGroupSubscriptionSyncPayload {
  return {
    siteId: "00000000-0000-4000-8000-000000000010",
    gatewayId: "00000000-0000-4000-8000-000000000011",
    groupId: "00000000-0000-4000-8000-000000000012",
    version: 3,
    groupAddress: "0xc000",
    members: [
      {
        meshNodeId: "00000000-0000-4000-8000-000000000013",
        meshAddress: "0x0100"
      },
      {
        meshNodeId: "00000000-0000-4000-8000-000000000014",
        meshAddress: "0x0101"
      }
    ],
    requestedAt: "2026-08-20T09:00:00.000Z",
    ...overrides
  };
}

describe("GroupSubscriptionHandler", () => {
  it("reapplies Light Lightness Server subscriptions and publishes one scoped result", async () => {
    const syncGroupSubscriptions = vi.fn(async () => ({
      siteId: "00000000-0000-4000-8000-000000000010",
      gatewayId: "00000000-0000-4000-8000-000000000011",
      groupId: "00000000-0000-4000-8000-000000000012",
      version: 3,
      groupAddress: "0xc000",
      occurredAt: "2026-08-20T09:00:01.000Z",
      members: [
        { meshNodeId: "00000000-0000-4000-8000-000000000013", status: "ready" as const },
        { meshNodeId: "00000000-0000-4000-8000-000000000014", status: "failed" as const, error: "subscription rejected" }
      ]
    }));
    const handler = new GroupSubscriptionHandler(
      { syncGroupSubscriptions } as never,
      {
        siteId: "00000000-0000-4000-8000-000000000010",
        gatewayId: "00000000-0000-4000-8000-000000000011"
      }
    );
    const source = {
      publish: vi.fn((_topic: string, _payload: string, _options: unknown, callback?: (error?: Error) => void) => callback?.())
    };

    await handler.handle(Buffer.from(JSON.stringify(command())), source as never);

    expect(syncGroupSubscriptions).toHaveBeenCalledWith(command());
    expect(source.publish).toHaveBeenCalledTimes(1);
    expect(source.publish.mock.calls[0][0]).toBe(
      mqttTopics.meshGroupSubscriptionResult(
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000011"
      )
    );
    expect(JSON.parse(source.publish.mock.calls[0][1])).toEqual(expect.objectContaining({
      groupId: "00000000-0000-4000-8000-000000000012",
      version: 3,
      members: [
        { meshNodeId: "00000000-0000-4000-8000-000000000013", status: "ready" },
        { meshNodeId: "00000000-0000-4000-8000-000000000014", status: "failed", error: "subscription rejected" }
      ]
    }));
    expect(source.publish.mock.calls[0][2]).toEqual({ qos: 1 });
  });

  it("rejects payloads whose site or gateway does not match the subscribed topic scope", async () => {
    const handler = new GroupSubscriptionHandler(
      { syncGroupSubscriptions: vi.fn() } as never,
      {
        siteId: "00000000-0000-4000-8000-000000000010",
        gatewayId: "00000000-0000-4000-8000-000000000011"
      }
    );
    const source = {
      publish: vi.fn((_topic: string, _payload: string, _options: unknown, callback?: (error?: Error) => void) => callback?.())
    };

    await expect(handler.handle(Buffer.from(JSON.stringify(command({
      gatewayId: "00000000-0000-4000-8000-000000000099"
    }))), source as never)).rejects.toThrow("mesh group subscription scope mismatch");
  });
});
