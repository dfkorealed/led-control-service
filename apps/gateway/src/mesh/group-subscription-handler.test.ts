import { describe, expect, it, vi } from "vitest";
import { mqttTopics, type MeshGroupSubscriptionResultPayload, type MeshGroupSubscriptionSyncPayload } from "@led-control/shared";
import { GroupSubscriptionHandler } from "./group-subscription-handler";
import { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

const ids = { siteId: "00000000-0000-4000-8000-000000000010", gatewayId: "00000000-0000-4000-8000-000000000011", groupId: "00000000-0000-4000-8000-000000000012", memberId: "00000000-0000-4000-8000-000000000013" };

function command(overrides: Partial<MeshGroupSubscriptionSyncPayload> = {}): MeshGroupSubscriptionSyncPayload {
  return { siteId: ids.siteId, gatewayId: ids.gatewayId, groupId: ids.groupId, version: 3, groupAddress: "0xc000", desiredMembers: [{ meshNodeId: ids.memberId, meshAddress: "0x0100" }], requestedAt: "2026-08-20T09:00:00.000Z", ...overrides };
}
function result(input: MeshGroupSubscriptionSyncPayload, operations: MeshGroupSubscriptionResultPayload["operations"]): MeshGroupSubscriptionResultPayload {
  return { siteId: ids.siteId, gatewayId: ids.gatewayId, groupId: input.groupId, version: input.version, groupAddress: input.groupAddress, operations, occurredAt: "2026-08-20T09:00:01.000Z" };
}
function stateStore() { return { readAppliedMembers: vi.fn(async () => []), writeConfiguring: vi.fn(async () => undefined), writeReady: vi.fn(async () => undefined), writeFailed: vi.fn(async () => undefined) } as any; }
function source() { return { publish: vi.fn((_topic: string, _payload: string, _options: unknown, done?: (error?: Error) => void) => done?.()) }; }

describe("GroupSubscriptionHandler", () => {
  it("publishes Gateway-created add operations for the cloud desired membership", async () => {
    const adapter = { syncGroupSubscriptions: vi.fn(async (input: MeshGroupSubscriptionSyncPayload) => result(input, [{ operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", action: "add", meshNodeId: ids.memberId, status: "ready" }])) };
    const store = stateStore();
    const mqtt = source();
    const handler = new GroupSubscriptionHandler(adapter, { siteId: ids.siteId, gatewayId: ids.gatewayId }, store, new KeyedSerialTaskQueue());
    await handler.handle(Buffer.from(JSON.stringify(command())), mqtt as never);
    expect(adapter.syncGroupSubscriptions).toHaveBeenCalledWith(command(), []);
    expect(store.writeReady).toHaveBeenCalledTimes(1);
    expect(mqtt.publish).toHaveBeenCalledWith(mqttTopics.meshGroupSubscriptionResult(ids.siteId, ids.gatewayId), expect.stringContaining('"operations"'), { qos: 1 }, expect.any(Function));
  });

  it("accepts an empty desired set and publishes the Gateway-created delete operation", async () => {
    const adapter = { syncGroupSubscriptions: vi.fn(async (input: MeshGroupSubscriptionSyncPayload) => result(input, [{ operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", action: "delete", meshNodeId: ids.memberId, status: "ready" }])) };
    const mqtt = source();
    const handler = new GroupSubscriptionHandler(adapter, { siteId: ids.siteId, gatewayId: ids.gatewayId }, stateStore(), new KeyedSerialTaskQueue());
    await handler.handle(Buffer.from(JSON.stringify(command({ desiredMembers: [] }))), mqtt as never);
    expect(JSON.parse(mqtt.publish.mock.calls[0][1]).operations).toEqual([expect.objectContaining({ action: "delete" })]);
  });

  it("rejects a command outside the subscribed gateway scope", async () => {
    const adapter = { syncGroupSubscriptions: vi.fn() };
    const handler = new GroupSubscriptionHandler(adapter, { siteId: ids.siteId, gatewayId: ids.gatewayId }, stateStore(), new KeyedSerialTaskQueue());
    await expect(handler.handle(Buffer.from(JSON.stringify(command({ gatewayId: "00000000-0000-4000-8000-000000000099" }))), source() as never)).rejects.toThrow("mesh group subscription scope mismatch");
    expect(adapter.syncGroupSubscriptions).not.toHaveBeenCalled();
  });

  it("persists failed before publishing a Gateway operation failure", async () => {
    const adapter = { syncGroupSubscriptions: vi.fn(async (input: MeshGroupSubscriptionSyncPayload) => result(input, [{ operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", action: "add", meshNodeId: ids.memberId, status: "failed", error: "subscription rejected" }])) };
    const store = stateStore();
    const handler = new GroupSubscriptionHandler(adapter, { siteId: ids.siteId, gatewayId: ids.gatewayId }, store, new KeyedSerialTaskQueue());
    await handler.handle(Buffer.from(JSON.stringify(command())), source() as never);
    expect(store.writeFailed).toHaveBeenCalledTimes(1);
    expect(store.writeReady).not.toHaveBeenCalled();
  });

  it("fails closed when the adapter returns an invalid operation payload", async () => {
    const adapter = { syncGroupSubscriptions: vi.fn(async () => ({ siteId: ids.siteId, gatewayId: ids.gatewayId, groupId: ids.groupId, version: 3, groupAddress: "0xc000", members: [] })) };
    const store = stateStore();
    const handler = new GroupSubscriptionHandler(adapter as never, { siteId: ids.siteId, gatewayId: ids.gatewayId }, store, new KeyedSerialTaskQueue());
    await expect(handler.handle(Buffer.from(JSON.stringify(command())), source() as never)).rejects.toThrow();
    expect(store.writeFailed).toHaveBeenCalledTimes(1);
  });
});
