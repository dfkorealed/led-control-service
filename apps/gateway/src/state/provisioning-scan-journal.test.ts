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
  vi.useRealTimers();
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

  it("does not replay a persisted terminal after application acknowledgement", async () => {
    const path = await journalPath();
    const firstPublish = vi.fn().mockResolvedValue(undefined);
    const envelope = {
      eventId: "66666666-6666-4666-8666-666666666666", sequence: 7, occurredAt: "2026-08-26T00:00:01.000Z"
    };

    const firstJournal = new ProvisioningScanJournal(path);
    await handleDurableProvisioningScan({
      adapter: { scan: vi.fn().mockResolvedValue([]) },
      journal: firstJournal,
      command,
      nextEnvelope: vi.fn().mockResolvedValue(envelope),
      publish: firstPublish
    });
    await firstJournal.acknowledgeTerminal({
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      sessionId: command.sessionId,
      scanCorrelationId: command.scanCorrelationId,
      scanAttempt: command.scanAttempt,
      ingestedAt: "2026-08-26T00:00:02.000Z"
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

  it("keeps a PUBACKed terminal pending until an exact application acknowledgement arrives", async () => {
    const journal = new ProvisioningScanJournal(await journalPath());
    await journal.begin(command);
    const terminal = {
      topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-completed`,
      payload: createProvisioningScanCompletedPayload(command, 0, {
        eventId: "66666666-6666-4666-8666-666666666666",
        sequence: 7,
        occurredAt: "2026-08-26T00:00:01.000Z"
      })
    };
    await journal.complete(command, terminal);
    const recovery = new ProvisioningScanRecoveryPublisher(journal);

    await recovery.drain(vi.fn().mockResolvedValue(undefined));
    expect(await journal.pendingTerminals()).toEqual([terminal]);

    const acknowledgement = {
      eventId: terminal.payload.eventId,
      sequence: terminal.payload.sequence,
      sessionId: terminal.payload.sessionId,
      scanCorrelationId: terminal.payload.scanCorrelationId,
      scanAttempt: terminal.payload.scanAttempt,
      ingestedAt: "2026-08-26T00:00:02.000Z"
    };
    const mismatchedAcknowledgements = [
      { ...acknowledgement, eventId: "77777777-7777-4777-8777-777777777777" },
      { ...acknowledgement, sequence: acknowledgement.sequence + 1 },
      { ...acknowledgement, sessionId: "77777777-7777-4777-8777-777777777777" },
      { ...acknowledgement, scanCorrelationId: "77777777-7777-4777-8777-777777777777" },
      { ...acknowledgement, scanAttempt: acknowledgement.scanAttempt + 1 }
    ];
    for (const mismatched of mismatchedAcknowledgements) {
      await expect(journal.acknowledgeTerminal(mismatched)).resolves.toBe(false);
    }
    expect(await journal.pendingTerminals()).toEqual([terminal]);
    await expect(journal.acknowledgeTerminal(acknowledgement)).resolves.toBe(true);
    expect(await journal.pendingTerminals()).toEqual([]);
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

  it("replays an undelivered terminal on reconnect with its original eventId and sequence and serializes drains", async () => {
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
    await vi.waitFor(async () => expect(await journal.pendingTerminals()).toHaveLength(1));
    await journal.acknowledgeTerminal({
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      sessionId: command.sessionId,
      scanCorrelationId: command.scanCorrelationId,
      scanAttempt: command.scanAttempt,
      ingestedAt: "2026-08-26T00:00:02.000Z"
    });
    client.emit("connect", { sessionPresent: true });
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("retries a terminal after an API transaction failure on the same connection and stops after the commit-coupled ACK", async () => {
    vi.useFakeTimers();
    const journal = new ProvisioningScanJournal(await journalPath());
    const recovery = new ProvisioningScanRecoveryPublisher(journal, {
      publishTimeoutMs: 1_000,
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 400
    });
    const publish = vi.fn().mockResolvedValue(undefined);

    await recovery.connect(publish);
    expect(publish).not.toHaveBeenCalled();

    await journal.begin(command);
    const terminal = await journal.complete(command, {
      topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-completed`,
      payload: createProvisioningScanCompletedPayload(command, 0, {
        eventId: "66666666-6666-4666-8666-666666666666",
        sequence: 7,
        occurredAt: "2026-08-26T00:00:01.000Z"
      })
    });
    await publish(terminal.topic, terminal.payload);
    recovery.scheduleRetry();
    expect(publish).toHaveBeenCalledTimes(1);

    // The broker accepted the first delivery, but the API transaction failed and emitted no application ACK.
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));

    await recovery.acknowledgeTerminal({
      eventId: terminal.payload.eventId,
      sequence: terminal.payload.sequence,
      sessionId: terminal.payload.sessionId,
      scanCorrelationId: terminal.payload.scanCorrelationId,
      scanAttempt: terminal.payload.scanAttempt,
      ingestedAt: "2026-08-26T00:00:02.000Z"
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(publish).toHaveBeenCalledTimes(2);
    recovery.disconnect();
  });

  it("uses bounded exponential backoff without overlapping connected drains", async () => {
    vi.useFakeTimers();
    const journal = await journalWithPendingTerminal();
    const recovery = new ProvisioningScanRecoveryPublisher(journal, {
      publishTimeoutMs: 1_000,
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 400
    });
    const publish = vi.fn().mockResolvedValue(undefined);

    const first = recovery.connect(publish);
    const concurrent = recovery.connect(publish);
    expect(concurrent).toBe(first);
    await first;
    expect(publish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(399);
    expect(publish).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(400);
    expect(publish).toHaveBeenCalledTimes(5);
    recovery.disconnect();
  });

  it("cancels a scheduled retry and active publish on close, then restarts on reconnect", async () => {
    vi.useFakeTimers();
    const journal = await journalWithPendingTerminal();
    const recovery = new ProvisioningScanRecoveryPublisher(journal, {
      publishTimeoutMs: 1_000,
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 400
    });
    const firstPublish = vi.fn().mockResolvedValue(undefined);

    await recovery.connect(firstPublish);
    recovery.disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(firstPublish).toHaveBeenCalledTimes(1);

    const stalledPublish = vi.fn(() => new Promise<void>(() => undefined));
    const stalled = recovery.connect(stalledPublish);
    await vi.waitFor(() => expect(stalledPublish).toHaveBeenCalledTimes(1));
    recovery.disconnect();
    await expect(stalled).resolves.toBeUndefined();

    const reconnectPublish = vi.fn().mockResolvedValue(undefined);
    await recovery.connect(reconnectPublish);
    expect(reconnectPublish).toHaveBeenCalledTimes(1);
    recovery.disconnect();
  });

  it("rejects a stalled drain on timeout and starts a fresh serialized drain on reconnect", async () => {
    vi.useFakeTimers();
    const journal = await journalWithPendingTerminal();
    const recovery = new ProvisioningScanRecoveryPublisher(journal, { publishTimeoutMs: 100 });
    const stalledPublish = vi.fn(() => new Promise<void>(() => undefined));

    const stalled = recovery.drain(stalledPublish);
    await vi.advanceTimersByTimeAsync(100);
    await expect(stalled).rejects.toThrow("timed out");

    let release!: () => void;
    const publish = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = recovery.drain(publish);
    const concurrent = recovery.drain(publish);
    expect(concurrent).toBe(first);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    release();
    await expect(first).resolves.toBeUndefined();
  });

  it("rejects a recovery publish timeout that reaches the 30-second scan outbox lease", async () => {
    const journal = new ProvisioningScanJournal(await journalPath());

    expect(() => new ProvisioningScanRecoveryPublisher(journal, { publishTimeoutMs: 30_000 }))
      .toThrow("invalid provisioning scan recovery publish timeout");
  });

  it("cancels a stalled drain on disconnect so reconnect uses a fresh drain", async () => {
    const journal = await journalWithPendingTerminal();
    const recovery = new ProvisioningScanRecoveryPublisher(journal, { publishTimeoutMs: 10_000 });
    const stalled = recovery.drain(vi.fn(() => new Promise<void>(() => undefined)));

    recovery.disconnect();
    await expect(stalled).rejects.toThrow("disconnected");

    const publish = vi.fn().mockResolvedValue(undefined);
    await expect(recovery.drain(publish)).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
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

  it("fails closed when an undelivered terminal consumes the configured capacity", async () => {
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

    await expect(journal.begin(nextCommand))
      .rejects.toThrow("provisioning scan journal exceeds the supported limit (1)");
  });

  it("retains undelivered terminals past 24 hours and prunes only delivered terminals", async () => {
    let now = new Date("2026-08-26T00:00:00.000Z");
    const journal = new ProvisioningScanJournal(await journalPath(), { now: () => now, retentionMs: 24 * 60 * 60 * 1000 });
    await journal.begin(command);
    const terminal = {
      topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-completed`,
      payload: createProvisioningScanCompletedPayload(command, 0, {
        eventId: "66666666-6666-4666-8666-666666666666",
        sequence: 7,
        occurredAt: "2026-08-26T00:00:01.000Z"
      })
    };
    await journal.complete(command, terminal);

    now = new Date("2026-08-27T00:00:00.001Z");
    expect(await journal.pendingTerminals()).toEqual([terminal]);
    await journal.acknowledgeTerminal({
      eventId: terminal.payload.eventId,
      sequence: terminal.payload.sequence,
      sessionId: terminal.payload.sessionId,
      scanCorrelationId: terminal.payload.scanCorrelationId,
      scanAttempt: terminal.payload.scanAttempt,
      ingestedAt: now.toISOString()
    });
    now = new Date("2026-08-28T00:00:00.002Z");

    const nextCommand = { ...command, scanCorrelationId: "77777777-7777-4777-8777-777777777777", scanAttempt: 2 };
    await expect(journal.begin(nextCommand)).resolves.toEqual({ kind: "new" });
  });
});

async function journalWithPendingTerminal() {
  const journal = new ProvisioningScanJournal(await journalPath());
  await journal.begin(command);
  await journal.complete(command, {
    topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-completed`,
    payload: createProvisioningScanCompletedPayload(command, 0, {
      eventId: "66666666-6666-4666-8666-666666666666",
      sequence: 7,
      occurredAt: "2026-08-26T00:00:01.000Z"
    })
  });
  return journal;
}

async function journalPath() {
  const directory = await mkdtemp(join(tmpdir(), "provisioning-scan-journal-"));
  directories.push(directory);
  return join(directory, "scan-journal.json");
}
