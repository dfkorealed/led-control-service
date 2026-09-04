import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProvisioningDeviceCommandV2, ProvisioningDeviceTerminalV2 } from "@led-control/shared";
import {
  ProvisioningDeviceJournal,
  ProvisioningDeviceReplayPublisher,
  handleDurableProvisioningDevice
} from "./provisioning-device-journal";

const directories: string[] = [];
const command: ProvisioningDeviceCommandV2 = {
  commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "33333333-3333-4333-8333-333333333333",
  nodeId: "44444444-4444-4444-8444-444444444444",
  deviceUuid: "00112233445566778899aabbccddeeff",
  meshAddress: "0x0101",
  requestedAt: "2026-09-03T00:00:00.000Z"
};
const envelope = {
  eventId: "55555555-5555-4555-8555-555555555555",
  sequence: 7,
  occurredAt: "2026-09-03T00:00:01.000Z"
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProvisioningDeviceJournal", () => {
  it("durably accepts before RF and suppresses an exact duplicate while RF is running", async () => {
    const path = await journalPath();
    const journal = new ProvisioningDeviceJournal(path);
    let releaseRf!: () => void;
    const execute = vi.fn(async () => {
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted.records[command.commandId].state).toBe("accepted");
      await new Promise<void>((resolve) => { releaseRf = resolve; });
      return { firmwareVersion: "1.0.0", rssi: -55, hopCount: 1 };
    });
    const onTerminalPersisted = vi.fn();

    const first = handleDurableProvisioningDevice({ journal, command, execute, nextEnvelope: async () => envelope, onTerminalPersisted });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await handleDurableProvisioningDevice({ journal, command, execute, nextEnvelope: async () => envelope, onTerminalPersisted });

    expect(execute).toHaveBeenCalledTimes(1);
    releaseRf();
    await first;
    expect(onTerminalPersisted).toHaveBeenCalledTimes(1);
  });

  it("fails closed before RF when a reused commandId changes any command identity", async () => {
    const journal = new ProvisioningDeviceJournal(await journalPath());
    await journal.accept(command);
    const execute = vi.fn();

    await expect(handleDurableProvisioningDevice({
      journal,
      command: { ...command, deviceUuid: "ffeeddccbbaa99887766554433221100" },
      execute,
      nextEnvelope: async () => envelope
    })).rejects.toThrow("provisioning device command identity conflict");

    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute RF when the durable accept commit fails", async () => {
    const journal = new ProvisioningDeviceJournal(await journalPath(), {
      write: vi.fn().mockRejectedValue(new Error("disk full"))
    });
    const execute = vi.fn();

    await expect(handleDurableProvisioningDevice({
      journal,
      command,
      execute,
      nextEnvelope: async () => envelope
    })).rejects.toThrow("disk full");

    expect(execute).not.toHaveBeenCalled();
  });

  it("converges an accepted-only restart to one outcome-unknown terminal without repeating RF", async () => {
    const path = await journalPath();
    await new ProvisioningDeviceJournal(path).accept(command);
    const restarted = new ProvisioningDeviceJournal(path);

    await restarted.recoverAccepted(async (accepted) => {
      const { requestedAt: _requestedAt, ...identity } = accepted;
      return {
        topic: `sites/${accepted.siteId}/gateways/${accepted.gatewayId}/events/provisioning/device-terminal`,
        payload: {
          ...identity,
          ...envelope,
          status: "failed",
          errorCode: "provisioning_outcome_unknown",
          errorMessage: "Gateway restarted before the provisioning result was durably recorded."
        }
      };
    });

    const execute = vi.fn();
    const onTerminalPersisted = vi.fn();
    await handleDurableProvisioningDevice({
      journal: restarted,
      command,
      execute,
      nextEnvelope: vi.fn(),
      onTerminalPersisted
    });

    expect(execute).not.toHaveBeenCalled();
    expect(onTerminalPersisted).toHaveBeenCalledTimes(1);
    await expect(restarted.pendingTerminals()).resolves.toEqual([
      expect.objectContaining({ payload: expect.objectContaining({
        commandId: command.commandId,
        eventId: envelope.eventId,
        sequence: envelope.sequence,
        status: "failed",
        errorCode: "provisioning_outcome_unknown"
      }) })
    ]);
  });

  it("stores a terminal atomically before publish and reuses it for exact duplicates", async () => {
    const path = await journalPath();
    const journal = new ProvisioningDeviceJournal(path);
    let releasePublish!: () => void;
    const firstPublishPending = new Promise<void>((resolve) => { releasePublish = resolve; });
    let publishCount = 0;
    const publish = vi.fn(async (_topic: string, terminal: ProvisioningDeviceTerminalV2) => {
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted.records[command.commandId].state).toBe("terminal");
      expect(persisted.records[command.commandId].terminal.payload.eventId).toBe(terminal.eventId);
      publishCount += 1;
      if (publishCount === 1) await firstPublishPending;
    });
    const execute = vi.fn().mockResolvedValue({ firmwareVersion: "1.0.0" });
    const replay = new ProvisioningDeviceReplayPublisher(journal);
    await replay.connect(publish);
    let wake: Promise<void> | undefined;
    const onTerminalPersisted = () => { wake = replay.wake(); };

    const first = handleDurableProvisioningDevice({ journal, command, execute, nextEnvelope: async () => envelope, onTerminalPersisted });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    releasePublish();
    await first;
    await wake;
    await handleDurableProvisioningDevice({ journal, command, execute, nextEnvelope: vi.fn(), onTerminalPersisted });
    await wake;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]).toEqual(publish.mock.calls[0]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    replay.disconnect();
  });

  it("gives a connected replay publisher sole ownership of a newly persisted terminal", async () => {
    const journal = new ProvisioningDeviceJournal(await journalPath());
    const replay = new ProvisioningDeviceReplayPublisher(journal, {
      publishTimeoutMs: 1_000,
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 400
    });
    let release!: () => void;
    const publish = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const legacyDirectPublish = vi.fn(() => new Promise<void>(() => undefined));
    await replay.connect(publish);

    const legacyInput = {
      journal,
      command,
      execute: vi.fn().mockResolvedValue({ firmwareVersion: "1.0.0" }),
      nextEnvelope: async () => envelope,
      onTerminalPersisted: () => replay.scheduleRetry(),
      publish: legacyDirectPublish
    };
    const handling = handleDurableProvisioningDevice(legacyInput);
    // The journal performs real fsync operations, so wall-clock races become
    // flaky under the full parallel suite. Awaiting here still proves that the
    // unresolved publish promise is not part of the command handler boundary.
    await expect(handling).resolves.toBeUndefined();
    expect(legacyDirectPublish).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish).toHaveBeenCalledWith(completedTerminal().topic, expect.objectContaining({
      commandId: command.commandId,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      status: "completed",
      firmwareVersion: "1.0.0"
    }));

    release();
    replay.disconnect();
  });

  it("bounds shutdown when the sole terminal publisher never calls back", async () => {
    vi.useFakeTimers();
    const journal = new ProvisioningDeviceJournal(await journalPath());
    await journal.accept(command);
    await journal.complete(command, completedTerminal());
    const replay = new ProvisioningDeviceReplayPublisher(journal, {
      publishTimeoutMs: 100,
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 400
    });
    const publish = vi.fn(() => new Promise<void>(() => undefined));
    const connecting = replay.connect(publish);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(1);

    const stopping = replay.stopAndDrain();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await connecting;
    await expect(stopping).resolves.toBeUndefined();
  });

  it("keeps a PUBACKed terminal across restart until the exact application ACK removes it", async () => {
    const path = await journalPath();
    const journal = new ProvisioningDeviceJournal(path);
    await journal.accept(command);
    const terminal = completedTerminal();
    await journal.complete(command, terminal);
    await new ProvisioningDeviceReplayPublisher(journal).drain(vi.fn().mockResolvedValue(undefined));

    const restarted = new ProvisioningDeviceJournal(path);
    expect(await restarted.pendingTerminals()).toEqual([terminal]);
    const acknowledgement = {
      commandId: command.commandId,
      sessionId: command.sessionId,
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: command.meshAddress,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      ingestedAt: "2026-09-03T00:00:02.000Z"
    };
    const mismatches = [
      { ...acknowledgement, commandId: "66666666-6666-4666-8666-666666666666" },
      { ...acknowledgement, sessionId: "66666666-6666-4666-8666-666666666666" },
      { ...acknowledgement, siteId: "66666666-6666-4666-8666-666666666666" },
      { ...acknowledgement, gatewayId: "66666666-6666-4666-8666-666666666666" },
      { ...acknowledgement, nodeId: "66666666-6666-4666-8666-666666666666" },
      { ...acknowledgement, deviceUuid: "ffeeddccbbaa99887766554433221100" },
      { ...acknowledgement, meshAddress: "0x0102" },
      { ...acknowledgement, eventId: "66666666-6666-4666-8666-666666666666" },
      { ...acknowledgement, sequence: 8 }
    ];
    for (const mismatch of mismatches) {
      await expect(restarted.acknowledgeTerminal(mismatch)).resolves.toBe(false);
    }
    expect(await restarted.pendingTerminals()).toEqual([terminal]);
    await expect(restarted.acknowledgeTerminal(acknowledgement)).resolves.toBe(true);
    expect(await restarted.pendingTerminals()).toEqual([]);

    const execute = vi.fn();
    const publish = vi.fn();
    await handleDurableProvisioningDevice({
      journal: restarted,
      command,
      execute,
      nextEnvelope: vi.fn(),
      onTerminalPersisted: publish
    });
    expect(execute).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("retries after broker PUBACK on the same connection until the application ACK arrives", async () => {
    vi.useFakeTimers();
    const journal = new ProvisioningDeviceJournal(await journalPath());
    await journal.accept(command);
    const terminal = completedTerminal();
    await journal.complete(command, terminal);
    const publish = vi.fn().mockResolvedValue(undefined);
    const replay = new ProvisioningDeviceReplayPublisher(journal, {
      publishTimeoutMs: 1_000,
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 400
    });

    await replay.connect(publish);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(publish).toHaveBeenCalledTimes(2);

    await replay.acknowledgeTerminal({
      commandId: command.commandId,
      sessionId: command.sessionId,
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: command.meshAddress,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      ingestedAt: "2026-09-03T00:00:02.000Z"
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(publish).toHaveBeenCalledTimes(2);
    replay.disconnect();
  });

  it("replays the original terminal on reconnect and serializes connected drains", async () => {
    const journal = new ProvisioningDeviceJournal(await journalPath());
    await journal.accept(command);
    const terminal = completedTerminal();
    await journal.complete(command, terminal);
    const replay = new ProvisioningDeviceReplayPublisher(journal, {
      publishTimeoutMs: 1_000,
      retryInitialDelayMs: 100,
      retryMaxDelayMs: 400
    });
    const firstPublish = vi.fn().mockRejectedValue(new Error("broker unavailable"));
    await replay.connect(firstPublish);
    expect(firstPublish).toHaveBeenCalledTimes(1);

    replay.disconnect();
    const reconnectPublish = vi.fn().mockResolvedValue(undefined);
    const first = replay.connect(reconnectPublish);
    const concurrent = replay.connect(reconnectPublish);
    expect(concurrent).toBe(first);
    await first;

    expect(reconnectPublish).toHaveBeenCalledTimes(1);
    expect(reconnectPublish).toHaveBeenCalledWith(terminal.topic, terminal.payload);
    replay.disconnect();
  });

  it("fails closed on a corrupt or non-owner-only journal", async () => {
    const corruptPath = await journalPath();
    await writeFile(corruptPath, "{not-json", "utf8");
    await chmod(corruptPath, 0o600);
    await expect(new ProvisioningDeviceJournal(corruptPath).initialize())
      .rejects.toThrow("invalid provisioning device journal");

    const unsafePath = await journalPath();
    await writeFile(unsafePath, JSON.stringify({ version: 1, records: {} }), "utf8");
    await chmod(unsafePath, 0o644);
    await expect(new ProvisioningDeviceJournal(unsafePath).initialize())
      .rejects.toThrow("unsafe provisioning device journal permissions");
  });

  it("fails closed when a terminal has neither a pending marker nor an exact ACK", async () => {
    const path = await journalPath();
    const journal = new ProvisioningDeviceJournal(path);
    await journal.accept(command);
    await journal.complete(command, completedTerminal());
    const inconsistent = JSON.parse(await readFile(path, "utf8"));
    inconsistent.pendingTerminalCommandIds = [];
    await writeFile(path, JSON.stringify(inconsistent), "utf8");
    await chmod(path, 0o600);

    await expect(new ProvisioningDeviceJournal(path).initialize())
      .rejects.toThrow("invalid provisioning device journal");
  });

  it("starts tombstone retention from the local durable ACK commit, not the API clock", async () => {
    let now = new Date("2026-09-03T12:00:00.000Z");
    const journal = new ProvisioningDeviceJournal(await journalPath(), { now: () => now });
    await journal.accept(command);
    const terminal = completedTerminal();
    await journal.complete(command, terminal);

    await journal.acknowledgeTerminal({
      commandId: command.commandId,
      sessionId: command.sessionId,
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: command.meshAddress,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      ingestedAt: "2026-08-01T00:00:00.000Z"
    });
    now = new Date("2026-09-04T11:59:59.999Z");

    await expect(journal.accept(command)).resolves.toEqual({
      kind: "terminal",
      terminal,
      pending: false
    });
  });

  it("protects fresh tombstones at capacity and prunes them only after retention expires", async () => {
    let now = new Date("2026-09-03T00:00:00.000Z");
    const journal = new ProvisioningDeviceJournal(await journalPath(), {
      now: () => now,
      maxRecords: 1,
      retentionMs: 24 * 60 * 60 * 1000
    });
    await journal.accept(command);
    const terminal = completedTerminal();
    await journal.complete(command, terminal);
    await journal.acknowledgeTerminal({
      commandId: command.commandId,
      sessionId: command.sessionId,
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: command.meshAddress,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      ingestedAt: "2026-09-03T00:00:01.000Z"
    });
    const next = {
      ...command,
      commandId: "77777777-7777-4777-8777-777777777777",
      nodeId: "88888888-8888-4888-8888-888888888888",
      deviceUuid: "ffeeddccbbaa99887766554433221100",
      meshAddress: "0x0102",
      requestedAt: "2026-09-03T00:01:00.000Z"
    };

    await expect(journal.accept(next))
      .rejects.toThrow("provisioning device journal exceeds the supported limit (1)");
    await expect(journal.accept(command)).resolves.toMatchObject({ kind: "terminal", pending: false });

    now = new Date("2026-09-04T00:00:00.001Z");
    await expect(journal.accept(next)).resolves.toEqual({ kind: "new" });
  });

  it("fails closed at capacity without evicting accepted or application-unacknowledged records", async () => {
    const next = {
      ...command,
      commandId: "77777777-7777-4777-8777-777777777777",
      nodeId: "88888888-8888-4888-8888-888888888888",
      deviceUuid: "ffeeddccbbaa99887766554433221100",
      meshAddress: "0x0102"
    };
    const accepted = new ProvisioningDeviceJournal(await journalPath(), { maxRecords: 1 });
    await accepted.accept(command);

    await expect(accepted.accept(next))
      .rejects.toThrow("provisioning device journal exceeds the supported limit (1)");
    await expect(accepted.accept(command)).resolves.toEqual({ kind: "running" });

    const pending = new ProvisioningDeviceJournal(await journalPath(), { maxRecords: 1 });
    await pending.accept(command);
    const terminal = completedTerminal();
    await pending.complete(command, terminal);

    await expect(pending.accept(next))
      .rejects.toThrow("provisioning device journal exceeds the supported limit (1)");
    await expect(pending.pendingTerminals()).resolves.toEqual([terminal]);
  });
});

function completedTerminal() {
  const { requestedAt: _requestedAt, ...identity } = command;
  return {
    topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/device-terminal`,
    payload: {
      ...identity,
      ...envelope,
      status: "completed" as const,
      firmwareVersion: "1.0.0",
      rssi: -55,
      hopCount: 1
    }
  } as unknown as { topic: string; payload: ProvisioningDeviceTerminalV2 };
}

async function journalPath() {
  const directory = await mkdtemp(join(tmpdir(), "provisioning-device-journal-"));
  directories.push(directory);
  return join(directory, "journal.json");
}
