import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readJsonFile } from "./mesh-store-file";

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
