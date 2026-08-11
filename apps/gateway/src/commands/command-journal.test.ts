import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandJournal } from "./command-journal";

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
