import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

interface JournalRecord {
  state: "accepted" | "completed";
  command: unknown;
  result?: unknown;
  updatedAt: string;
}

interface FixtureSnapshot {
  fixtureId: string;
  status: string;
  brightness?: number;
  faultCode?: string;
  errorMessage?: string;
  rssi?: number | null;
  hopCount?: number | null;
  occurredAt: string;
}

interface JournalData {
  version: 2;
  records: Record<string, JournalRecord>;
  fixtureSnapshots: Record<string, FixtureSnapshot>;
}

interface JournalOptions {
  now?: () => Date;
  ttlMs?: number;
  maxRecords?: number;
}

export class CommandJournal {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxRecords: number;

  constructor(
    private readonly path: string,
    options: JournalOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxRecords = options.maxRecords ?? 10_000;
  }

  async get(idempotencyKey: string) {
    const data = await this.readData();
    const record = data.records[idempotencyKey];
    if (!record || this.isExpired(record)) return null;
    return { state: record.state, command: record.command, ...(record.result === undefined ? {} : { result: record.result }) };
  }

  async latestFixtureSnapshots() {
    return Object.values((await this.readData()).fixtureSnapshots).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
  }

  async accept(idempotencyKey: string, command: unknown) {
    return this.enqueue(async () => {
      const data = await this.readData();
      this.prune(data);
      if (data.records[idempotencyKey]) return false;
      data.records[idempotencyKey] = { state: "accepted", command, updatedAt: this.now().toISOString() };
      this.prune(data);
      await this.writeData(data);
      return true;
    });
  }

  async complete(idempotencyKey: string, result: unknown) {
    await this.enqueue(async () => {
      const data = await this.readData();
      const existing = data.records[idempotencyKey];
      if (!existing) throw new Error("command must be accepted before completion");
      data.records[idempotencyKey] = { ...existing, state: "completed", result, updatedAt: this.now().toISOString() };
      this.updateSnapshots(data, result);
      this.prune(data);
      await this.writeData(data);
    });
  }

  private updateSnapshots(data: JournalData, result: unknown) {
    if (!result || typeof result !== "object" || !("deviceStatus" in result)) return;
    const deviceStatus = (result as { deviceStatus?: unknown }).deviceStatus;
    if (!deviceStatus || typeof deviceStatus !== "object") return;
    const row = deviceStatus as { occurredAt?: unknown; results?: unknown };
    if (typeof row.occurredAt !== "string" || !Array.isArray(row.results)) return;
    for (const item of row.results) {
      if (!item || typeof item !== "object" || typeof (item as { fixtureId?: unknown }).fixtureId !== "string") continue;
      const fixture = item as Record<string, unknown> & { fixtureId: string };
      data.fixtureSnapshots[fixture.fixtureId] = {
        fixtureId: fixture.fixtureId,
        status: typeof fixture.status === "string" ? fixture.status : "failed",
        ...(typeof fixture.brightness === "number" ? { brightness: fixture.brightness } : {}),
        ...(typeof fixture.faultCode === "string" ? { faultCode: fixture.faultCode } : {}),
        ...(typeof fixture.errorMessage === "string" ? { errorMessage: fixture.errorMessage } : {}),
        ...(typeof fixture.rssi === "number" || fixture.rssi === null ? { rssi: fixture.rssi } : {}),
        ...(typeof fixture.hopCount === "number" || fixture.hopCount === null ? { hopCount: fixture.hopCount } : {}),
        occurredAt: row.occurredAt
      };
    }
  }

  private prune(data: JournalData) {
    for (const [key, record] of Object.entries(data.records)) {
      if (this.isExpired(record)) delete data.records[key];
    }
    const overflow = Object.entries(data.records).sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt));
    while (overflow.length > this.maxRecords) {
      const oldest = overflow.shift();
      if (oldest) delete data.records[oldest[0]];
    }
  }

  private isExpired(record: JournalRecord) {
    return this.now().getTime() - new Date(record.updatedAt).getTime() > this.ttlMs;
  }

  private async readData(): Promise<JournalData> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid command journal");
      const row = parsed as Partial<JournalData>;
      if (row.version === 2 && row.records && row.fixtureSnapshots) return row as JournalData;

      const migrated: JournalData = { version: 2, records: {}, fixtureSnapshots: {} };
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const legacy = value as { state?: unknown; command?: unknown; result?: unknown };
        if (legacy.state !== "accepted" && legacy.state !== "completed") continue;
        migrated.records[key] = {
          state: legacy.state,
          command: legacy.command,
          ...(legacy.result === undefined ? {} : { result: legacy.result }),
          updatedAt: this.now().toISOString()
        };
        if (legacy.result !== undefined) this.updateSnapshots(migrated, legacy.result);
      }
      return migrated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, records: {}, fixtureSnapshots: {} };
      throw error;
    }
  }

  private async writeData(data: JournalData) {
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(data)}\n`, "utf8");
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
