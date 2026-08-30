import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicJsonCommitUncertainError } from "../mesh/mesh-store-file";
import {
  StorageHeadroomManager,
  type StorageHeadroomBackgroundTask
} from "./storage-headroom-manager";

const managers: StorageHeadroomManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
});

describe("StorageHeadroomManager", () => {
  it("preallocates the production 64 MiB reserve once without normal-write amplification", async () => {
    const preallocate = vi.fn(async (_path: string, bytes: number) => bytes);
    const release = vi.fn(async () => undefined);
    const manager = createManager({ preallocate, release });

    await manager.initialize();
    for (let index = 0; index < 20; index += 1) {
      await expect(manager.runWithHeadroom(async () => index)).resolves.toBe(index);
    }

    expect(preallocate).toHaveBeenCalledTimes(1);
    expect(preallocate).toHaveBeenCalledWith("/data/automation-storage.reserve", 64 * 1024 * 1024);
    expect(release).not.toHaveBeenCalled();
    expect(manager.snapshot()).toEqual({
      status: "available",
      counters: {
        normalWriteCount: 20,
        enospcCount: 0,
        retryCount: 0,
        releaseCount: 0,
        preallocationCount: 1,
        preallocatedBytes: 64 * 1024 * 1024,
        replenishAttemptCount: 0,
        replenishFailureCount: 0
      }
    });
  });

  it("releases once on actual ENOSPC, retries, and replenishes only in the scheduled background task", async () => {
    const tasks: StorageHeadroomBackgroundTask[] = [];
    const preallocate = vi.fn(async (_path: string, bytes: number) => bytes);
    const release = vi.fn(async () => undefined);
    const manager = createManager({
      preallocate,
      release,
      scheduleBackground: (task) => { tasks.push(task); return tasks.length; }
    });
    await manager.initialize();
    let attempts = 0;

    await expect(manager.runWithHeadroom(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return "committed";
    })).resolves.toBe("committed");

    expect(release).toHaveBeenCalledTimes(1);
    expect(preallocate).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(1);
    expect(manager.snapshot().status).toBe("released");

    await tasks[0]!();

    expect(preallocate).toHaveBeenCalledTimes(2);
    expect(manager.snapshot()).toMatchObject({
      status: "available",
      counters: { retryCount: 1, releaseCount: 1, replenishAttemptCount: 1 }
    });
  });

  it("shares one released reserve across state and outbox ENOSPC retries in the same exhaustion incident", async () => {
    const tasks: StorageHeadroomBackgroundTask[] = [];
    const release = vi.fn(async () => undefined);
    const manager = createManager({
      release,
      scheduleBackground: (task) => { tasks.push(task); return tasks.length; }
    });
    await manager.initialize();
    let stateAttempts = 0;
    let outboxAttempts = 0;

    await expect(manager.runWithHeadroom(async () => {
      stateAttempts += 1;
      if (stateAttempts === 1) throw Object.assign(new Error("state full"), { code: "ENOSPC" });
      return "state committed";
    })).resolves.toBe("state committed");
    await expect(manager.runWithHeadroom(async () => {
      outboxAttempts += 1;
      if (outboxAttempts === 1) throw Object.assign(new Error("outbox full"), { code: "ENOSPC" });
      return "outbox committed";
    })).resolves.toBe("outbox committed");

    expect(release).toHaveBeenCalledTimes(1);
    expect(manager.snapshot()).toMatchObject({
      status: "released",
      counters: { enospcCount: 2, retryCount: 2, releaseCount: 1 }
    });
    expect(tasks).toHaveLength(1);
  });

  it("preserves typed commit uncertainty without releasing headroom", async () => {
    const release = vi.fn(async () => undefined);
    const manager = createManager({ release });
    await manager.initialize();
    const uncertain = new AtomicJsonCommitUncertainError("/data/outbox.json", {
      cause: Object.assign(new Error("directory fsync full"), { code: "ENOSPC" })
    });

    await expect(manager.runWithHeadroom(async () => { throw uncertain; })).rejects.toBe(uncertain);

    expect(release).not.toHaveBeenCalled();
    expect(manager.snapshot()).toMatchObject({
      status: "available",
      counters: { enospcCount: 0, retryCount: 0, releaseCount: 0 }
    });
  });

  it("keeps a successful retry committed when background replenishment fails", async () => {
    const tasks: StorageHeadroomBackgroundTask[] = [];
    let allocations = 0;
    const manager = createManager({
      preallocate: async (_path, bytes) => {
        allocations += 1;
        if (allocations > 1) throw Object.assign(new Error("still full"), { code: "ENOSPC" });
        return bytes;
      },
      scheduleBackground: (task) => { tasks.push(task); return tasks.length; }
    });
    await manager.initialize();
    let attempts = 0;

    const result = await manager.runWithHeadroom(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return "visible-target";
    });
    await expect(tasks[0]!()).resolves.toBeUndefined();

    expect(result).toBe("visible-target");
    expect(manager.snapshot()).toMatchObject({
      status: "released",
      counters: { retryCount: 1, replenishAttemptCount: 1, replenishFailureCount: 1 }
    });
  });
});

function createManager(options: Partial<ConstructorParameters<typeof StorageHeadroomManager>[2]> = {}) {
  const manager = new StorageHeadroomManager(
    "/data/automation-storage.reserve",
    64 * 1024 * 1024,
    {
      preallocate: async (_path, bytes) => bytes,
      release: async () => undefined,
      getFreeBytes: async () => 256 * 1024 * 1024,
      scheduleBackground: () => 1,
      cancelBackground: () => undefined,
      ...options
    }
  );
  managers.push(manager);
  return manager;
}
