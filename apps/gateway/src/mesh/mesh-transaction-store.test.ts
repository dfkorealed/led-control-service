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
  it("durably reserves 32 TIDs before dispensing the first value", async () => {
    const store = new MeshTransactionStore(path);

    await expect(store.next()).resolves.toBe(0);

    expect(files.writes).toEqual([{
      path,
      value: { version: 1, nextTid: 32 }
    }]);
  });

  it("skips unused reserved TIDs after restart", async () => {
    const first = new MeshTransactionStore(path);
    await expect(Promise.all([first.next(), first.next(), first.next()])).resolves.toEqual([0, 1, 2]);

    const restarted = new MeshTransactionStore(path);
    await expect(restarted.next()).resolves.toBe(32);
    expect(files.values.get(path)).toEqual({ version: 1, nextTid: 64 });
  });

  it("dispenses no TID when durable reservation fails", async () => {
    const store = new MeshTransactionStore(path);
    files.failWrites = true;

    await expect(store.next()).rejects.toThrow("disk unavailable");
    expect(files.values.has(path)).toBe(false);

    files.failWrites = false;
    await expect(store.next()).resolves.toBe(0);
  });

  it("serves 1000 concurrent calls in deterministic modulo order with bounded durable writes", async () => {
    const store = new MeshTransactionStore(path);

    const tids = await Promise.all(Array.from({ length: 1000 }, () => store.next()));

    expect(tids).toEqual(Array.from({ length: 1000 }, (_, index) => index & 0xff));
    for (let offset = 0; offset < tids.length; offset += 256) {
      const cycle = tids.slice(offset, offset + 256);
      expect(new Set(cycle).size).toBe(cycle.length);
    }
    expect(files.writes).toHaveLength(Math.ceil(1000 / 32));
  });
});
