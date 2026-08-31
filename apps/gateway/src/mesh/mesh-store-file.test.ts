import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("rejects an oversized JSON journal before parsing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bounded-json-read-"));
  directories.push(directory);
  const path = join(directory, "journal.json");
  await writeFile(path, JSON.stringify({ payload: "x".repeat(64) }));

  await expect(readJsonFile(path, { maxBytes: 32 })).rejects.toThrow("json_file_size_limit_exceeded");
});

it("gives concurrent same-millisecond writes distinct temporary identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "concurrent-json-write-"));
  directories.push(directory);
  const path = join(directory, "health.json");
  vi.spyOn(Date, "now").mockReturnValue(1_788_152_873_967);

  await expect(Promise.all([
    writeJsonAtomic(path, { source: "heartbeat" }),
    writeJsonAtomic(path, { source: "mesh-resync" })
  ])).resolves.toEqual([undefined, undefined]);

  expect(await readJsonFile(path)).toEqual(expect.objectContaining({
    source: expect.stringMatching(/^(heartbeat|mesh-resync)$/)
  }));
  expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
});
