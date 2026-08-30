import { SerialTaskQueue } from "../runtime/serial-task-queue";
import {
  automationTelemetryGapRecordsHash,
  FileAutomationStateStore
} from "./automation-state-store";
import {
  AutomationTelemetryOutbox,
  type AutomationTelemetryAppendBatchResult
} from "./automation-telemetry-outbox";

const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

type RetryTask = () => Promise<void>;

interface AutomationTelemetryCoordinatorOptions {
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  scheduleRetry?: (task: RetryTask, delayMs: number) => unknown;
  cancelRetry?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
  onRetryChanged?: () => void | Promise<void>;
}

export class AutomationTelemetryCoordinator {
  private readonly queue = new SerialTaskQueue();
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly scheduleRetry: NonNullable<AutomationTelemetryCoordinatorOptions["scheduleRetry"]>;
  private readonly cancelRetry: NonNullable<AutomationTelemetryCoordinatorOptions["cancelRetry"]>;
  private readonly onError: (error: unknown) => void;
  private readonly onRetryChanged: NonNullable<AutomationTelemetryCoordinatorOptions["onRetryChanged"]>;
  private retryDelayMs: number;
  private retryHandle: unknown;
  private retryScheduled = false;
  private retryRevision: number | null = null;
  private stopped = false;

  constructor(
    private readonly stateStore: FileAutomationStateStore,
    private readonly outbox: AutomationTelemetryOutbox,
    options: AutomationTelemetryCoordinatorOptions = {}
  ) {
    this.retryInitialDelayMs = options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    if (!Number.isSafeInteger(this.retryInitialDelayMs) || this.retryInitialDelayMs <= 0 ||
      !Number.isSafeInteger(this.retryMaxDelayMs) || this.retryMaxDelayMs < this.retryInitialDelayMs) {
      throw new Error("invalid automation telemetry coordinator retry bounds");
    }
    this.retryDelayMs = this.retryInitialDelayMs;
    this.scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry;
    this.cancelRetry = options.cancelRetry ?? defaultCancelRetry;
    this.onError = options.onError ?? (() => undefined);
    this.onRetryChanged = options.onRetryChanged ?? (() => undefined);
  }

  flush(revision: number | null = null) {
    return this.queue.run(async () => {
      if (revision !== null) this.retryRevision = revision;
      const results: AutomationTelemetryAppendBatchResult[] = [];
      let changed = false;
      const retainedGap = await this.stateStore.retryRetainedTelemetryGap();
      if (retainedGap) {
        if (!retainedGap.accepted) {
          this.deferCleanup(retainedGap.error ?? new Error("automation telemetry gap acceptance pending"));
          return { handoffs: results, changed, retryScheduled: this.retryScheduled };
        }
        changed = true;
      }
      changed = await this.outbox.recoverGapJournal() || changed;

      while (true) {
        const handoff = this.stateStore.read().pendingTelemetryHandoffs[0];
        if (!handoff) break;
        const result = await this.outbox.appendBatch(handoff);
        results.push(result);
        changed = true;
        try {
          await this.stateStore.completeTelemetryHandoff(handoff.handoffId, handoff.recordsHash);
        } catch (error) {
          this.deferCleanup(error);
          return { handoffs: results, changed, retryScheduled: this.retryScheduled };
        }
        await this.outbox.releaseHandoff(handoff.handoffId, handoff.recordsHash);
      }

      if (revision !== null) {
        const gap = this.stateStore.read().telemetryGap;
        if (gap) {
          const recordsHash = automationTelemetryGapRecordsHash(revision, gap);
          await this.outbox.recordGap({ revision, recordsHash, ...gap });
          try {
            await this.stateStore.clearTelemetryGap(gap);
          } catch (error) {
            changed = true;
            this.deferCleanup(error);
            return { handoffs: results, changed, retryScheduled: this.retryScheduled };
          }
          await this.outbox.releaseHandoff(gap.handoffId, recordsHash);
          changed = true;
        }
      }

      const active = this.stateStore.read();
      const reconciled = await this.outbox.reconcileHandoffReceipts([
        ...active.pendingTelemetryHandoffs.map((handoff) => handoff.handoffId),
        ...(active.telemetryGap ? [active.telemetryGap.handoffId] : [])
      ]);
      this.resetRetry();
      return { handoffs: results, changed: changed || reconciled, retryScheduled: false };
    });
  }

  recordGap(
    revision: number | null,
    firstDroppedAt: string,
    droppedCount: number,
    lastDroppedAt: string
  ) {
    return this.queue.run(async () => {
      if (revision !== null) this.retryRevision = revision;
      const acceptance = await this.stateStore.recordTelemetryGap(
        firstDroppedAt,
        droppedCount,
        lastDroppedAt,
        revision
      );
      if (!acceptance.accepted) {
        this.deferCleanup(acceptance.error ?? new Error("automation telemetry gap acceptance pending"));
        return false;
      }
      if (acceptance.acceptance === "journal") {
        this.deferCleanup(acceptance.error ?? new Error("automation telemetry gap state cleanup pending"));
        return true;
      }
      if (revision === null) return false;
      const gap = acceptance.gap;
      const recordsHash = automationTelemetryGapRecordsHash(revision, gap);
      try {
        await this.outbox.recordGap({ revision, recordsHash, ...gap });
        const result = await this.stateStore.clearTelemetryGap(gap);
        if (result.cleared) await this.outbox.releaseHandoff(gap.handoffId, recordsHash);
        return result.cleared;
      } catch (error) {
        this.deferCleanup(error);
        return false;
      }
    });
  }

  stop() {
    this.stopped = true;
    this.resetRetry();
  }

  private deferCleanup(error: unknown) {
    this.onError(error);
    if (this.stopped || this.retryScheduled) return;
    const delayMs = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryMaxDelayMs, delayMs * 2);
    this.retryScheduled = true;
    this.retryHandle = this.scheduleRetry(async () => {
      this.retryScheduled = false;
      this.retryHandle = undefined;
      try {
        const result = await this.flush(this.retryRevision);
        if (result.changed) await this.onRetryChanged();
      } catch (retryError) {
        this.deferCleanup(retryError);
      }
    }, delayMs);
  }

  private resetRetry() {
    if (this.retryScheduled) this.cancelRetry(this.retryHandle);
    this.retryHandle = undefined;
    this.retryScheduled = false;
    this.retryDelayMs = this.retryInitialDelayMs;
  }
}

function defaultScheduleRetry(task: RetryTask, delayMs: number) {
  const timer = setTimeout(() => void task(), delayMs);
  timer.unref();
  return timer;
}

function defaultCancelRetry(handle: unknown) {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
