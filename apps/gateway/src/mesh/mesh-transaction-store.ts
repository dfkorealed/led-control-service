import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";

interface StoredTransactions {
  version: 1;
  nextTid: number;
}

const TID_RESERVATION_SIZE = 32;

export class MeshTransactionStore {
  private queue: Promise<unknown> = Promise.resolve();
  private reservedTid: number | null = null;
  private remainingReserved = 0;

  constructor(private readonly path: string) {}

  next(_destination?: number) {
    const result = this.queue.then(() => this.dispense());
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async dispense() {
    if (this.remainingReserved === 0) await this.reserveBlock();
    const tid = this.reservedTid!;
    this.reservedTid = (tid + 1) & 0xff;
    this.remainingReserved -= 1;
    return tid;
  }

  private async reserveBlock() {
    const stored = await this.read();
    const firstTid = stored.nextTid;
    const nextBlockTid = (firstTid + TID_RESERVATION_SIZE) & 0xff;
    await writeJsonAtomic(this.path, { version: 1, nextTid: nextBlockTid } satisfies StoredTransactions);

    // Persist the next block first so a crash skips unused TIDs instead of reusing issued transactions.
    this.reservedTid = firstTid;
    this.remainingReserved = TID_RESERVATION_SIZE;
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
