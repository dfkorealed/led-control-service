import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export class EventSequenceStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  next(): Promise<number> {
    const operation = this.queue.then(async () => {
      const current = await this.read();
      const next = current + 1;
      if (!Number.isSafeInteger(next)) throw new Error("gateway event sequence exceeded safe integer range");
      await this.write(next);
      return next;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async read() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { sequence?: unknown };
      if (!Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 0) throw new Error("invalid event sequence store");
      return parsed.sequence as number;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  private async write(sequence: number) {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify({ sequence })}\n`, "utf8");
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
}
