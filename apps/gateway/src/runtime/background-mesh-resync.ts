import type { BleMeshResyncReport } from "../gateway";

interface BackgroundMeshResyncOptions {
  run: () => Promise<BleMeshResyncReport>;
  onReport: (report: BleMeshResyncReport) => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
}

export class BackgroundMeshResyncWorker {
  private current: Promise<void> | null = null;
  private rerunRequested = false;
  private stopping = false;
  private state: "pending" | "ready" | "failed" = "pending";

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

  stopAndDrain() {
    this.stopping = true;
    this.rerunRequested = false;
    return this.current ?? Promise.resolve();
  }

  private async drain() {
    do {
      this.rerunRequested = false;
      try {
        const report = await this.options.run();
        await this.options.onReport(report);
        this.state = "ready";
      } catch (error) {
        this.state = "failed";
        try {
          await this.options.onError?.(error);
        } catch {
          // Resync and readiness reporting failures must not escape the background worker.
        }
      }
    } while (this.rerunRequested && !this.stopping);
  }
}

export function startControlPlaneWithBackgroundMeshResync(
  startControlPlane: () => void,
  worker: Pick<BackgroundMeshResyncWorker, "schedule">
) {
  startControlPlane();
  worker.schedule();
}
