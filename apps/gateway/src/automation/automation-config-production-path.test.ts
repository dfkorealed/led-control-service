import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPublishPacket } from "mqtt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAutomationConfigPayload } from "../gateway";
import { GatewayMqttRuntime } from "../runtime/gateway-mqtt-runtime";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { AutomationConfigAckOutbox, AutomationConfigAckPublisher } from "./automation-config-ack-outbox";
import { FileAutomationConfigStore } from "./automation-config-store";
import { AutomationRuntime } from "./automation-runtime";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";

const directories: string[] = [];
const configTopic = `sites/${automationScope.siteId}/gateways/${automationScope.gatewayId}/commands/automation/config-sync`;

class ProductionLikeMqttClient extends EventEmitter {
  connected = false;
  handleMessage(_packet: IPublishPacket, callback: (error?: Error) => void) { callback(); }
  readonly end = vi.fn((_force?: boolean, callback?: (error?: Error) => void) => callback?.());
  readonly publish = vi.fn((_topic: string, _payload: string, _options?: unknown, callback?: (error?: Error) => void) => callback?.());
  readonly reconnect = vi.fn();
  readonly subscribe = vi.fn();
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("automation config production path", () => {
  it("serially rejects every failure mode without restarting MQTT, heartbeat, or BLE mesh", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "automation-production-path-"));
    directories.push(directory);
    const snapshotPath = join(directory, "snapshot.json");
    const outboxPath = join(directory, "acks.json");
    let failNextStore = false;
    const store = new FileAutomationConfigStore(snapshotPath, automationScope, async (path, value) => {
      if (failNextStore) {
        failNextStore = false;
        throw new Error("injected snapshot store failure");
      }
      await writeJsonAtomic(path, value);
    });
    const applyDesiredState = vi.fn(async (next: Readonly<Record<string, number>>) => {
      if (next["fixture-1"] === 70) throw new Error("injected BLE apply failure");
    });
    const automation = new AutomationRuntime({
      store,
      scope: automationScope,
      now: () => new Date("2026-08-30T01:02:03.000Z"),
      recompute: async (snapshot) => {
        if (snapshot.revision === 6) throw new Error("injected recompute failure");
        return { "fixture-1": snapshot.revision === 7 ? 70 : 40 };
      },
      applyDesiredState
    });
    await automation.initialize();
    const outbox = new AutomationConfigAckOutbox(outboxPath, automationScope);
    await outbox.initialize();
    const publisher = new AutomationConfigAckPublisher(outbox, automationScope);
    const dimmingHandler = vi.fn();
    const heartbeat = vi.fn();
    const mqtt = new ProductionLikeMqttClient();
    const handler = (payload: Buffer) => handleAutomationConfigPayload(payload, automation, async (acknowledgement) => {
      await outbox.enqueue(acknowledgement);
      await publisher.wake();
    }, () => new Date("2026-08-30T01:02:03.000Z"));
    const runtime = new GatewayMqttRuntime({
      client: mqtt as never,
      heartbeatMs: 100,
      subscribe: vi.fn(),
      publishHeartbeat: heartbeat,
      topicHandlers: { [configTopic]: handler, "commands/dimming": dimmingHandler },
      deferredPubackTopics: [configTopic],
      onMessageError: vi.fn()
    });
    runtime.start();
    mqtt.emit("connect", { sessionPresent: false });

    const current = automationSnapshot(4);
    const invalid = { ...automationSnapshot(5), timeZone: "invalid-zone" };
    const old = automationSnapshot(3);
    const conflict = automationSnapshot(4, { generatedAt: "2026-08-30T00:00:01.000Z" });
    await deliver(mqtt, current, 1);
    await deliver(mqtt, invalid, 2);
    await deliver(mqtt, old, 3);
    await deliver(mqtt, conflict, 4);
    failNextStore = true;
    await deliver(mqtt, automationSnapshot(5), 5);
    await deliver(mqtt, automationSnapshot(6), 6);
    await deliver(mqtt, automationSnapshot(7), 7);

    expect(automation.currentRevision).toBe(4);
    expect(await new FileAutomationConfigStore(snapshotPath, automationScope).load()).toEqual(current);
    expect((await outbox.pending()).map(({ revision, payloadHash, status, errorCode }) =>
      ({ revision, payloadHash, status, errorCode }))).toEqual([
      { revision: 4, payloadHash: current.payloadHash, status: "applied", errorCode: null },
      { revision: 5, payloadHash: invalid.payloadHash, status: "rejected", errorCode: "snapshot_invalid" },
      { revision: 3, payloadHash: old.payloadHash, status: "rejected", errorCode: "snapshot_old_revision" },
      { revision: 4, payloadHash: conflict.payloadHash, status: "rejected", errorCode: "snapshot_revision_conflict" },
      { revision: 5, payloadHash: automationSnapshot(5).payloadHash, status: "rejected", errorCode: "snapshot_store_failed" },
      { revision: 6, payloadHash: automationSnapshot(6).payloadHash, status: "rejected", errorCode: "snapshot_recompute_failed" },
      { revision: 7, payloadHash: automationSnapshot(7).payloadHash, status: "rejected", errorCode: "snapshot_recompute_failed" }
    ]);
    expect(applyDesiredState).toHaveBeenCalledTimes(2);
    expect(mqtt.end).not.toHaveBeenCalled();
    mqtt.emit("message", "commands/dimming", Buffer.from("{}"), { cmd: "publish", qos: 1, messageId: 8 });
    expect(dimmingHandler).toHaveBeenCalledTimes(1);
    const heartbeatCount = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(heartbeat.mock.calls.length).toBeGreaterThan(heartbeatCount);

    publisher.disconnect();
    await runtime.stop();
  });

  it("withholds rejected ACK and broker PUBACK for an uncertain commit, then converges after restart redelivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automation-uncertain-commit-"));
    directories.push(directory);
    const snapshotPath = join(directory, "snapshot.json");
    const outboxPath = join(directory, "acks.json");
    const current = automationSnapshot(4);
    const incoming = automationSnapshot(5);
    await new FileAutomationConfigStore(snapshotPath, automationScope).apply(current);
    let syncAttempts = 0;
    const syncParentDirectory = async (_parent: string) => {
      syncAttempts += 1;
      throw new Error(`injected parent fsync failure ${syncAttempts}`);
    };
    const uncertainStore = new FileAutomationConfigStore(
      snapshotPath,
      automationScope,
      (path, value) => writeJsonAtomic(path, value, { syncParentDirectory })
    );
    const automation = createAutomationRuntime(uncertainStore);
    await automation.initialize();
    const outbox = new AutomationConfigAckOutbox(outboxPath, automationScope);
    await outbox.initialize();
    const mqtt = new ProductionLikeMqttClient();
    const onMessageError = vi.fn();
    const runtime = createMqttRuntime(mqtt, automation, outbox, onMessageError);
    runtime.start();
    const packet = { cmd: "publish", qos: 1, messageId: 21 } as IPublishPacket;
    let brokerPubackCompleted = false;
    let boundaryError: Error | undefined;

    mqtt.emit("message", configTopic, Buffer.from(JSON.stringify(incoming)), packet);
    mqtt.handleMessage(packet, (error) => {
      boundaryError = error;
      if (!error) brokerPubackCompleted = true;
    });
    await vi.waitFor(() => expect(onMessageError).toHaveBeenCalledTimes(1));

    expect(boundaryError).toMatchObject({ code: "snapshot_commit_uncertain", acknowledgeable: false });
    expect(syncAttempts).toBe(4);
    expect(brokerPubackCompleted).toBe(false);
    expect(await outbox.pending()).toEqual([]);
    expect(automation.currentRevision).toBe(4);
    expect(await new FileAutomationConfigStore(snapshotPath, automationScope).load()).toEqual(current);
    await runtime.stop();

    const restartedAutomation = createAutomationRuntime(new FileAutomationConfigStore(snapshotPath, automationScope));
    await restartedAutomation.initialize();
    expect(restartedAutomation.currentRevision).toBe(4);
    const restartedMqtt = new ProductionLikeMqttClient();
    const restartedRuntime = createMqttRuntime(restartedMqtt, restartedAutomation, outbox, vi.fn());
    restartedRuntime.start();

    await deliver(restartedMqtt, incoming, 22);

    expect(restartedAutomation.currentRevision).toBe(5);
    expect(await new FileAutomationConfigStore(snapshotPath, automationScope).load()).toEqual(incoming);
    expect(await outbox.pending()).toEqual([
      expect.objectContaining({
        revision: incoming.revision,
        payloadHash: incoming.payloadHash,
        status: "applied",
        errorCode: null
      })
    ]);
    await restartedRuntime.stop();
  });
});

function createAutomationRuntime(store: FileAutomationConfigStore) {
  return new AutomationRuntime({
    store,
    scope: automationScope,
    now: () => new Date("2026-08-30T01:02:03.000Z"),
    recompute: async () => ({}),
    applyDesiredState: async () => undefined
  });
}

function createMqttRuntime(
  mqtt: ProductionLikeMqttClient,
  automation: AutomationRuntime,
  outbox: AutomationConfigAckOutbox,
  onMessageError: ReturnType<typeof vi.fn>
) {
  return new GatewayMqttRuntime({
    client: mqtt as never,
    heartbeatMs: 10_000,
    subscribe: vi.fn(),
    publishHeartbeat: vi.fn(),
    topicHandlers: {
      [configTopic]: (payload) => handleAutomationConfigPayload(
        payload,
        automation,
        (acknowledgement) => outbox.enqueue(acknowledgement)
      )
    },
    deferredPubackTopics: [configTopic],
    onMessageError
  });
}

async function deliver(client: ProductionLikeMqttClient, value: unknown, messageId: number) {
  const packet = { cmd: "publish", qos: 1, messageId } as IPublishPacket;
  client.emit("message", configTopic, Buffer.from(JSON.stringify(value)), packet);
  await new Promise<void>((resolve, reject) => {
    client.handleMessage(packet, (error) => error ? reject(error) : resolve());
  });
}
