import { createHash } from "node:crypto";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import { FileAutomationStateStore } from "./automation-state-store";
import {
  AutomationTelemetryOutbox,
  type AutomationTelemetryAppendBatchResult
} from "./automation-telemetry-outbox";

export class AutomationTelemetryCoordinator {
  private readonly queue = new SerialTaskQueue();

  constructor(
    private readonly stateStore: FileAutomationStateStore,
    private readonly outbox: AutomationTelemetryOutbox
  ) {}

  flush(revision: number | null = null) {
    return this.queue.run(async () => {
      const results: AutomationTelemetryAppendBatchResult[] = [];
      let changed = await this.outbox.recoverGapJournal();

      while (true) {
        const handoff = this.stateStore.read().pendingTelemetryHandoffs[0];
        if (!handoff) break;
        const result = await this.outbox.appendBatch(handoff);
        await this.stateStore.completeTelemetryHandoff(handoff.handoffId, handoff.recordsHash);
        await this.outbox.releaseHandoff(handoff.handoffId, handoff.recordsHash);
        results.push(result);
        changed = true;
      }

      if (revision !== null) {
        const gap = this.stateStore.read().telemetryGap;
        if (gap) {
          const recordsHash = gapRecordsHash(revision, gap);
          await this.outbox.recordGap({ revision, recordsHash, ...gap });
          await this.stateStore.clearTelemetryGap(gap);
          await this.outbox.releaseHandoff(gap.handoffId, recordsHash);
          changed = true;
        }
      }

      const active = this.stateStore.read();
      const reconciled = await this.outbox.reconcileHandoffReceipts([
        ...active.pendingTelemetryHandoffs.map((handoff) => handoff.handoffId),
        ...(active.telemetryGap ? [active.telemetryGap.handoffId] : [])
      ]);
      return { handoffs: results, changed: changed || reconciled };
    });
  }

  recordGap(
    revision: number | null,
    firstDroppedAt: string,
    droppedCount: number,
    lastDroppedAt: string
  ) {
    return this.queue.run(async () => {
      await this.stateStore.recordTelemetryGap(firstDroppedAt, droppedCount, lastDroppedAt);
      if (revision === null) return false;
      const gap = this.stateStore.read().telemetryGap!;
      const recordsHash = gapRecordsHash(revision, gap);
      await this.outbox.recordGap({ revision, recordsHash, ...gap });
      const cleared = await this.stateStore.clearTelemetryGap(gap);
      if (cleared) await this.outbox.releaseHandoff(gap.handoffId, recordsHash);
      return cleared;
    });
  }
}

function gapRecordsHash(
  revision: number,
  gap: ReturnType<FileAutomationStateStore["read"]>["telemetryGap"] & {}
) {
  return `sha256:${createHash("sha256").update(JSON.stringify({ revision, ...gap })).digest("hex")}`;
}
