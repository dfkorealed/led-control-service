import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  writes: [] as Array<{ path: string; value: unknown }>,
  failWrites: false
}));

vi.mock("./mesh-store-file", () => ({
  readJsonFile: vi.fn(async (path: string) => files.values.get(path) ?? null),
  writeJsonAtomic: vi.fn(async (path: string, value: unknown) => {
    files.writes.push({ path, value });
    if (files.failWrites) throw new Error("disk unavailable");
    files.values.set(path, structuredClone(value));
  })
}));

import { MeshTransactionStore } from "./mesh-transaction-store";

const path = "/state/mesh-transactions.json";

beforeEach(() => {
  files.values.clear();
  files.writes.length = 0;
  files.failWrites = false;
});

describe("MeshTransactionStore", () => {
  it("durably reserves 32 TIDs per destination before dispensing the first value", async () => {
    const store = new MeshTransactionStore(path);

    await expect(store.next(0x0100)).resolves.toBe(0);

    expect(files.writes).toEqual([{
      path,
      value: { version: 2, defaultNextTid: 0, destinations: { "256": 32 } }
    }]);
  });

  it("keeps destination sequences independent", async () => {
    const store = new MeshTransactionStore(path);

    await expect(store.next(0x0100)).resolves.toBe(0);
    await expect(Promise.all(Array.from({ length: 40 }, () => store.next(0x0101)))).resolves.toEqual(
      Array.from({ length: 40 }, (_, index) => index)
    );
    await expect(store.next(0x0100)).resolves.toBe(1);
  });

  it("does not reuse a destination TID before that destination completes its own cycle", async () => {
    const store = new MeshTransactionStore(path);

    const tids = await Promise.all(Array.from({ length: 256 }, () => store.next(0x0100)));

    expect(tids).toEqual(Array.from({ length: 256 }, (_, index) => index));
    expect(new Set(tids).size).toBe(256);
  });

  it("skips unused reserved TIDs independently after restart", async () => {
    const first = new MeshTransactionStore(path);
    await expect(Promise.all([first.next(0x0100), first.next(0x0100), first.next(0x0100)])).resolves.toEqual([0, 1, 2]);
    await expect(first.next(0x0101)).resolves.toBe(0);

    const restarted = new MeshTransactionStore(path);
    await expect(restarted.next(0x0100)).resolves.toBe(32);
    await expect(restarted.next(0x0101)).resolves.toBe(32);
    expect(files.values.get(path)).toEqual({
      version: 2,
      defaultNextTid: 0,
      destinations: { "256": 64, "257": 64 }
    });
  });

  it("dispenses no TID when durable reservation fails", async () => {
    const store = new MeshTransactionStore(path);
    files.failWrites = true;

    await expect(store.nextMany([0x0100, 0x0101])).rejects.toThrow("disk unavailable");
    expect(files.values.has(path)).toBe(false);

    files.failWrites = false;
    await expect(store.nextMany([0x0100, 0x0101])).resolves.toEqual([0, 0]);
  });

  it("reserves 1000 unique destinations with one durable write", async () => {
    const store = new MeshTransactionStore(path);
    const destinations = Array.from({ length: 1000 }, (_, index) => 0x0100 + index);

    await expect(store.nextMany(destinations)).resolves.toEqual(destinations.map(() => 0));
    expect(files.writes).toHaveLength(1);
    expect(Object.keys((files.writes[0].value as any).destinations)).toHaveLength(1000);
  });

  it("rejects duplicate destinations before reserving or dispensing", async () => {
    const store = new MeshTransactionStore(path);

    await expect(store.nextMany([0x0100, 0x0100])).rejects.toThrow("duplicate mesh destination");
    expect(files.writes).toHaveLength(0);
    await expect(store.next(0x0100)).resolves.toBe(0);
  });

  it("migrates a version 1 global reservation without reusing its pending block", async () => {
    files.values.set(path, { version: 1, nextTid: 96 });
    const store = new MeshTransactionStore(path);

    await expect(store.nextMany([0x0100, 0xc000])).resolves.toEqual([96, 96]);

    expect(files.values.get(path)).toEqual({
      version: 2,
      defaultNextTid: 96,
      destinations: { "256": 128, "49152": 128 }
    });
  });

  it("rejects an oversized version 2 destination map", async () => {
    files.values.set(path, {
      version: 2,
      defaultNextTid: 0,
      destinations: Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [String(index), 0]))
    });

    await expect(new MeshTransactionStore(path).next(0x0100)).rejects.toThrow("Invalid mesh transaction file");
    expect(files.writes).toHaveLength(0);
  });
});
