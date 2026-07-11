import { mkdtemp, stat } from "node:fs/promises";
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
});
