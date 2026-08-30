import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VehicleSensorCapabilityJournal,
  VehicleSensorCapabilityPublisher,
  VehicleSensorGatewayController,
  type ConfirmedVehicleSensorSource,
  type VehicleSensorClient,
  type VehicleSensorDiagnostic
} from "./vehicle-sensor-client";
import { AtomicJsonCommitUncertainError, writeJsonAtomic } from "./mesh-store-file";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";

afterEach(() => vi.useRealTimers());

describe("VehicleSensorGatewayController capability refresh batches", () => {
  it("retains a failed initial enqueue in memory and automatically recovers with bounded retry", async () => {
    vi.useFakeTimers();
    const path = await journalPath();
    let failNextJournalWrite = false;
    const journal = new VehicleSensorCapabilityJournal(path, scope(), {
      write: async (target, value) => {
        if (failNextJournalWrite && target === path) {
          failNextJournalWrite = false;
          throw Object.assign(new Error("private ENOSPC path"), { code: "ENOSPC" });
        }
        await writeJsonAtomic(target, value);
      }
    });
    const source = createSources(1)[0]!;
    const diagnostics: VehicleSensorDiagnostic[] = [];
    const configureSource = vi.fn(async () => supportedBinding());
    const controller = createController(journal, [source], configureSource, diagnostics);
    await controller.initialize();
    failNextJournalWrite = true;

    await expect(controller.requestCapabilityRefresh(source.meshNodeId))
      .rejects.toThrow("vehicle_sensor_capability_refresh_pending");
    expect(configureSource).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual({
      event: "vehicle_sensor_capability_refresh_failed",
      meshNodeId: source.meshNodeId
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(configureSource).toHaveBeenCalledTimes(1));
    expect(await journal.pendingRefreshNodeIds()).toEqual([]);
    expect((await journal.current(source.meshNodeId))?.report.capabilityRevision).toBe(1);
    expect(diagnostics).toContainEqual({
      event: "vehicle_sensor_capability_refresh_recovered",
      meshNodeId: source.meshNodeId
    });
    await controller.stopAndDrain();
  });

  it("drains an active enqueue retry during shutdown and does not start Config afterwards", async () => {
    vi.useFakeTimers();
    const path = await journalPath();
    const blockedWrite = deferred<void>();
    let writeAttempt = 0;
    let blockRetry = false;
    const journal = new VehicleSensorCapabilityJournal(path, scope(), {
      write: async (target, value) => {
        if (target === path && blockRetry) {
          writeAttempt += 1;
          if (writeAttempt === 1) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
          await blockedWrite.promise;
        }
        await writeJsonAtomic(target, value);
      }
    });
    const source = createSources(1)[0]!;
    const configureSource = vi.fn(async () => supportedBinding());
    const controller = createController(journal, [source], configureSource);
    await controller.initialize();
    blockRetry = true;
    await expect(controller.requestCapabilityRefresh(source.meshNodeId)).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(writeAttempt).toBe(2));
    const stopping = controller.stopAndDrain();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    blockedWrite.resolve();
    await stopping;
    expect(configureSource).not.toHaveBeenCalled();
    expect(await journal.pendingRefreshNodeIds()).toEqual([source.meshNodeId]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off failed volatile enqueue retries to the configured maximum without duplicate timers", async () => {
    vi.useFakeTimers();
    const path = await journalPath();
    let attempts = 0;
    const journal = new VehicleSensorCapabilityJournal(path, scope(), {
      write: async (target, value) => {
        const candidate = value as { records?: unknown[]; refreshPendingNodeIds?: string[] };
        const enqueueCommit = candidate.records?.length === 0 && candidate.refreshPendingNodeIds?.length === 1;
        if (target === path && attempts > 0 && enqueueCommit) {
          attempts += 1;
          if (attempts <= 4) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        }
        await writeJsonAtomic(target, value);
      }
    });
    const source = createSources(1)[0]!;
    const configureSource = vi.fn(async () => supportedBinding());
    const controller = createController(journal, [source], configureSource);
    await controller.initialize();
    attempts = 1;
    await expect(controller.requestCapabilityRefresh(source.meshNodeId)).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(9);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(19);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(4);
    await vi.advanceTimersByTimeAsync(29);
    expect(attempts).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(configureSource).toHaveBeenCalledTimes(1));
    expect(attempts).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    await controller.stopAndDrain();
  });

  it("does not queue a stale retry behind an already accepted serial refresh", async () => {
    vi.useFakeTimers();
    const path = await journalPath();
    const secondConfiguration = deferred<ReturnType<typeof supportedBinding>>();
    const source = createSources(1)[0]!;
    const journal = new VehicleSensorCapabilityJournal(path, scope());
    const configureSource = vi.fn()
      .mockRejectedValueOnce(new Error("first Config failure"))
      .mockImplementationOnce(() => secondConfiguration.promise)
      .mockResolvedValue(supportedBinding());
    const controller = createController(journal, [source], configureSource);
    await controller.initialize();

    const first = controller.refreshCapabilities();
    const second = controller.refreshCapabilities();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(configureSource).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    secondConfiguration.resolve(supportedBinding());
    await second;
    await controller.refreshCapabilities();

    expect(configureSource).toHaveBeenCalledTimes(3);
    await controller.stopAndDrain();
  });

  it("uses a constant journal rewrite count and linear bytes for 100 and 1000 configured nodes", async () => {
    const hundred = await measureRefreshCost(100);
    const thousand = await measureRefreshCost(1_000);

    expect(hundred.writeCount).toBe(2);
    expect(thousand.writeCount).toBe(2);
    expect(thousand.bytesWritten).toBeGreaterThan(hundred.bytesWritten * 8);
    expect(thousand.bytesWritten).toBeLessThan(hundred.bytesWritten * 12);
  }, 15_000);

  it("keeps only failed nodes pending and preserves unchanged revisions across restart", async () => {
    const path = await journalPath();
    const [firstSource, secondSource] = createSources(2);
    const firstJournal = new VehicleSensorCapabilityJournal(path, scope());
    const firstConfigure = vi.fn(async (source: ConfirmedVehicleSensorSource) => {
      if (source.meshNodeId === firstSource!.meshNodeId) throw new Error("private Config failure");
      return supportedBinding();
    });
    const firstController = createController(firstJournal, [firstSource!, secondSource!], firstConfigure);
    await firstController.initialize();
    await firstController.refreshCapabilities();

    const secondRecord = await firstJournal.current(secondSource!.meshNodeId);
    expect(await firstJournal.current(firstSource!.meshNodeId)).toBeNull();
    expect(secondRecord?.report.capabilityRevision).toBe(1);
    expect(await firstJournal.pendingRefreshNodeIds()).toEqual([firstSource!.meshNodeId]);
    await firstController.stopAndDrain();

    const restartedJournal = new VehicleSensorCapabilityJournal(path, scope());
    const restartedConfigure = vi.fn(async () => supportedBinding());
    const restartedController = createController(
      restartedJournal,
      [firstSource!, secondSource!],
      restartedConfigure
    );
    await restartedController.initialize();
    await restartedController.refreshCapabilities();

    expect((await restartedJournal.current(firstSource!.meshNodeId))?.report.capabilityRevision).toBe(1);
    expect(await restartedJournal.current(secondSource!.meshNodeId)).toEqual(secondRecord);
    expect(await restartedJournal.pendingRefreshNodeIds()).toEqual([]);
    expect(restartedConfigure).toHaveBeenCalledTimes(2);
    await restartedController.stopAndDrain();
  });

  it("keeps global health degraded until the last partially failed node recovers", async () => {
    const path = await journalPath();
    const [firstSource, secondSource] = createSources(2);
    const diagnostics: VehicleSensorDiagnostic[] = [];
    let round = 1;
    const configureSource = vi.fn(async (source: ConfirmedVehicleSensorSource) => {
      if (round === 1 || (round === 2 && source.meshNodeId === secondSource!.meshNodeId)) {
        throw new Error("Config failure");
      }
      return supportedBinding();
    });
    const journal = new VehicleSensorCapabilityJournal(path, scope());
    const controller = createController(journal, [firstSource!, secondSource!], configureSource, diagnostics);
    await controller.initialize();
    await controller.refreshCapabilities();
    round = 2;
    await controller.refreshCapabilities();

    expect(await journal.pendingRefreshNodeIds()).toEqual([secondSource!.meshNodeId]);
    expect(diagnostics.filter(({ event }) => event === "vehicle_sensor_capability_refresh_recovered"))
      .toEqual([]);

    round = 3;
    await controller.requestCapabilityRefresh(secondSource!.meshNodeId);
    expect(diagnostics.filter(({ event }) => event === "vehicle_sensor_capability_refresh_recovered"))
      .toEqual([{
        event: "vehicle_sensor_capability_refresh_recovered",
        meshNodeId: secondSource!.meshNodeId
      }]);
    await controller.stopAndDrain();
  });
});

describe("VehicleSensorCapabilityJournal atomic batches", () => {
  it("adopts an exact next batch after commit uncertainty", async () => {
    const path = await journalPath();
    let uncertain = false;
    const journal = new VehicleSensorCapabilityJournal(path, scope(), {
      write: async (target, value) => {
        await writeJsonAtomic(target, value);
        if (uncertain && target === path) throw new AtomicJsonCommitUncertainError(target);
      }
    });
    const sources = createSources(2);
    await journal.initialize();
    await journal.requestRefreshBatch(sources.map(({ meshNodeId }) => meshNodeId));
    uncertain = true;

    const result = await journal.recordBindingsAndCompleteBatch(sources.map(bindingInput));

    expect(result.changedNodeIds).toEqual(sources.map(({ meshNodeId }) => meshNodeId));
    expect(await journal.pendingRefreshNodeIds()).toEqual([]);
    expect((await journal.current(sources[0]!.meshNodeId))?.report.capabilityRevision).toBe(1);
  });

  it("retains the previous batch target when uncertainty happens before rename", async () => {
    const path = await journalPath();
    let uncertain = false;
    const journal = new VehicleSensorCapabilityJournal(path, scope(), {
      write: async (target, value) => {
        if (uncertain && target === path) throw new AtomicJsonCommitUncertainError(target);
        await writeJsonAtomic(target, value);
      }
    });
    const sources = createSources(2);
    await journal.initialize();
    await journal.requestRefreshBatch(sources.map(({ meshNodeId }) => meshNodeId));
    uncertain = true;

    await expect(journal.recordBindingsAndCompleteBatch(sources.map(bindingInput)))
      .rejects.toThrow("vehicle_sensor_capability_commit_uncertain");
    expect(await journal.pendingRefreshNodeIds()).toEqual(sources.map(({ meshNodeId }) => meshNodeId));
    expect(await journal.current(sources[0]!.meshNodeId)).toBeNull();
  });

  it("fences an unknown batch target after commit uncertainty", async () => {
    const path = await journalPath();
    let uncertain = false;
    const journal = new VehicleSensorCapabilityJournal(path, scope(), {
      write: async (target, value) => {
        if (uncertain && target === path) {
          await writeJsonAtomic(target, { version: 99 });
          throw new AtomicJsonCommitUncertainError(target);
        }
        await writeJsonAtomic(target, value);
      }
    });
    const sources = createSources(2);
    await journal.initialize();
    await journal.requestRefreshBatch(sources.map(({ meshNodeId }) => meshNodeId));
    uncertain = true;

    await expect(journal.recordBindingsAndCompleteBatch(sources.map(bindingInput)))
      .rejects.toThrow("vehicle_sensor_capability_commit_ambiguous");
    await expect(journal.pendingRefreshNodeIds())
      .rejects.toThrow("vehicle_sensor_capability_journal_unavailable");
  });
});

async function measureRefreshCost(nodeCount: number) {
  const path = await journalPath();
  let writeCount = 0;
  let bytesWritten = 0;
  let trackWrites = false;
  const journal = new VehicleSensorCapabilityJournal(path, scope(), {
    write: async (target, value) => {
      if (trackWrites && target === path) {
        writeCount += 1;
        if (writeCount > 2) throw new Error("capability_refresh_rewrite_not_constant");
        bytesWritten += Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
      }
      await writeJsonAtomic(target, value);
    }
  });
  const sources = createSources(nodeCount);
  const controller = createController(journal, sources, vi.fn(async () => supportedBinding()));
  await controller.initialize();
  trackWrites = true;
  await controller.refreshCapabilities();
  await controller.stopAndDrain();
  return { writeCount, bytesWritten };
}

function createController(
  journal: VehicleSensorCapabilityJournal,
  sources: ConfirmedVehicleSensorSource[],
  configureSource: (source: ConfirmedVehicleSensorSource) => Promise<ReturnType<typeof supportedBinding>>,
  diagnostics: VehicleSensorDiagnostic[] = []
) {
  return new VehicleSensorGatewayController({
    port: {
      listConfirmedSources: vi.fn(async () => sources),
      resolveByFixtureId: vi.fn(async () => null),
      resolveBySourceUnicast: vi.fn(async () => null),
      configureSource,
      send: vi.fn(async () => undefined),
      onMessage: vi.fn(() => () => undefined)
    },
    client: {
      initialize: vi.fn(async () => undefined),
      onMeshMessage: vi.fn(async () => false),
      queryConfiguredSources: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined)
    } as unknown as VehicleSensorClient,
    journal,
    publisher: new VehicleSensorCapabilityPublisher(journal, scope()),
    capabilityRetryInitialDelayMs: 10,
    capabilityRetryMaxDelayMs: 30,
    diagnose: (diagnostic) => { diagnostics.push(diagnostic); }
  });
}

function createSources(count: number): ConfirmedVehicleSensorSource[] {
  return Array.from({ length: count }, (_, index) => ({
    fixtureId: uuid(index + 1),
    meshNodeId: uuid(index + 10_001),
    primaryUnicast: index + 1,
    elementCount: 1
  }));
}

function bindingInput(source: ConfirmedVehicleSensorSource) {
  return { meshNodeId: source.meshNodeId, ...supportedBinding() };
}

function supportedBinding() {
  return { sensorServerBound: true, vendorVehicleEventModelBound: true };
}

function scope() {
  return { siteId: SITE_ID, gatewayId: GATEWAY_ID };
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function journalPath() {
  return join(await mkdtemp(join(tmpdir(), "vehicle-sensor-capability-batch-")), "capability.json");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
