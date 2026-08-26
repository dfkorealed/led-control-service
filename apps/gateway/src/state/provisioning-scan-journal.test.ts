import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDurableProvisioningScan } from "../gateway";
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

  it("replays the persisted terminal event with its original eventId and sequence after restart", async () => {
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
    expect(replayPublish).toHaveBeenCalledWith(
      `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/scan-completed`,
      expect.objectContaining({ eventId: envelope.eventId, sequence: envelope.sequence, acceptedNodeCount: 0 })
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
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
