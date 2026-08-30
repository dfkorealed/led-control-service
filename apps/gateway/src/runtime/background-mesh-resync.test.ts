import { describe, expect, it, vi } from "vitest";
import {
  BackgroundMeshResyncWorker,
  TargetedLightingResyncQueue,
  startControlPlaneWithBackgroundMeshResync
} from "./background-mesh-resync";

const completeReport = {
  total: 1_000,
  configured: 1_000,
  observed: 1_000,
  healthPending: 1_000,
  timedOut: 0,
  failed: 0
};

describe("BackgroundMeshResyncWorker", () => {
  it("makes the control plane available without awaiting a slow 1,000-fixture resync", async () => {
    const resync = deferred<typeof completeReport>();
    const onReport = vi.fn().mockResolvedValue(undefined);
    const worker = new BackgroundMeshResyncWorker({ run: () => resync.promise, onReport });
    const startControlPlane = vi.fn();

    startControlPlaneWithBackgroundMeshResync(startControlPlane, worker);

    expect(startControlPlane).toHaveBeenCalledTimes(1);
    expect(worker.readiness).toBe("pending");
    expect(onReport).not.toHaveBeenCalled();

    resync.resolve(completeReport);
    await worker.stopAndDrain();
    expect(worker.readiness).toBe("ready");
    expect(onReport).toHaveBeenCalledWith(completeReport);
  });

  it("isolates an adapter or address-store failure and recovers on a later request", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("address store unavailable"))
      .mockResolvedValueOnce(completeReport);
    const onError = vi.fn().mockRejectedValueOnce(new Error("health reporting unavailable"));
    const worker = new BackgroundMeshResyncWorker({ run, onReport: vi.fn(), onError });

    worker.schedule();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(worker.readiness).toBe("failed");

    worker.schedule();
    await vi.waitFor(() => expect(worker.readiness).toBe("ready"));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drains an in-flight resync on shutdown and rejects new work", async () => {
    const resync = deferred<typeof completeReport>();
    const run = vi.fn(() => resync.promise);
    const worker = new BackgroundMeshResyncWorker({ run, onReport: vi.fn() });
    worker.schedule();
    let drained = false;

    const stopping = worker.stopAndDrain().then(() => { drained = true; });
    expect(worker.schedule()).toBe(false);
    expect(drained).toBe(false);

    resync.resolve(completeReport);
    await stopping;
    expect(drained).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("coalesces duplicate startup and connect requests while one full resync is running", async () => {
    const resync = deferred<typeof completeReport>();
    const run = vi.fn(() => resync.promise);
    const worker = new BackgroundMeshResyncWorker({ run, onReport: vi.fn() });

    worker.schedule();
    worker.schedule();
    resync.resolve(completeReport);
    await vi.waitFor(() => expect(worker.readiness).toBe("ready"));

    expect(run).toHaveBeenCalledTimes(1);
    await worker.stopAndDrain();
  });

  it("aborts a never-settling resync and bounds shutdown drain time", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const worker = new BackgroundMeshResyncWorker({
        run: (nextSignal) => {
          signal = nextSignal;
          return new Promise<never>(() => undefined);
        },
        onReport: vi.fn(),
        stopTimeoutMs: 100
      });
      worker.schedule();

      const stopping = worker.stopAndDrain();
      expect(signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      await expect(stopping).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a 1,000-fixture offline resync at a fixture boundary on shutdown", async () => {
    vi.useFakeTimers();
    try {
      let started = 0;
      const worker = new BackgroundMeshResyncWorker({
        run: async (signal) => {
          for (let index = 0; index < 1_000; index += 1) {
            if (signal.aborted) break;
            started += 1;
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          return { ...completeReport, configured: started, observed: 0, timedOut: started };
        },
        onReport: vi.fn(),
        stopTimeoutMs: 100
      });
      worker.schedule();
      await vi.advanceTimersByTimeAsync(1);

      const stopping = worker.stopAndDrain();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(started).toBeLessThan(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TargetedLightingResyncQueue", () => {
  it("retries with backoff until a lighting observation releases the fence", async () => {
    vi.useFakeTimers();
    try {
      const fixtureId = "00000000-0000-4000-8000-000000000101";
      let queue!: TargetedLightingResyncQueue;
      const run = vi.fn()
        .mockRejectedValueOnce(new Error("BlueZ temporarily unavailable"))
        .mockImplementationOnce(async (fixtureIds: string[]) => {
          queue.markObserved(fixtureIds[0]);
          return { ...completeReport, total: 1, configured: 1, observed: 1, healthPending: 0 };
        });
      queue = new TargetedLightingResyncQueue({
        run,
        retryBaseMs: 100,
        retryMaxMs: 1_000,
        onError: vi.fn()
      });

      expect(queue.request([fixtureId])).toBe(true);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(queue.pendingCount).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      expect(queue.pendingCount).toBe(0);
      await queue.stopAndDrain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates an offline first batch so a later fixture can be observed", async () => {
    vi.useFakeTimers();
    try {
      const offlineFixtureIds = Array.from({ length: 64 }, (_, index) => `offline-${index + 1}`);
      const laterFixtureId = "online-65";
      let queue!: TargetedLightingResyncQueue;
      const run = vi.fn(async (fixtureIds: string[]) => {
        if (fixtureIds.includes(laterFixtureId)) queue.markObserved(laterFixtureId);
        return {
          ...completeReport,
          total: fixtureIds.length,
          configured: fixtureIds.length,
          observed: fixtureIds.includes(laterFixtureId) ? 1 : 0,
          healthPending: 0,
          timedOut: fixtureIds.includes(laterFixtureId) ? fixtureIds.length - 1 : fixtureIds.length
        };
      });
      queue = new TargetedLightingResyncQueue({
        run,
        maxBatchSize: 64,
        retryBaseMs: 100,
        retryMaxMs: 1_000
      });

      expect(queue.request([...offlineFixtureIds, laterFixtureId])).toBe(true);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0]).toEqual(offlineFixtureIds);

      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

      expect(run.mock.calls[1]?.[0]).toContain(laterFixtureId);
      expect(queue.pendingCount).toBe(64);
      await queue.stopAndDrain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds pending fixture requests", () => {
    const queue = new TargetedLightingResyncQueue({
      run: vi.fn(),
      maxPendingFixtures: 1
    });

    expect(queue.request(["fixture-1", "fixture-2"])).toBe(false);
    expect(queue.pendingCount).toBe(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
