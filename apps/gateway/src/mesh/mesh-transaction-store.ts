import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";

interface StoredTransactions {
  version: 1;
  nextTid: number;
}

export class MeshTransactionStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  next() {
    const result = this.queue.then(async () => {
      const stored = await this.read();
      const tid = stored.nextTid;
      await writeJsonAtomic(this.path, { version: 1, nextTid: (tid + 1) & 0xff } satisfies StoredTransactions);
      return tid;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<StoredTransactions> {
    const value = await readJsonFile(this.path);
    if (value === null) return { version: 1, nextTid: 0 };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mesh transaction file");
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || !Number.isInteger(row.nextTid) || (row.nextTid as number) < 0 || (row.nextTid as number) > 255) {
      throw new Error("Invalid mesh transaction file");
    }
    return row as unknown as StoredTransactions;
  }
}
