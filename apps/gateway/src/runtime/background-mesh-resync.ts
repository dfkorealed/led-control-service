import type { BleMeshResyncReport } from "../gateway";

interface BackgroundMeshResyncOptions {
  run: (signal: AbortSignal) => Promise<BleMeshResyncReport>;
  onReport: (report: BleMeshResyncReport) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
  retryBaseMs?: number;
  retryMaxMs?: number;
  stopTimeoutMs?: number;
}

interface TargetedLightingResyncOptions {
  run: (fixtureIds: string[], signal: AbortSignal) => Promise<BleMeshResyncReport>;
  onError?: (error: unknown) => Promise<void> | void;
  onPassComplete?: () => Promise<void> | void;
  maxPendingFixtures?: number;
  maxBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  stopTimeoutMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;

export class BackgroundMeshResyncWorker {
  private current: Promise<void> | null = null;
  private rerunRequested = false;
  private stopping = false;
  private state: "pending" | "ready" | "failed" = "pending";
  private controller: AbortController | null = null;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  constructor(private readonly options: BackgroundMeshResyncOptions) {
    this.retryBaseMs = positiveInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, "full resync retry base");
    this.retryMaxMs = positiveInteger(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, "full resync retry maximum");
    if (this.retryMaxMs < this.retryBaseMs) throw new Error("full resync retry maximum must cover its base");
  }

  get readiness() {
    return this.state;
  }

  schedule(rerunIfActive = false) {
    if (this.stopping) return false;
    if (this.current) {
      if (rerunIfActive) this.rerunRequested = true;
      return true;
    }
    this.clearRetry();
    this.current = this.drain().finally(() => {
      this.current = null;
    });
    return true;
  }

  async stopAndDrain() {
    this.stopping = true;
    this.rerunRequested = false;
    this.clearRetry();
    this.controller?.abort();
    if (this.current) {
      await settleWithin(this.current, this.options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    }
  }

  private async drain() {
    let retryNeeded = false;
    do {
      this.rerunRequested = false;
      const controller = new AbortController();
      this.controller = controller;
      try {
        const report = await this.options.run(controller.signal);
        await this.options.onReport(report);
        this.state = "ready";
        retryNeeded = report.timedOut > 0 || report.failed > 0;
        if (!retryNeeded) this.retryAttempt = 0;
      } catch (error) {
        if (controller.signal.aborted && this.stopping) return;
        this.state = "failed";
        retryNeeded = true;
        try {
          await this.options.onError?.(error);
        } catch {
          // Resync and readiness reporting failures must not escape the background worker.
        }
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    } while (this.rerunRequested && !this.stopping);
    if (retryNeeded) this.armRetry();
  }

  private armRetry() {
    if (this.retryTimer || this.stopping) return;
    const delayMs = Math.min(this.retryBaseMs * (2 ** this.retryAttempt), this.retryMaxMs);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedule();
    }, delayMs);
    this.retryTimer.unref();
  }

  private clearRetry() {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
  private preferredNextFixtureId: string | null = null;

  constructor(private readonly options: TargetedLightingResyncOptions) {
    this.maxPendingFixtures = positiveInteger(options.maxPendingFixtures ?? 4_096, "targeted resync capacity");
    this.maxBatchSize = positiveInteger(options.maxBatchSize ?? 64, "targeted resync batch size");
    this.retryBaseMs = positiveInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, "targeted resync retry base");
    this.retryMaxMs = positiveInteger(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, "targeted resync retry maximum");
    if (this.retryMaxMs < this.retryBaseMs) throw new Error("targeted resync retry maximum must cover its base");
  }

  get pendingCount() {
    return this.pending.size;
  }

  request(fixtureIds: string[]) {
    if (this.stopping) return false;
    const unique = [...new Set(fixtureIds)];
    if (unique.length === 0 || unique.some((fixtureId) => fixtureId.length === 0)) return false;
    const additions = unique.filter((fixtureId) => !this.pending.has(fixtureId));
    const accepted = additions.slice(0, Math.max(0, this.maxPendingFixtures - this.pending.size));
    for (const fixtureId of accepted) this.pending.add(fixtureId);
    this.preferredNextFixtureId ??= additions[accepted.length] ?? null;
    if (accepted.length > 0) this.kick();
    return accepted.length === additions.length;
  }

  requeuePendingFixtures(fixtureIds: readonly string[]) {
    if (this.stopping) return false;
    const unique = [...new Set(fixtureIds)];
    if (unique.some((fixtureId) => fixtureId.length === 0)) return false;
    if (unique.length === 0) {
      this.pending.clear();
      this.preferredNextFixtureId = null;
      this.retryAttempt = 0;
      this.clearRetry();
      return true;
    }

    const currentFirst = this.pending.values().next().value as string | undefined;
    const preferred = this.preferredNextFixtureId ?? currentFirst;
    const preferredIndex = preferred ? unique.indexOf(preferred) : -1;
    const startIndex = preferredIndex >= 0 ? preferredIndex : 0;
    const selectedCount = Math.min(unique.length, this.maxPendingFixtures);
    const selected = Array.from(
      { length: selectedCount },
      (_, offset) => unique[(startIndex + offset) % unique.length]!
    );

    this.pending.clear();
    for (const fixtureId of selected) this.pending.add(fixtureId);
    this.preferredNextFixtureId = null;
    this.kick();
    return true;
  }

  markObserved(fixtureId: string) {
    this.pending.delete(fixtureId);
    if (this.preferredNextFixtureId === fixtureId) this.preferredNextFixtureId = null;
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
    const unresolvedFixtureIds = fixtureIds.filter((fixtureId) => this.pending.has(fixtureId));
    // Set iteration is insertion ordered. Reinsert only unresolved members so an offline batch
    // cannot keep every later recovery fence behind the same first 64 fixtures.
    for (const fixtureId of unresolvedFixtureIds) {
      this.pending.delete(fixtureId);
      this.pending.add(fixtureId);
    }
    try {
      await this.options.onPassComplete?.();
    } catch (error) {
      failed = true;
      try {
        await this.options.onError?.(error);
      } catch {
        // Source refresh retries with the same bounded queue backoff.
      }
    }
    if (failed || unresolvedFixtureIds.length > 0) this.armRetry();
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

export function requestFixtureObservationResync(
  fixtureIds: string[],
  targeted: Pick<TargetedLightingResyncQueue, "request">,
  full: Pick<BackgroundMeshResyncWorker, "schedule">
) {
  if (targeted.request(fixtureIds)) return true;
  if (full.schedule(true)) return true;
  throw new Error("fixture observation resync is unavailable");
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
