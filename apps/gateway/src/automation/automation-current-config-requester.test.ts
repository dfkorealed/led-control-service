import { mqttTopics } from "@led-control/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationCurrentConfigRequester } from "./automation-current-config-requester";
import { FileAutomationConfigStore } from "./automation-config-store";
import { AutomationConfigAckOutbox } from "./automation-config-ack-outbox";
import { AutomationRuntime } from "./automation-runtime";
import { handleAutomationConfigPayload } from "../gateway";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";

describe("AutomationCurrentConfigRequester", () => {
  afterEach(() => vi.useRealTimers());

  it("declares exact V3 temporary configuration capabilities with a durable revision", async () => {
    const requester = new AutomationCurrentConfigRequester(automationScope, {
      protocolSupport: { assignmentVersion: 4, maxSnapshotVersion: 3, nextRevision: async () => 8 } as never
    });
    const delivered: unknown[] = [];
    try {
      await requester.connect(async (_topic, value) => { delivered.push(value); });
      expect(delivered).toEqual([expect.objectContaining({ schemaVersion: 3, maxSnapshotVersion: 3,
        assignmentVersion: 4, declarationRevision: 8, temporaryControlVersion: 1,
        bioConfigurationReadback: true, durableFixtureLease: true })]);
    } finally { requester.disconnect(); }
  });

  it.each(["reject", "timeout"])("retries the same V2 declaration after an older snapshot arrives while publish will %s", async (failure) => {
    vi.useFakeTimers();
    let rejectPublish!: (error: Error) => void;
    const requester = new AutomationCurrentConfigRequester(automationScope, {
      protocolSupport: { assignmentVersion: 4, maxSnapshotVersion: 2, nextRevision: async () => 7 },
      retryInitialDelayMs: 10, retryMaxDelayMs: 20, publishTimeoutMs: 50, random: () => 0
    });
    const publish = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPublish = reject; }))
      .mockResolvedValue(undefined);
    try {
      const connecting = requester.connect(publish);
      const failed = expect(connecting).rejects.toThrow(failure === "reject" ? "offline" : "timed out");
      await Promise.resolve();
      requester.confirm({ ...automationScope, schemaVersion: 2 });
      if (failure === "reject") rejectPublish(new Error("offline"));
      else await vi.advanceTimersByTimeAsync(50);
      await failed;
      await vi.advanceTimersByTimeAsync(110);
      // Six bounded retries on the same still-open connection, not a new identity.
      expect(publish).toHaveBeenCalledTimes(7);
      for (const call of publish.mock.calls) expect(call).toEqual(publish.mock.calls[0]);
      expect(vi.getTimerCount()).toBe(1);
    } finally { requester.disconnect(); }
  });

  it("keeps bounded declaration replay independent of product runtime ACKs, then stops on disconnect", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "automation-declaration-runtime-"));
    let revision = 6;
    const requester = new AutomationCurrentConfigRequester(automationScope, {
      protocolSupport: { assignmentVersion: 4, maxSnapshotVersion: 2, nextRevision: async () => ++revision },
      retryInitialDelayMs: 10, retryMaxDelayMs: 20, random: () => 0
    });
    try {
      const store = new FileAutomationConfigStore(join(directory, "config.json"), automationScope);
      const outbox = new AutomationConfigAckOutbox(join(directory, "acks.json"), automationScope);
      const rf = vi.fn(async () => {});
      const runtime = new AutomationRuntime({ store, scope: automationScope,
        recompute: async () => ({}), applyDesiredState: rf });
      const oldSnapshot = automationSnapshot(1, { schemaVersion: 2 } as never);
      const publish = vi.fn(async () => {});
      await requester.connect(publish);
      for (let retry = 0; retry < 6; retry++) {
        const acknowledgement = await handleAutomationConfigPayload(
          Buffer.from(JSON.stringify(oldSnapshot)), runtime, ack => outbox.enqueue(ack));
        if (acknowledgement.status === "applied" && runtime.currentSnapshot) requester.confirm(runtime.currentSnapshot);
        await vi.advanceTimersByTimeAsync(retry === 0 ? 10 : 20);
      }
      expect(publish).toHaveBeenCalledTimes(7);
      for (const call of publish.mock.calls) expect(call).toEqual(publish.mock.calls[0]);
      expect(await store.load()).toEqual(oldSnapshot);
      expect(await outbox.pending()).toHaveLength(1);
      expect((await outbox.pending())[0].acknowledgement).toMatchObject({ schemaVersion: 2, revision: 1, status: "applied" });
      expect(rf).not.toHaveBeenCalled();
      requester.disconnect();
      await vi.advanceTimersByTimeAsync(120);
      expect(publish).toHaveBeenCalledTimes(7);
      expect(vi.getTimerCount()).toBe(0);
      await requester.connect(publish);
      expect(publish.mock.calls[7]).not.toEqual(publish.mock.calls[0]);
      expect((publish.mock.calls[7] as unknown[])[1]).toMatchObject({ declarationRevision: 8 });
    } finally {
      requester.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
