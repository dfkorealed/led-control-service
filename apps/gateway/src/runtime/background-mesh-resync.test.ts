import { describe, expect, it, vi } from "vitest";
import { BackgroundMeshResyncWorker, startControlPlaneWithBackgroundMeshResync } from "./background-mesh-resync";

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
