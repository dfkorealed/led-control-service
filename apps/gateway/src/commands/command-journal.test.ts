import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandJournal, CommandJournalAutomationCapacityError } from "./command-journal";

describe("CommandJournal", () => {
  it("persists accepted and terminal records with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "command-journal-"));
    const path = join(directory, "journal.json");
    const journal = new CommandJournal(path);
    await journal.accept("key-1", { commandId: "command-1" });
    await journal.complete("key-1", { status: "succeeded" });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await journal.get("key-1")).toEqual({
      state: "completed",
      command: { commandId: "command-1" },
      result: { status: "succeeded" }
    });
  });

  it("keeps only the latest fixture snapshot", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "command-snapshot-")), "journal.json");
    const journal = new CommandJournal(path);
    await journal.accept("key-1", { commandId: "command-1" });
    await journal.complete("key-1", commandResult("fixture-1", 30, "2026-07-11T00:00:01.000Z"));
    await journal.accept("key-2", { commandId: "command-2" });
    await journal.complete("key-2", commandResult("fixture-1", 70, "2026-07-11T00:00:02.000Z"));

    expect(await journal.latestFixtureSnapshots()).toEqual([
      expect.objectContaining({ fixtureId: "fixture-1", brightness: 70, occurredAt: "2026-07-11T00:00:02.000Z" })
    ]);
  });

  it("preserves the last observed snapshot when an unobserved terminal result completes", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "command-unobserved-snapshot-")), "journal.json");
    const journal = new CommandJournal(path);
    await journal.accept("observed", { commandId: "command-1" });
    await journal.complete("observed", commandResult("fixture-1", 70, "2026-07-11T00:00:01.000Z"));
    await journal.accept("expired", { commandId: "command-2" });
    await journal.complete("expired", {
      fixtureStateObserved: false,
      deviceStatus: {
        status: "failed",
        occurredAt: "2026-07-11T00:00:02.000Z",
        results: [{ fixtureId: "fixture-1", status: "failed", errorMessage: "gateway command expired before execution" }]
      }
    });

    expect(await journal.get("expired")).toMatchObject({ result: { fixtureStateObserved: false } });
    expect(await journal.latestFixtureSnapshots()).toEqual([
      expect.objectContaining({ fixtureId: "fixture-1", brightness: 70, occurredAt: "2026-07-11T00:00:01.000Z" })
    ]);
  });

  it("prunes expired idempotency records", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "command-prune-")), "journal.json");
    let now = new Date("2026-07-11T00:00:00.000Z");
    const journal = new CommandJournal(path, { now: () => now, ttlMs: 1000, maxRecords: 10000 });
    await journal.accept("expired", { commandId: "command-1" });
    now = new Date("2026-07-11T00:00:02.000Z");
    await journal.accept("current", { commandId: "command-2" });

    expect(await journal.get("expired")).toBeNull();
    expect(await journal.get("current")).not.toBeNull();
  });

  it("migrates the legacy record map without losing terminal results", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "command-legacy-")), "journal.json");
    await writeFile(
      path,
      JSON.stringify({ legacy: { state: "completed", command: { commandId: "old" }, result: commandResult("fixture-1", 40, "2026-07-11T00:00:01.000Z") } })
    );
    const journal = new CommandJournal(path, { now: () => new Date("2026-07-11T00:00:02.000Z") });

    expect(await journal.get("legacy")).toMatchObject({ state: "completed", command: { commandId: "old" } });
    expect(await journal.latestFixtureSnapshots()).toEqual([expect.objectContaining({ fixtureId: "fixture-1", brightness: 40 })]);
  });

  it("persists a replayable automation handoff phase across completed-command restart", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "command-handoff-")), "journal.json");
    const command = { command: { commandId: "command-1", overrideUntil: "2026-08-30T02:00:00.000Z" } };
    const result = commandResult("fixture-1", 60, "2026-08-30T01:00:01.000Z");
    const journal = new CommandJournal(path);
    await journal.accept("key-1", command);
    await journal.complete("key-1", result, { automationHandoffPending: true });

    const restarted = new CommandJournal(path);
    await expect(restarted.pendingAutomationHandoffs()).resolves.toEqual([{
      idempotencyKey: "key-1",
      command,
      result
    }]);

    await restarted.markAutomationHandoffComplete("key-1");
    await expect(restarted.pendingAutomationHandoffs()).resolves.toEqual([]);
    await expect(restarted.get("key-1")).resolves.toMatchObject({ automationHandoff: "completed" });

    await restarted.accept("key-2", {
      command: { commandId: "command-2", overrideUntil: "2026-08-30T03:00:00.000Z" }
    });
    await expect(restarted.pendingAutomationRecoveries()).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: "key-2", state: "accepted" })
    ]);
  });

  it("retains accepted and pending manual recoveries beyond command TTL and a 30-day override", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "command-long-manual-")), "journal.json");
    let now = new Date("2026-08-01T00:00:00.000Z");
    const journal = new CommandJournal(path, { now: () => now, ttlMs: 24 * 60 * 60 * 1000 });
    await journal.accept("accepted", timedCommand("command-1", "2026-08-31T00:00:00.000Z"));
    await journal.accept("pending", timedCommand("command-2", "2026-08-31T00:00:00.000Z"));
    await journal.complete("pending", commandResult("fixture-1", 60, now.toISOString()), {
      automationHandoffPending: true
    });

    now = new Date("2026-09-02T00:00:00.000Z");

    await expect(journal.pendingAutomationRecoveries()).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: "accepted", state: "accepted" }),
      expect.objectContaining({ idempotencyKey: "pending", state: "completed" })
    ]);
    await expect(journal.get("accepted")).resolves.toMatchObject({ state: "accepted" });
    await expect(journal.get("pending")).resolves.toMatchObject({ automationHandoff: "pending" });
  });

  it("protects pending automation recovery records from ordinary max-record eviction", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "command-pending-eviction-")), "journal.json");
    const journal = new CommandJournal(path, { maxRecords: 1, maxPendingAutomationRecords: 2 });
    await journal.accept("pending", timedCommand("command-pending", "2026-08-31T00:00:00.000Z"));
    await journal.complete("pending", commandResult("fixture-1", 60, "2026-08-01T00:00:00.000Z"), {
      automationHandoffPending: true
    });
    await journal.accept("ordinary-1", { commandId: "ordinary-1" });
    await journal.complete("ordinary-1", { status: "succeeded" });
    await journal.accept("ordinary-2", { commandId: "ordinary-2" });
    await journal.complete("ordinary-2", { status: "succeeded" });

    await expect(journal.pendingAutomationRecoveries()).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: "pending" })
    ]);
    await expect(journal.get("ordinary-1")).resolves.toBeNull();
    await expect(journal.get("ordinary-2")).resolves.not.toBeNull();
  });

  it("fails intake explicitly when the separate pending automation capacity is full", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "command-pending-capacity-")), "journal.json");
    const journal = new CommandJournal(path, { maxPendingAutomationRecords: 1 });
    await journal.accept("pending", timedCommand("command-1", "2026-08-31T00:00:00.000Z"));

    await expect(journal.accept(
      "overflow",
      timedCommand("command-2", "2026-08-31T00:00:00.000Z")
    )).rejects.toMatchObject({
      name: "CommandJournalAutomationCapacityError",
      code: "COMMAND_AUTOMATION_HANDOFF_CAPACITY",
      limit: 1
    } satisfies Partial<CommandJournalAutomationCapacityError>);
    await expect(journal.pendingAutomationRecoveries()).resolves.toEqual([
      expect.objectContaining({ idempotencyKey: "pending" })
    ]);
  });
});

function commandResult(fixtureId: string, brightness: number, occurredAt: string) {
  return {
    acceptance: { status: "accepted" },
    fixtureStateObserved: true,
    deviceStatus: {
      status: "succeeded",
      occurredAt,
      results: [{ fixtureId, status: "succeeded", brightness, rssi: -60, hopCount: 1 }]
    }
  };
}

function timedCommand(commandId: string, overrideUntil: string) {
  return { command: { commandId, overrideUntil } };
}
