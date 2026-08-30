import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutomationConfigAppliedV1 } from "@led-control/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationConfigAckOutbox, AutomationConfigAckPublisher } from "./automation-config-ack-outbox";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AutomationConfigAckOutbox", () => {
  it("recovers and republishes an exact ACK after publish failure and process restart", async () => {
    vi.useFakeTimers();
    const path = await outboxPath();
    const snapshot = automationSnapshot(4);
    const acknowledgement = ack(snapshot);
    const firstOutbox = new AutomationConfigAckOutbox(path, automationScope);
    await firstOutbox.initialize();
    await firstOutbox.enqueue(acknowledgement);
    const failedPublish = vi.fn().mockRejectedValue(new Error("broker unavailable"));
    const firstPublisher = new AutomationConfigAckPublisher(firstOutbox, automationScope, { retryInitialDelayMs: 10 });
    await expect(firstPublisher.connect(failedPublish)).rejects.toThrow("broker unavailable");
    firstPublisher.disconnect();

    const restartedOutbox = new AutomationConfigAckOutbox(path, automationScope);
    await restartedOutbox.initialize();
    const successfulPublish = vi.fn().mockResolvedValue(undefined);
    const restartedPublisher = new AutomationConfigAckPublisher(restartedOutbox, automationScope, { retryInitialDelayMs: 10 });
    await restartedPublisher.connect(successfulPublish);

    expect(successfulPublish).toHaveBeenCalledWith(
      `sites/${automationScope.siteId}/gateways/${automationScope.gatewayId}/events/automation/config-applied`,
      acknowledgement
    );
    expect(await restartedOutbox.pending()).toEqual([]);
    restartedPublisher.disconnect();
  });

  it("deduplicates an unreported exact result without changing its timestamp", async () => {
    const path = await outboxPath();
    const snapshot = automationSnapshot(4);
    const outbox = new AutomationConfigAckOutbox(path, automationScope);
    await outbox.initialize();
    const first = ack(snapshot);
    await outbox.enqueue(first);
    await outbox.enqueue({ ...first, appliedAt: "2026-08-30T09:09:09.000Z" });

    expect(await outbox.pending()).toEqual([first]);
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

async function outboxPath() {
  const directory = await mkdtemp(join(tmpdir(), "automation-config-ack-outbox-"));
  directories.push(directory);
  return join(directory, "automation-config-acks.json");
}
