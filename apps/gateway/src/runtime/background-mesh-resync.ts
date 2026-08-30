import type { BleMeshResyncReport } from "../gateway";

interface BackgroundMeshResyncOptions {
  run: (signal: AbortSignal) => Promise<BleMeshResyncReport>;
  onReport: (report: BleMeshResyncReport) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
  stopTimeoutMs?: number;
}

interface TargetedLightingResyncOptions {
  run: (fixtureIds: string[], signal: AbortSignal) => Promise<BleMeshResyncReport>;
  onError?: (error: unknown) => Promise<void> | void;
  maxPendingFixtures?: number;
  maxBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  stopTimeoutMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export class BackgroundMeshResyncWorker {
  private current: Promise<void> | null = null;
  private rerunRequested = false;
  private stopping = false;
  private state: "pending" | "ready" | "failed" = "pending";
  private controller: AbortController | null = null;

  constructor(private readonly options: BackgroundMeshResyncOptions) {}

  get readiness() {
    return this.state;
  }

  schedule(rerunIfActive = false) {
    if (this.stopping) return false;
    if (this.current) {
      if (rerunIfActive) this.rerunRequested = true;
      return true;
    }
    this.current = this.drain().finally(() => {
      this.current = null;
    });
    return true;
  }

  async stopAndDrain() {
    this.stopping = true;
    this.rerunRequested = false;
    this.controller?.abort();
    if (this.current) {
      await settleWithin(this.current, this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    }
  }

  private async drain() {
    do {
      this.rerunRequested = false;
      const controller = new AbortController();
      this.controller = controller;
      try {
        const report = await this.options.run(controller.signal);
        await this.options.onReport(report);
        this.state = "ready";
      } catch (error) {
        if (controller.signal.aborted && this.stopping) return;
        this.state = "failed";
        try {
          await this.options.onError?.(error);
        } catch {
          // Resync and readiness reporting failures must not escape the background worker.
        }
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    } while (this.rerunRequested && !this.stopping);
  }
}

export class TargetedLightingResyncQueue {
  private readonly pending = new Set<string>();
  private readonly maxPendingFixtures: number;
  private readonly maxBatchSize: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private current: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private retryAttempt = 0;
  private stopping = false;

  constructor(private readonly options: TargetedLightingResyncOptions) {
    this.maxPendingFixtures = positiveInteger(options.maxPendingFixtures ?? 4_096, "targeted resync capacity");
    this.maxBatchSize = positiveInteger(options.maxBatchSize ?? 64, "targeted resync batch size");
    this.retryBaseMs = positiveInteger(options.retryBaseMs ?? 250, "targeted resync retry base");
    this.retryMaxMs = positiveInteger(options.retryMaxMs ?? 30_000, "targeted resync retry maximum");
    if (this.retryMaxMs < this.retryBaseMs) throw new Error("targeted resync retry maximum must cover its base");
  }

  get pendingCount() {
    return this.pending.size;
  }

  request(fixtureIds: string[]) {
    if (this.stopping) return false;
    const unique = [...new Set(fixtureIds)];
    const additions = unique.filter((fixtureId) => !this.pending.has(fixtureId));
    if (unique.length === 0 || unique.some((fixtureId) => fixtureId.length === 0) ||
      this.pending.size + additions.length > this.maxPendingFixtures) {
      return false;
    }
    for (const fixtureId of additions) this.pending.add(fixtureId);
    this.kick();
    return true;
  }

  markObserved(fixtureId: string) {
    this.pending.delete(fixtureId);
    if (this.pending.size === 0) {
      this.retryAttempt = 0;
      this.clearRetry();
    }
  }

  async stopAndDrain() {
    this.stopping = true;
    this.clearRetry();
    this.controller?.abort();
    if (this.current) {
      await settleWithin(this.current, this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    }
  }

  private kick() {
    if (this.stopping || this.current || this.retryTimer || this.pending.size === 0) return;
    this.current = this.runBatch().finally(() => {
      this.current = null;
      if (!this.retryTimer) this.kick();
    });
  }

  private async runBatch() {
    const fixtureIds = [...this.pending].slice(0, this.maxBatchSize);
    const controller = new AbortController();
    this.controller = controller;
    let failed = false;
    try {
      await this.options.run(fixtureIds, controller.signal);
    } catch (error) {
      failed = true;
      if (!controller.signal.aborted || !this.stopping) {
        try {
          await this.options.onError?.(error);
        } catch {
          // Retry remains armed even if operational error reporting fails.
        }
      }
    } finally {
      if (this.controller === controller) this.controller = null;
    }
    if (this.stopping) return;
    const unresolved = failed || fixtureIds.some((fixtureId) => this.pending.has(fixtureId));
    if (unresolved) this.armRetry();
    else this.retryAttempt = 0;
  }

  private armRetry() {
    if (this.retryTimer || this.stopping || this.pending.size === 0) return;
    const delayMs = Math.min(this.retryBaseMs * (2 ** this.retryAttempt), this.retryMaxMs);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delayMs);
    this.retryTimer.unref();
  }

  private clearRetry() {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

export function startControlPlaneWithBackgroundMeshResync(
  startControlPlane: () => void,
  worker: Pick<BackgroundMeshResyncWorker, "schedule">
) {
  startControlPlane();
  worker.schedule();
}

function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function settleWithin(operation: Promise<unknown>, timeoutMs: number) {
  positiveInteger(timeoutMs, "resync stop timeout");
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    operation.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      () => {
        clearTimeout(timeout);
        resolve();
      }
    );
  });
}
