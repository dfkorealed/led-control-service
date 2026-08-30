import { mkdir, open, rm, stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";

export type StorageHeadroomBackgroundTask = () => Promise<void>;

export interface StorageHeadroomSnapshot {
  status: "available" | "released" | "unavailable";
  counters: {
    normalWriteCount: number;
    enospcCount: number;
    retryCount: number;
    releaseCount: number;
    preallocationCount: number;
    preallocatedBytes: number;
    replenishAttemptCount: number;
    replenishFailureCount: number;
  };
}

export interface StorageHeadroom {
  initialize(): Promise<{ mode: "ready" | "degraded" }>;
  runWithHeadroom<T>(operation: () => Promise<T>): Promise<T>;
  snapshot(): StorageHeadroomSnapshot;
  stop(): void;
}

interface StorageHeadroomManagerOptions {
  preallocate?: (path: string, bytes: number) => Promise<number>;
  release?: (path: string) => Promise<void>;
  getFreeBytes?: (directory: string) => Promise<number>;
  scheduleBackground?: (task: StorageHeadroomBackgroundTask, delayMs: number) => unknown;
  cancelBackground?: (handle: unknown) => void;
  replenishDelayMs?: number;
  onBackgroundError?: (error: unknown) => void;
}

export class StorageHeadroomManager implements StorageHeadroom {
  private status: StorageHeadroomSnapshot["status"] = "unavailable";
  private initialization: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private backgroundHandle: unknown;
  private backgroundScheduled = false;
  private stopped = false;
  private readonly preallocate: NonNullable<StorageHeadroomManagerOptions["preallocate"]>;
  private readonly release: NonNullable<StorageHeadroomManagerOptions["release"]>;
  private readonly getFreeBytes: NonNullable<StorageHeadroomManagerOptions["getFreeBytes"]>;
  private readonly scheduleBackground: NonNullable<StorageHeadroomManagerOptions["scheduleBackground"]>;
  private readonly cancelBackground: NonNullable<StorageHeadroomManagerOptions["cancelBackground"]>;
  private readonly replenishDelayMs: number;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly counters: StorageHeadroomSnapshot["counters"] = {
    normalWriteCount: 0,
    enospcCount: 0,
    retryCount: 0,
    releaseCount: 0,
    preallocationCount: 0,
    preallocatedBytes: 0,
    replenishAttemptCount: 0,
    replenishFailureCount: 0
  };

  constructor(
    private readonly path: string,
    private readonly bytes: number,
    options: StorageHeadroomManagerOptions = {}
  ) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("invalid storage headroom size");
    this.preallocate = options.preallocate ?? ensurePreallocatedFile;
    this.release = options.release ?? releaseReserve;
    this.getFreeBytes = options.getFreeBytes ?? filesystemFreeBytes;
    this.scheduleBackground = options.scheduleBackground ?? defaultScheduleBackground;
    this.cancelBackground = options.cancelBackground ?? defaultCancelBackground;
    this.replenishDelayMs = options.replenishDelayMs ?? 30_000;
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  async initialize() {
    this.initialization ??= this.initializeOnce();
    await this.initialization;
    return { mode: this.status === "available" ? "ready" as const : "degraded" as const };
  }

  async runWithHeadroom<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    try {
      const result = await operation();
      this.counters.normalWriteCount += 1;
      return result;
    } catch (error) {
      if (!isEnospc(error)) throw error;
      this.counters.enospcCount += 1;
      let released = false;
      try {
        released = await this.releaseOnce();
      } catch (releaseError) {
        this.onBackgroundError(releaseError);
      }
      if (!released) {
        this.requestReplenishment();
        throw error;
      }
      this.counters.retryCount += 1;
      try {
        const result = await operation();
        this.counters.normalWriteCount += 1;
        return result;
      } finally {
        this.requestReplenishment();
      }
    }
  }

  snapshot(): StorageHeadroomSnapshot {
    return { status: this.status, counters: { ...this.counters } };
  }

  stop() {
    this.stopped = true;
    if (this.backgroundScheduled) this.cancelBackground(this.backgroundHandle);
    this.backgroundHandle = undefined;
    this.backgroundScheduled = false;
  }

  private async initializeOnce() {
    try {
      await this.exclusive(async () => {
        const written = await this.preallocate(this.path, this.bytes);
        this.recordPreallocation(written);
        this.status = "available";
      });
    } catch (error) {
      this.status = "unavailable";
      this.onBackgroundError(error);
      this.requestReplenishment();
    }
  }

  private releaseOnce() {
    return this.exclusive(async () => {
      if (this.status === "released") return true;
      if (this.status !== "available") return false;
      await this.release(this.path);
      this.status = "released";
      this.counters.releaseCount += 1;
      return true;
    });
  }

  private requestReplenishment() {
    if (this.stopped || this.status === "available" || this.backgroundScheduled) return;
    this.backgroundScheduled = true;
    this.backgroundHandle = this.scheduleBackground(
      () => this.replenishInBackground(),
      this.replenishDelayMs
    );
  }

  private async replenishInBackground() {
    this.backgroundScheduled = false;
    this.backgroundHandle = undefined;
    if (this.stopped || this.status === "available") return;
    this.counters.replenishAttemptCount += 1;
    try {
      const freeBytes = await this.getFreeBytes(dirname(this.path));
      if (freeBytes < this.bytes * 2) {
        this.requestReplenishment();
        return;
      }
      await this.exclusive(async () => {
        if (this.status === "available") return;
        const written = await this.preallocate(this.path, this.bytes);
        this.recordPreallocation(written);
        this.status = "available";
      });
    } catch (error) {
      this.counters.replenishFailureCount += 1;
      this.onBackgroundError(error);
    }
    this.requestReplenishment();
  }

  private recordPreallocation(written: number) {
    if (!Number.isSafeInteger(written) || written < 0 || written > this.bytes) {
      throw new Error("invalid storage headroom preallocation result");
    }
    this.counters.preallocationCount += 1;
    this.counters.preallocatedBytes += written;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isEnospc(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOSPC";
}

async function ensurePreallocatedFile(path: string, bytes: number) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const metadata = await stat(path);
    if (metadata.size === bytes) return 0;
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const file = await open(path, "wx", 0o600);
  try {
    const chunk = Buffer.alloc(Math.min(bytes, 1024 * 1024));
    for (let position = 0; position < bytes; position += chunk.length) {
      const length = Math.min(chunk.length, bytes - position);
      await writeAll(file, chunk.subarray(0, length), position);
    }
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  await syncDirectory(directory);
  return bytes;
}

async function releaseReserve(path: string) {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function filesystemFreeBytes(directory: string) {
  const statistics = await statfs(directory);
  return Math.min(Number.MAX_SAFE_INTEGER, Number(statistics.bavail) * Number(statistics.bsize));
}

function defaultScheduleBackground(task: StorageHeadroomBackgroundTask, delayMs: number) {
  const timer = setTimeout(() => void task(), delayMs);
  timer.unref();
  return timer;
}

function defaultCancelBackground(handle: unknown) {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

async function syncDirectory(directory: string) {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number
) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten <= 0) throw new Error("storage headroom write made no progress");
    offset += bytesWritten;
  }
}
