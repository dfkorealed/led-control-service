import { BadRequestException, ConflictException } from "@nestjs/common";
import { MapElement, MapGroup, MapLayer, MapOp, getMapElementBounds, mapDocumentStateSchema, mapOpSchema } from "@led-control/shared";
import { appendFile, readFile, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { mapIdHash } from "./map-document-index";

type ElementOp = Extract<MapOp, { kind: "add" | "update" | "delete" }>;
type Record = { id: string; base?: MapElement; operation?: ElementOp };
const SHARD_BYTES = 24 * 1024 * 1024, BUFFER_BYTES = 4 * 1024 * 1024;

/** Geometry is bounded by one radix leaf, never a 500k-element JS Map. Files
 * preserve full precision/IDs; repeated writes for a target are rejected rather
 * than silently taking the last value. The caller owns the temporary directory. */
class BulkSpool {
  private roots = new Set<string>();
  private buffers = new Map<string, string[]>();
  private bytes = 0;
  private total = 0;
  constructor(private directory: string, private check: () => void) {}
  async append(record: Record) {
    this.check();
    const text = JSON.stringify(record) + "\n", bytes = Buffer.byteLength(text);
    if ((this.total += bytes) > 1536 * 1024 * 1024) throw new BadRequestException("bulk spool byte budget exceeded");
    const key = mapIdHash(record.id).slice(0, 2), batch = this.buffers.get(key) ?? [];
    batch.push(text); this.buffers.set(key, batch); this.roots.add(key); this.bytes += bytes;
    if (this.bytes >= BUFFER_BYTES) await this.flush();
  }
  async flush() {
    for (const [key, batch] of this.buffers) await appendFile(this.path(key), batch.join(""), { mode: 0o600 });
    this.buffers.clear(); this.bytes = 0; await setImmediate(); this.check();
  }
  async *leaves(): AsyncGenerator<Record[]> {
    await this.flush();
    for (const key of [...this.roots].sort()) yield* this.partition(key);
  }
  private async *partition(key: string): AsyncGenerator<Record[]> {
    this.check();
    if ((await stat(this.path(key))).size <= SHARD_BYTES) {
      const rows = (await readFile(this.path(key), "utf8")).trimEnd().split("\n").map(line => JSON.parse(line) as Record);
      yield rows; await unlink(this.path(key)); return;
    }
    if (key.length === 64) throw new BadRequestException("duplicate target or unsplittable bulk shard");
    const children = new Set<string>(), input = createReadStream(this.path(key), { highWaterMark: 65536 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        this.check();
        const record = JSON.parse(line) as Record, child = mapIdHash(record.id).slice(0, key.length + 1);
        children.add(child); await appendFile(this.path(child), line + "\n", { mode: 0o600 });
      }
    } finally { lines.close(); input.destroy(); }
    await unlink(this.path(key));
    for (const child of [...children].sort()) yield* this.partition(child);
  }
  private path(key: string) { return join(this.directory, `bulk-${key}.ndjson`); }
}

export async function prepareBulkMap(directory: string, base: AsyncIterable<MapElement>, operations: AsyncIterable<MapOp>,
  seed: { width: number; height: number; groups: MapGroup[]; layers: MapLayer[] }, check = () => {}) {
  const deadline = Date.now() + 5 * 60_000;
  const budget = () => { check(); if (Date.now() > deadline) throw new BadRequestException("bulk preparation deadline exceeded"); };
  const spool = new BulkSpool(directory, budget);
  const oldGroups = new Map(seed.groups.map(g => [g.id, g])), oldLayers = new Map(seed.layers.map(l => [l.id, l]));
  const groups = new Map(oldGroups), layers = new Map(oldLayers);
  const structures: MapOp[] = [], structureIds = new Set<string>();
  const deletedGroups = new Set<string>(), deletedLayers = new Set<string>();
  let structureBytes = 0, operationCount = 0;
  for await (const input of operations) {
    budget();
    if (++operationCount > 1_000_000) throw new BadRequestException("bulk operation count exceeded");
    const op = mapOpSchema.parse(input);
    if (op.kind === "add" || op.kind === "update" || op.kind === "delete") {
      await spool.append({ id: op.kind === "delete" ? op.id : op.element.id, operation: op }); continue;
    }
    if ((structureBytes += Buffer.byteLength(JSON.stringify(op))) > 8 * 1024 * 1024) throw new BadRequestException("bulk structure budget exceeded");
    const id = op.kind === "group.put" ? op.group.id : op.kind === "layer.put" ? op.layer.id : op.id;
    const key = op.kind.split(".")[0] + ":" + id;
    if (structureIds.has(key)) throw new BadRequestException("duplicate structure target");
    structureIds.add(key); structures.push(op);
    if (op.kind === "group.put") groups.set(id, op.group);
    if (op.kind === "layer.put") layers.set(id, op.layer);
    if (op.kind === "group.delete") {
      if (!oldGroups.has(id)) throw new BadRequestException("missing group");
      deletedGroups.add(id);
    }
    if (op.kind === "layer.delete") {
      if (!oldLayers.has(id)) throw new BadRequestException("missing layer");
      deletedLayers.add(id);
    }
  }
  const children = new Map<string, string[]>();
  // Explicit reparenting detaches an ungrouped subtree before recursive delete.
  // The original table is still used below for authority/lock checks.
  for (const group of groups.values()) if (group.parentId !== null) {
    const ids = children.get(group.parentId) ?? []; ids.push(group.id); children.set(group.parentId, ids);
  }
  for (const id of deletedGroups) for (const child of children.get(id) ?? []) deletedGroups.add(child);
  for (const id of deletedGroups) groups.delete(id);
  for (const id of deletedLayers) layers.delete(id);
  const structure = mapDocumentStateSchema.parse({ elements: [], groups: [...groups.values()], layers: [...layers.values()] });
  const lockedGroups = (table: Map<string, MapGroup>) => {
    const cache = new Map<string, boolean>();
    return (id: string | null) => {
      const visited: string[] = []; let locked = false;
      while (id !== null) {
        if (cache.has(id)) { locked = cache.get(id)!; break; }
        const group = table.get(id); if (!group) throw new BadRequestException("missing group");
        if (visited.includes(id)) throw new BadRequestException("group cycle");
        visited.push(id); if (group.locked) { locked = true; break; } id = group.parentId;
      }
      for (const key of visited) cache.set(key, locked);
      return locked;
    };
  };
  const beforeLocked = lockedGroups(oldGroups), afterLocked = lockedGroups(groups);
  const unlockOnly = (before: { locked: boolean }, after: { locked: boolean } | undefined) => after && before.locked && !after.locked &&
    isDeepStrictEqual({ ...before, locked: false }, after);
  const rejectLocked = () => { throw new ConflictException("map target is locked"); };
  for (const op of structures) {
    if (op.kind === "group.put" || op.kind === "group.delete") {
      const old = oldGroups.get(op.kind === "group.put" ? op.group.id : op.id);
      if (old && (beforeLocked(old.parentId) || (old.locked && !unlockOnly(old, op.kind === "group.put" ? op.group : undefined)))) rejectLocked();
      if (op.kind === "group.put" && afterLocked(op.group.parentId)) rejectLocked();
    } else if (op.kind === "layer.put" || op.kind === "layer.delete") {
      const old = oldLayers.get(op.kind === "layer.put" ? op.layer.id : op.id);
      if (old?.locked && !unlockOnly(old, op.kind === "layer.put" ? op.layer : undefined)) rejectLocked();
    }
  }
  for (const id of deletedGroups) if (beforeLocked(id)) rejectLocked();
  let baseCount = 0;
  for await (const element of base) {
    if (++baseCount > 500_000) throw new BadRequestException("bulk base element count exceeded");
    await spool.append({ id: element.id, base: element });
  }
  return { ...structure, operationCount, elements: async function* (): AsyncGenerator<MapElement> {
    let count = 0, sinceYield = 0;
    for await (const rows of spool.leaves()) {
      const originals = new Map<string, MapElement>(), changes = new Map<string, ElementOp>();
      for (const row of rows) {
        if (row.base) { if (originals.has(row.id)) throw new BadRequestException("duplicate base ID"); originals.set(row.id, row.base); }
        if (row.operation) { if (changes.has(row.id)) throw new BadRequestException("duplicate operation ID"); changes.set(row.id, row.operation); }
      }
      const ids = new Set([...originals.keys(), ...changes.keys()]);
      for (const id of ids) {
        budget(); if (++sinceYield % 128 === 0) await setImmediate();
        const before = originals.get(id), explicit = changes.get(id);
        const implicitDelete = before && ((before.groupId !== null && deletedGroups.has(before.groupId)) || deletedLayers.has(before.layerId));
        const op = explicit ?? (implicitDelete ? { kind: "delete" as const, id } : undefined);
        if (op?.kind === "add" ? !!before : op && !before) throw new BadRequestException("bulk target existence mismatch");
        const after = op?.kind === "delete" ? undefined : op ? op.element : before;
        if (op && before && (beforeLocked(before.groupId) || oldLayers.get(before.layerId)?.locked ||
          (before.locked && !unlockOnly(before, after)))) rejectLocked();
        if (after) {
          if (!layers.has(after.layerId) || (after.groupId !== null && !groups.has(after.groupId))) throw new BadRequestException("missing element structure");
          if (op && (afterLocked(after.groupId) || layers.get(after.layerId)?.locked)) rejectLocked();
          const bounds = getMapElementBounds(after);
          if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > seed.width || bounds.maxY > seed.height) throw new BadRequestException("map element exceeds floor bounds");
          if (++count > 500_000) throw new BadRequestException("bulk result element count exceeded");
          yield after;
        }
      }
    }
  } };
}
