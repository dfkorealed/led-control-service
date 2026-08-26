import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProvisioningScanRecoveryPublisher,
  createProvisioningScanCompletedPayload,
  createProvisioningScanFailedPayload,
  handleDurableProvisioningScan
} from "../gateway";
import { GatewayMqttRuntime } from "../runtime/gateway-mqtt-runtime";
import { ProvisioningScanJournal } from "./provisioning-scan-journal";

const directories: string[] = [];
const command = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "33333333-3333-4333-8333-333333333333",
  floorId: "44444444-4444-4444-8444-444444444444",
  scanCorrelationId: "55555555-5555-4555-8555-555555555555",
  scanAttempt: 1,
  requestedAt: "2026-08-26T00:00:00.000Z"
};

class FakeMqttClient extends EventEmitter {
  readonly end = vi.fn((_force?: boolean, callback?: (error?: Error) => void) => callback?.());
  readonly publish = vi.fn((_topic: string, _payload: string, _options?: unknown, callback?: (error?: Error) => void) => callback?.());
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProvisioningScanJournal", () => {
  it("does not start a second scanner for a duplicate running scan-start", async () => {
    const journal = new ProvisioningScanJournal(await journalPath());
    let finishScan: (nodes: []) => void = () => undefined;
    const scanner = { scan: vi.fn(() => new Promise<[]>(resolve => { finishScan = resolve; })) };
    const publish = vi.fn().mockResolvedValue(undefined);
    const nextEnvelope = vi.fn().mockResolvedValue({
      eventId: "66666666-6666-4666-8666-666666666666", sequence: 1, occurredAt: "2026-08-26T00:00:01.000Z"
    });

    const first = handleDurableProvisioningScan({ adapter: scanner, journal, command, nextEnvelope, publish });
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledTimes(1));
    await handleDurableProvisioningScan({ adapter: scanner, journal, command, nextEnvelope, publish });

    expect(scanner.scan).toHaveBeenCalledTimes(1);
    finishScan([]);
    await first;
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not replay a persisted terminal after a successful delivery", async () => {
    const path = await journalPath();
    const firstPublish = vi.fn().mockResolvedValue(undefined);
    const envelope = {
      eventId: "66666666-6666-4666-8666-666666666666", sequence: 7, occurredAt: "2026-08-26T00:00:01.000Z"
    };

    await handleDurableProvisioningScan({
      adapter: { scan: vi.fn().mockResolvedValue([]) },
      journal: new ProvisioningScanJournal(path),
      command,
      nextEnvelope: vi.fn().mockResolvedValue(envelope),
      publish: firstPublish
    });

    const replayPublish = vi.fn().mockResolvedValue(undefined);
    const replayScanner = { scan: vi.fn() };
    await handleDurableProvisioningScan({
      adapter: replayScanner,
      journal: new ProvisioningScanJournal(path),
      command,
      nextEnvelope: vi.fn(),
      publish: replayPublish
    });

    expect(replayScanner.scan).not.toHaveBeenCalled();
    expect(replayPublish).not.toHaveBeenCalled();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("converts a persisted running scan before connection and publishes its sanitized failure only when MQTT is ready", async () => {
    const path = await journalPath();
    await new ProvisioningScanJournal(path).begin(command);
    const journal = new ProvisioningScanJournal(path);
    const recovery = new ProvisioningScanRecoveryPublisher(journal);
    const publish = vi.fn().mockResolvedValue(undefined);

    await journal.initialize();
    await recovery.prepare(async (interrupted) => ({
      topic: `sites/${interrupted.siteId}/gateways/${interrupted.gatewayId}/events/provisioning/scan-failed`,
      payload: createProvisioningScanFailedPayload(interrupted, new Error("gateway scan interrupted"), {
        eventId: "66666666-6666-4666-8666-666666666666",
        sequence: 9,
        occurredAt: "2026-08-26T00:00:01.000Z"
      })
    }));

    expect(publish).not.toHaveBeenCalled();

    const client = new FakeMqttClient();
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 10_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: {},
      onMessageError: vi.fn(),
      onConnect: () => recovery.drain(publish)
    });
    runtime.start();
    expect(publish).not.toHaveBeenCalled();

    client.emit("connect", { sessionPresent: false });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish).toHaveBeenCalledWith(
      `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-failed`,
      expect.objectContaining({
        eventId: "66666666-6666-4666-8666-666666666666",
        sequence: 9,
        code: "scan_runtime_failed",
        message: "조명 검색 중 문제가 발생했습니다."
      })
    );
    await runtime.stop();
  });

  it("replays an undelivered terminal on reconnect with its original eventId and sequence, serializes drains, and marks the success", async () => {
    const path = await journalPath();
    const first = new ProvisioningScanJournal(path);
    await first.begin(command);
    const envelope = {
      eventId: "66666666-6666-4666-8666-666666666666", sequence: 7, occurredAt: "2026-08-26T00:00:01.000Z"
    };
    await first.complete(command, {
      topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-completed`,
      payload: createProvisioningScanCompletedPayload(command, 0, envelope)
    });

    const journal = new ProvisioningScanJournal(path);
    const recovery = new ProvisioningScanRecoveryPublisher(journal);
    await journal.initialize();
    let release!: () => void;
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const client = new FakeMqttClient();
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 10_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: {},
      onMessageError: vi.fn(),
      onRuntimeError: vi.fn(),
      onConnect: () => recovery.drain(publish)
    });
    runtime.start();
    client.emit("connect", { sessionPresent: false });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));

    client.emit("connect", { sessionPresent: true });
    client.emit("connect", { sessionPresent: true });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    expect(publish).toHaveBeenCalledWith(
      `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-completed`,
      expect.objectContaining({ eventId: envelope.eventId, sequence: envelope.sequence, acceptedNodeCount: 0 })
    );

    release();
    await vi.waitFor(async () => expect(await journal.pendingTerminals()).toEqual([]));
    client.emit("connect", { sessionPresent: true });
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("converges an interrupted running scan to one sanitized terminal without scanning after restart", async () => {
    const path = await journalPath();
    const interrupted = new ProvisioningScanJournal(path);
    await interrupted.begin(command);
    const scanner = { scan: vi.fn() };
    const publish = vi.fn().mockResolvedValue(undefined);

    await handleDurableProvisioningScan({
      adapter: scanner,
      journal: new ProvisioningScanJournal(path),
      command,
      nextEnvelope: vi.fn().mockResolvedValue({
        eventId: "66666666-6666-4666-8666-666666666666", sequence: 9, occurredAt: "2026-08-26T00:00:01.000Z"
      }),
      publish
    });

    expect(scanner.scan).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-failed`,
      expect.objectContaining({ code: "scan_runtime_failed", message: "조명 검색 중 문제가 발생했습니다." })
    );
  });

  it("fails closed before scanner execution when the durable journal is corrupt", async () => {
    const path = await journalPath();
    await writeFile(path, "{not-json", "utf8");
    await chmod(path, 0o600);
    const scanner = { scan: vi.fn() };

    await expect(handleDurableProvisioningScan({
      adapter: scanner,
      journal: new ProvisioningScanJournal(path),
      command,
      nextEnvelope: vi.fn(),
      publish: vi.fn()
    })).rejects.toThrow("invalid provisioning scan journal");

    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it("retains only the configured number of terminal records while never evicting a running scan", async () => {
    const path = await journalPath();
    const journal = new ProvisioningScanJournal(path, { maxRecords: 1 });
    const first = await journal.begin(command);
    expect(first.kind).toBe("new");
    const { floorId: _floorId, requestedAt: _requestedAt, ...terminalScope } = command;
    await journal.complete(command, {
      topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-completed`,
      payload: {
        ...terminalScope,
        eventId: "66666666-6666-4666-8666-666666666666",
        sequence: 1,
        occurredAt: "2026-08-26T00:00:01.000Z",
        acceptedNodeCount: 0
      }
    });
    const nextCommand = { ...command, scanCorrelationId: "77777777-7777-4777-8777-777777777777", scanAttempt: 2 };

    await expect(journal.begin(nextCommand)).resolves.toEqual({ kind: "new" });
    await expect(journal.begin({ ...nextCommand, scanCorrelationId: "88888888-8888-4888-8888-888888888888", scanAttempt: 3 }))
      .rejects.toThrow("provisioning scan journal exceeds the supported limit (1)");
  });
});

async function journalPath() {
  const directory = await mkdtemp(join(tmpdir(), "provisioning-scan-journal-"));
  directories.push(directory);
  return join(directory, "scan-journal.json");
}
