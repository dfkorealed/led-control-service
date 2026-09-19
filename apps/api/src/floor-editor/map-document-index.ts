import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { MAP_ELEMENT_MAX_ID_LENGTH } from "@led-control/shared";

const locatorSchema = z.tuple([z.string().min(1).max(MAP_ELEMENT_MAX_ID_LENGTH), z.number().int().nonnegative(), z.number().int().nonnegative()]);
export type MapElementLocator = z.infer<typeof locatorSchema>;
export function mapIdHash(id: string) { return createHash("sha256").update(id).digest("hex"); }

export function parseMapIndex(bytes: Buffer, prefix: string): MapElementLocator[] {
  const ids = new Set<string>();
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trimEnd().split("\n").map(line => {
    const entry = locatorSchema.parse(JSON.parse(line));
    if (ids.has(entry[0])) throw new Error("duplicate map element ID");
    if (!mapIdHash(entry[0]).startsWith(prefix)) throw new Error("map index prefix mismatch");
    ids.add(entry[0]);
    return entry;
  });
}

/** Disk radix partitioning keeps ID uniqueness checking bounded to one shard,
 * including adversarial IDs sharing a prefix. No all-document Set or geometry copy.
 */
export class MapIndexSpool {
  private readonly roots = new Set<string>();
  constructor(private readonly directory: string, private readonly maximum: number) {}

  async append(entries: MapElementLocator[]) {
    const partitions = new Map<string, string[]>();
    for (const entry of entries) {
      const prefix = mapIdHash(entry[0]).slice(0, 2);
      const lines = partitions.get(prefix) ?? [];
      lines.push(JSON.stringify(entry) + "\n"); partitions.set(prefix, lines);
    }
    for (const [prefix, lines] of partitions) {
      this.roots.add(prefix);
      await appendFile(this.path(prefix), lines.join(""), { mode: 0o600 });
    }
  }

  async *shards(): AsyncGenerator<{ prefix: string; decoded: Buffer; elementCount: number }> {
    for (const prefix of [...this.roots].sort()) yield* this.partition(prefix);
  }

  private async *partition(prefix: string): AsyncGenerator<{ prefix: string; decoded: Buffer; elementCount: number }> {
    if ((await stat(this.path(prefix))).size <= this.maximum) {
      const decoded = await readFile(this.path(prefix));
      const entries = parseMapIndex(decoded, prefix);
      yield { prefix, decoded, elementCount: entries.length };
      await unlink(this.path(prefix));
      return;
    }
    if (prefix.length >= 64) throw new Error("duplicate IDs or unsplittable map index byte budget");
    const children = new Set<string>();
    const stream = createReadStream(this.path(prefix), { highWaterMark: 64 * 1024 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const entry = locatorSchema.parse(JSON.parse(line));
        const child = mapIdHash(entry[0]).slice(0, prefix.length + 1);
        children.add(child);
        await appendFile(this.path(child), line + "\n", { mode: 0o600 });
      }
    } finally { lines.close(); stream.destroy(); }
    await unlink(this.path(prefix));
    for (const child of [...children].sort()) yield* this.partition(child);
  }

  private path(prefix: string) { return join(this.directory, `index-${prefix}.ndjson`); }
}
