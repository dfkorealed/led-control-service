import { mqttTopics } from "@led-control/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationCurrentConfigRequester } from "./automation-current-config-requester";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";

describe("AutomationCurrentConfigRequester", () => {
  afterEach(() => vi.useRealTimers());

  it("does not publish or accept a snapshot confirmation when the declaration fsync fails", async () => {
    vi.useFakeTimers();
    const requester = new AutomationCurrentConfigRequester(automationScope, {
      protocolSupport: { assignmentVersion: 4, maxSnapshotVersion: 2,
        nextRevision: async () => { throw new Error("declaration fsync failed"); } }
    });
    const publish = vi.fn(async () => {});
    await expect(requester.connect(publish)).rejects.toThrow("declaration fsync failed");
    expect(publish).not.toHaveBeenCalled();
    expect(requester.confirm({ ...automationScope, schemaVersion: 2 })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    requester.disconnect();
  });

  it("retires the previous declaration before a reconnect allocation can fail", async () => {
    vi.useFakeTimers();
    let revision = 0;
    const requester = new AutomationCurrentConfigRequester(automationScope, {
      protocolSupport: { assignmentVersion: 4, maxSnapshotVersion: 2,
        nextRevision: async () => { if (++revision > 1) throw new Error("fsync failed"); return revision; } }
    });
    await requester.connect(async () => {});
    await expect(requester.connect(async () => {})).rejects.toThrow("fsync failed");
    expect(requester.confirm({ ...automationScope, schemaVersion: 2 })).toBe(false);
    requester.disconnect();
  });

  it("publishes explicit V2 support only after allocating a durable declaration revision", async () => {
    vi.useFakeTimers();
    let release!: (value: number) => void;
    const requester = new AutomationCurrentConfigRequester(automationScope, {
      protocolSupport: { assignmentVersion: 4, maxSnapshotVersion: 2,
        nextRevision: () => new Promise<number>(resolve => { release = resolve; }) }
    } as never);
    const publish = vi.fn().mockResolvedValue(undefined);
    const connecting = requester.connect(publish);
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
    release(7);
    await connecting;
    expect(publish.mock.calls[0][1]).toMatchObject({ schemaVersion: 2,
      assignmentVersion: 4, declarationRevision: 7, maxSnapshotVersion: 2 });
    expect(requester.confirm(automationSnapshot(1))).toBe(false);
    requester.disconnect();
  });

  it("publishes on every subscription-ready connect and retries one exact request with bounded backoff until a snapshot arrives", async () => {
    vi.useFakeTimers();
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ];
    const requester = new AutomationCurrentConfigRequester(automationScope, {
      createRequestId: () => ids.shift()!,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      random: () => 0,
      retryInitialDelayMs: 10,
      retryMaxDelayMs: 20
    });
    const publish = vi.fn().mockResolvedValue(undefined);

    await requester.connect(publish);
    const [topic, firstRequest] = publish.mock.calls[0];
    expect(topic).toBe(mqttTopics.automationCurrentConfigRequest(automationScope.siteId, automationScope.gatewayId));
    expect(firstRequest).toEqual({
      schemaVersion: 1,
      requestId: "11111111-1111-4111-8111-111111111111",
      ...automationScope,
      requestedAt: "2026-08-31T00:00:00.000Z"
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][1]).toEqual(firstRequest);
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(requester.confirm({ ...automationSnapshot(4), gatewayId: "33333333-3333-4333-8333-333333333333" })).toBe(false);
    expect(requester.confirm(automationSnapshot(4))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    requester.disconnect();
    await requester.connect(publish);
    expect(publish.mock.calls[3][1]).toMatchObject({
      requestId: "22222222-2222-4222-8222-222222222222"
    });
    requester.disconnect();
  });
});
