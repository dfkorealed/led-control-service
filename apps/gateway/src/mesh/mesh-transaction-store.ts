import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";

interface StoredTransactionsV2 {
  version: 2;
  defaultNextTid: number;
  destinations: Record<string, number>;
}

interface Reservation {
  nextTid: number;
  remaining: number;
}

const TID_RESERVATION_SIZE = 32;
const MAX_STORED_DESTINATIONS = 4096;

export class MeshTransactionStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly reservations = new Map<number, Reservation>();
  private stored: StoredTransactionsV2 | undefined;

  constructor(private readonly path: string) {}

  next(destination: number) {
    return this.enqueue(async () => (await this.dispenseMany([destination]))[0]);
  }

  nextMany(destinations: number[]) {
    return this.enqueue(() => this.dispenseMany(destinations));
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async dispenseMany(destinations: number[]) {
    validateDestinations(destinations);
    if (destinations.length === 0) return [];

    const stored = await this.load();
    const missing = destinations.filter((destination) => !this.reservations.has(destination));
    if (missing.length > 0) {
      const nextDestinations = { ...stored.destinations };
      let destinationCount = Object.keys(nextDestinations).length;
      for (const destination of missing) {
        const key = String(destination);
        if (!(key in nextDestinations)) {
          destinationCount += 1;
          if (destinationCount > MAX_STORED_DESTINATIONS) {
            throw new Error(`mesh transaction destination limit exceeded (${MAX_STORED_DESTINATIONS})`);
          }
        }
        const firstTid = nextDestinations[key] ?? stored.defaultNextTid;
        nextDestinations[key] = incrementTid(firstTid, TID_RESERVATION_SIZE);
      }

      const nextStored: StoredTransactionsV2 = {
        version: 2,
        defaultNextTid: stored.defaultNextTid,
        destinations: nextDestinations
      };
      // Every block is durable before any TID from this batch is visible to a caller.
      await writeJsonAtomic(this.path, nextStored);
      this.stored = nextStored;
      for (const destination of missing) {
        const durableNextTid = nextDestinations[String(destination)];
        this.reservations.set(destination, {
          nextTid: incrementTid(durableNextTid, -TID_RESERVATION_SIZE),
          remaining: TID_RESERVATION_SIZE
        });
      }
    }

    return destinations.map((destination) => {
      const reservation = this.reservations.get(destination)!;
      const tid = reservation.nextTid;
      reservation.nextTid = incrementTid(tid, 1);
      reservation.remaining -= 1;
      if (reservation.remaining === 0) this.reservations.delete(destination);
      return tid;
    });
  }

  private async load(): Promise<StoredTransactionsV2> {
    if (this.stored) return this.stored;
    const value = await readJsonFile(this.path);
    if (value === null) {
      this.stored = { version: 2, defaultNextTid: 0, destinations: {} };
      return this.stored;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid mesh transaction file");
    }
    const row = value as Record<string, unknown>;
    if (row.version === 1) {
      validateTid(row.nextTid);
      this.stored = { version: 2, defaultNextTid: row.nextTid as number, destinations: {} };
      return this.stored;
    }
    if (row.version !== 2) throw new Error("Invalid mesh transaction file");
    validateTid(row.defaultNextTid);
    if (!row.destinations || typeof row.destinations !== "object" || Array.isArray(row.destinations)) {
      throw new Error("Invalid mesh transaction file");
    }
    const entries = Object.entries(row.destinations as Record<string, unknown>);
    if (entries.length > MAX_STORED_DESTINATIONS) throw new Error("Invalid mesh transaction file");
    for (const [key, nextTid] of entries) {
      const destination = Number(key);
      if (!Number.isInteger(destination) || destination < 0 || destination > 0xffff || String(destination) !== key) {
        throw new Error("Invalid mesh transaction file");
      }
      validateTid(nextTid);
    }
    this.stored = row as unknown as StoredTransactionsV2;
    return this.stored;
  }
}

function validateDestinations(destinations: number[]) {
  const seen = new Set<number>();
  for (const destination of destinations) {
    if (!Number.isInteger(destination) || destination < 0 || destination > 0xffff) {
      throw new Error("invalid mesh destination");
    }
    if (seen.has(destination)) throw new Error("duplicate mesh destination");
    seen.add(destination);
  }
}

function validateTid(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) {
    throw new Error("Invalid mesh transaction file");
  }
}

function incrementTid(value: number, amount: number) {
  return (value + amount + 256) & 0xff;
}
