import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

interface JournalRecord {
  state: "accepted" | "completed";
  command: unknown;
  result?: unknown;
}

export class CommandJournal {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(idempotencyKey: string): Promise<JournalRecord | null> {
    const records = await this.readAll();
    return records[idempotencyKey] ?? null;
  }

  async completedResults() {
    return Object.values(await this.readAll())
      .filter((record) => record.state === "completed" && record.result)
      .map((record) => record.result);
  }

  async accept(idempotencyKey: string, command: unknown) {
    return this.enqueue(async () => {
      const records = await this.readAll();
      if (records[idempotencyKey]) return false;
      records[idempotencyKey] = { state: "accepted", command };
      await this.writeAll(records);
      return true;
    });
  }

  async complete(idempotencyKey: string, result: unknown) {
    await this.enqueue(async () => {
      const records = await this.readAll();
      const existing = records[idempotencyKey];
      if (!existing) throw new Error("command must be accepted before completion");
      records[idempotencyKey] = { ...existing, state: "completed", result };
      await this.writeAll(records);
    });
  }

  private async readAll(): Promise<Record<string, JournalRecord>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid command journal");
      return parsed as Record<string, JournalRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(records: Record<string, JournalRecord>) {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(records)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
