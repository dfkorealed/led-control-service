import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventSequenceStore } from "./event-sequence-store";

describe("EventSequenceStore", () => {
  it("increments persistently with owner-only permissions", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "event-sequence-")), "sequence.json");
    const store = new EventSequenceStore(path);
    await expect(store.next()).resolves.toBe(1);
    await expect(store.next()).resolves.toBe(2);
    await expect(new EventSequenceStore(path).next()).resolves.toBe(3);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
