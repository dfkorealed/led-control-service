import { describe, expect, it, vi } from "vitest";
import { mqttTopics, type MeshGroupSubscriptionSyncPayload } from "@led-control/shared";
import { GroupSubscriptionHandler } from "./group-subscription-handler";
import { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

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
      },
      stateStore(),
      new KeyedSerialTaskQueue()
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
      },
      stateStore(),
      new KeyedSerialTaskQueue()
    );
    const source = {
      publish: vi.fn((_topic: string, _payload: string, _options: unknown, callback?: (error?: Error) => void) => callback?.())
    };

    await expect(handler.handle(Buffer.from(JSON.stringify(command({
      gatewayId: "00000000-0000-4000-8000-000000000099"
    }))), source as never)).rejects.toThrow("mesh group subscription scope mismatch");
  });

  it("persists configuring before Config work and ready before publishing the ACK", async () => {
    const events: string[] = [];
    const store = stateStore({
      writeConfiguring: vi.fn(async () => { events.push("configuring"); }),
      writeReady: vi.fn(async () => { events.push("ready"); })
    });
    const adapter = {
      syncGroupSubscriptions: vi.fn(async (input: MeshGroupSubscriptionSyncPayload) => {
        events.push("config");
        return {
          siteId: input.siteId,
          gatewayId: input.gatewayId,
          groupId: input.groupId,
          version: input.version,
          groupAddress: input.groupAddress,
          members: input.members.map((member) => ({ meshNodeId: member.meshNodeId, status: "ready" as const })),
          occurredAt: "2026-08-20T09:00:01.000Z"
        };
      })
    };
    const source = mqttSource(() => events.push("publish"));
    const handler = new GroupSubscriptionHandler(adapter, scope(), store, new KeyedSerialTaskQueue());

    await handler.handle(Buffer.from(JSON.stringify(command())), source as never);

    expect(events).toEqual(["configuring", "config", "ready", "publish"]);
  });

  it("persists failed before publishing a partial failure and never restores prior ready", async () => {
    const events: string[] = [];
    const store = stateStore({ writeFailed: vi.fn(async () => { events.push("failed"); }) });
    const adapter = {
      syncGroupSubscriptions: vi.fn(async (input: MeshGroupSubscriptionSyncPayload) => {
        events.push("config");
        return {
          siteId: input.siteId,
          gatewayId: input.gatewayId,
          groupId: input.groupId,
          version: input.version,
          groupAddress: input.groupAddress,
          members: input.members.map((member, index) => ({
            meshNodeId: member.meshNodeId,
            status: index === 0 ? "ready" as const : "failed" as const,
            ...(index === 0 ? {} : { error: "subscription rejected" })
          })),
          occurredAt: "2026-08-20T09:00:01.000Z"
        };
      })
    };
    const handler = new GroupSubscriptionHandler(adapter, scope(), store, new KeyedSerialTaskQueue());

    await handler.handle(Buffer.from(JSON.stringify(command())), mqttSource(() => events.push("publish")) as never);

    expect(events).toEqual(["config", "failed", "publish"]);
    expect(store.writeReady).not.toHaveBeenCalled();
  });

  it("does not call Config or publish when configuring state cannot be persisted", async () => {
    const adapter = { syncGroupSubscriptions: vi.fn() };
    const store = stateStore({ writeConfiguring: vi.fn(async () => { throw new Error("disk full"); }) });
    const source = mqttSource();
    const handler = new GroupSubscriptionHandler(adapter as never, scope(), store, new KeyedSerialTaskQueue());

    await expect(handler.handle(Buffer.from(JSON.stringify(command())), source as never)).rejects.toThrow("disk full");
    expect(adapter.syncGroupSubscriptions).not.toHaveBeenCalled();
    expect(source.publish).not.toHaveBeenCalled();
  });

  it("serializes the same group and allows different groups to synchronize concurrently", async () => {
    const queue = new KeyedSerialTaskQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = {
      syncGroupSubscriptions: vi.fn(async (input: MeshGroupSubscriptionSyncPayload) => {
        events.push(`${input.groupId}:start`);
        if (input.groupId.endsWith("12")) await gate;
        events.push(`${input.groupId}:end`);
        return {
          siteId: input.siteId,
          gatewayId: input.gatewayId,
          groupId: input.groupId,
          version: input.version,
          groupAddress: input.groupAddress,
          members: input.members.map((member) => ({ meshNodeId: member.meshNodeId, status: "ready" as const })),
          occurredAt: "2026-08-20T09:00:01.000Z"
        };
      })
    };
    const handler = new GroupSubscriptionHandler(adapter, scope(), stateStore(), queue);
    const first = handler.handle(Buffer.from(JSON.stringify(command())), mqttSource() as never);
    const same = handler.handle(Buffer.from(JSON.stringify(command({ version: 4 }))), mqttSource() as never);
    const other = handler.handle(Buffer.from(JSON.stringify(command({
      groupId: "00000000-0000-4000-8000-000000000099",
      groupAddress: "0xc001"
    }))), mqttSource() as never);

    await vi.waitFor(() => expect(events).toEqual([
      "00000000-0000-4000-8000-000000000012:start",
      "00000000-0000-4000-8000-000000000099:start",
      "00000000-0000-4000-8000-000000000099:end"
    ]));
    release();
    await Promise.all([first, same, other]);
    expect(events.slice(-3)).toEqual([
      "00000000-0000-4000-8000-000000000012:end",
      "00000000-0000-4000-8000-000000000012:start",
      "00000000-0000-4000-8000-000000000012:end"
    ]);
  });
});

function scope() {
  return {
    siteId: "00000000-0000-4000-8000-000000000010",
    gatewayId: "00000000-0000-4000-8000-000000000011"
  };
}

function stateStore(overrides: Record<string, unknown> = {}) {
  return {
    writeConfiguring: vi.fn(async () => undefined),
    writeReady: vi.fn(async () => undefined),
    writeFailed: vi.fn(async () => undefined),
    ...overrides
  } as any;
}

function mqttSource(onPublish: () => void = () => undefined) {
  return {
    publish: vi.fn((_topic: string, _payload: string, _options: unknown, callback?: (error?: Error) => void) => {
      onPublish();
      callback?.();
    })
  };
}
