import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationConfigAppliedReceiptV1Schema,
  type AutomationConfigAppliedDeliveryV1,
  type AutomationConfigAppliedReceiptV1,
  type AutomationConfigAppliedV1
} from "@led-control/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationConfigAckOutbox, AutomationConfigAckPublisher } from "./automation-config-ack-outbox";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";
import { writeJsonAtomic } from "../mesh/mesh-store-file";

const directories: string[] = [];
const acknowledgementId = "99999999-9999-4999-8999-999999999999";

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AutomationConfigAckOutbox", () => {
  it("retains and republishes an exact ACK across broker PUBACK and process restart until its application receipt", async () => {
    const path = await outboxPath();
    const acknowledgement = ack(automationSnapshot(4));
    const firstOutbox = new AutomationConfigAckOutbox(
      path,
      automationScope,
      writeJsonAtomic,
      () => acknowledgementId
    );
    await firstOutbox.initialize();
    const delivery = await firstOutbox.enqueue(acknowledgement);
    const firstPublish = vi.fn().mockResolvedValue(undefined);
    const firstPublisher = new AutomationConfigAckPublisher(firstOutbox, automationScope);

    await firstPublisher.connect(firstPublish);

    expect(firstPublish).toHaveBeenCalledWith(
      `sites/${automationScope.siteId}/gateways/${automationScope.gatewayId}/events/automation/config-applied`,
      delivery
    );
    expect(await firstOutbox.pending()).toEqual([delivery]);
    firstPublisher.disconnect();

    const restartedOutbox = new AutomationConfigAckOutbox(path, automationScope);
    await restartedOutbox.initialize();
    const restartedPublish = vi.fn().mockResolvedValue(undefined);
    const restartedPublisher = new AutomationConfigAckPublisher(restartedOutbox, automationScope);
    await restartedPublisher.connect(restartedPublish);

    expect(restartedPublish).toHaveBeenCalledWith(
      `sites/${automationScope.siteId}/gateways/${automationScope.gatewayId}/events/automation/config-applied`,
      delivery
    );
    expect(await restartedOutbox.acknowledge(receipt(delivery))).toBe("deleted");
    expect(await restartedOutbox.pending()).toEqual([]);
    restartedPublisher.disconnect();
  });

  it("rejects wrong, old, and altered receipts without deleting the current ACK", async () => {
    const path = await outboxPath();
    const outbox = new AutomationConfigAckOutbox(path, automationScope, writeJsonAtomic, () => acknowledgementId);
    await outbox.initialize();
    const delivery = await outbox.enqueue(ack(automationSnapshot(4)));

    expect(await outbox.acknowledge({
      ...receipt(delivery),
      acknowledgementId: "88888888-8888-4888-8888-888888888888"
    })).toBe("missing");
    expect(await outbox.acknowledge({
      ...receipt(delivery),
      acknowledgement: { ...delivery.acknowledgement, revision: 3 }
    })).toBe("conflict");
    await expect(outbox.acknowledge({
      ...receipt(delivery),
      siteId: "77777777-7777-4777-8777-777777777777"
    })).rejects.toThrow("automation config receipt scope mismatch");
    expect(await outbox.pending()).toEqual([delivery]);
  });

  it("retries successful broker publishes with bounded exponential delays while the receipt is missing", async () => {
    vi.useFakeTimers();
    const path = await outboxPath();
    const outbox = new AutomationConfigAckOutbox(path, automationScope, writeJsonAtomic, () => acknowledgementId);
    await outbox.initialize();
    await outbox.enqueue(ack(automationSnapshot(4)));
    const publish = vi.fn().mockResolvedValue(undefined);
    const publisher = new AutomationConfigAckPublisher(outbox, automationScope, {
      retryInitialDelayMs: 10,
      retryMaxDelayMs: 20
    });

    await publisher.connect(publish);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
    publisher.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates an unreceipted exact result without changing its identity or timestamp", async () => {
    const path = await outboxPath();
    const outbox = new AutomationConfigAckOutbox(path, automationScope, writeJsonAtomic, () => acknowledgementId);
    await outbox.initialize();
    const first = ack(automationSnapshot(4));
    const delivery = await outbox.enqueue(first);
    await outbox.enqueue({ ...first, appliedAt: "2026-08-30T09:09:09.000Z" });

    expect(await outbox.pending()).toEqual([delivery]);
  });

  it("migrates a version 1 pending ACK without losing it", async () => {
    const path = await outboxPath();
    const acknowledgement = ack(automationSnapshot(4));
    await writeJsonAtomic(path, { version: 1, scope: automationScope, records: [acknowledgement] });
    const outbox = new AutomationConfigAckOutbox(
      path,
      automationScope,
      writeJsonAtomic,
      () => acknowledgementId
    );

    await outbox.initialize();

    expect(await outbox.pending()).toEqual([{
      schemaVersion: 1,
      acknowledgementId,
      ...automationScope,
      acknowledgement
    }]);
  });

  it("keeps memory and disk aligned after a post-rename parent fsync fault", async () => {
    const path = await outboxPath();
    let syncAttempts = 0;
    const syncParentDirectory = async (directory: string) => {
      syncAttempts += 1;
      if (syncAttempts === 2) throw new Error("injected outbox parent fsync failure");
      const handle = await open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    };
    const outbox = new AutomationConfigAckOutbox(
      path,
      automationScope,
      (target, value) => writeJsonAtomic(target, value, { syncParentDirectory }),
      () => acknowledgementId
    );
    const acknowledgement = ack(automationSnapshot(4));
    await outbox.initialize();

    const delivery = await outbox.enqueue(acknowledgement);

    expect(syncAttempts).toBe(3);
    expect(await outbox.pending()).toEqual([delivery]);
    const restarted = new AutomationConfigAckOutbox(path, automationScope);
    await restarted.initialize();
    expect(await restarted.pending()).toEqual([delivery]);
  });
});

function ack(snapshot: ReturnType<typeof automationSnapshot>): AutomationConfigAppliedV1 {
  return {
    schemaVersion: 1,
    gatewayId: snapshot.gatewayId,
    revision: snapshot.revision,
    payloadHash: snapshot.payloadHash,
    status: "applied",
    errorCode: null,
    appliedAt: "2026-08-30T01:02:03.000Z"
  };
}

function receipt(delivery: AutomationConfigAppliedDeliveryV1): AutomationConfigAppliedReceiptV1 {
  return automationConfigAppliedReceiptV1Schema.parse({
    ...delivery,
    ingestedAt: "2026-08-30T01:02:04.000Z"
  }) as AutomationConfigAppliedReceiptV1;
}

async function outboxPath() {
  const directory = await mkdtemp(join(tmpdir(), "automation-config-ack-outbox-"));
  directories.push(directory);
  return join(directory, "automation-config-acks.json");
}
