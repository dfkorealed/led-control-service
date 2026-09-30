import type { AutomationSnapshotV1 } from "@led-control/shared";
import { describe, expect, it, vi } from "vitest";
import type { AutomationConfigStore } from "./automation-config-store";
import { AutomationRuntime } from "./automation-runtime";
import { AutomationStateCommitUncertainError } from "./automation-state-store";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";
import { handleAutomationConfigPayload } from "../gateway";

describe("AutomationRuntime", () => {
  it("rejects a handcrafted enabled BIO V2 rule before storage, activation or RF", async () => {
    const store = memoryStore();
    const recompute = vi.fn(async () => ({}));
    const applyDesiredState = vi.fn(async () => {});
    const runtime = createRuntime(store, { recompute, applyDesiredState });
    const candidate = automationSnapshot(5, { schemaVersion: 2, vehicleEventRules: [{
      id: "00000000-0000-4000-8000-000000000011", name: "BIO", sensorProtocol: "bio-usb-pulse",
      status: "enabled", sourceFixtureIds: ["00000000-0000-4000-8000-000000000012"],
      targetFixtureIds: ["00000000-0000-4000-8000-000000000013"],
      holdSeconds: 10, action: { dimmingEnabled: true, brightnessPercent: 80 }
    }] } as never);
    await expect(runtime.hotReload(candidate)).rejects.toMatchObject({ code: "bio_pulse_control_unavailable" });
    expect(store.apply).not.toHaveBeenCalled();
    expect(recompute).not.toHaveBeenCalled();
    expect(applyDesiredState).not.toHaveBeenCalled();
    expect(runtime.currentSnapshot).toBeNull();
    const recorded = vi.fn(async () => {});
    await expect(handleAutomationConfigPayload(Buffer.from(JSON.stringify(candidate)), runtime, recorded))
      .resolves.toMatchObject({ schemaVersion: 2, status: "rejected", errorCode: "bio_pulse_control_unavailable" });
    expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 2, status: "rejected" }));
    expect(store.apply).not.toHaveBeenCalled();
    const disabled = automationSnapshot(6, { schemaVersion: 2,
      vehicleEventRules: candidate.vehicleEventRules.map(rule => ({ ...rule, status: "disabled" })) } as never);
    await expect(runtime.hotReload(disabled)).resolves.toMatchObject({ schemaVersion: 2, status: "applied" });
    expect(applyDesiredState).not.toHaveBeenCalled();
    const restarted = createRuntime(memoryStore(candidate), { recompute, applyDesiredState });
    await expect(restarted.initialize()).rejects.toMatchObject({ code: "bio_pulse_control_unavailable" });
  });
  it("stores and acknowledges V2 without erasing its version and rejects V1 replay across it", async () => {
    const runtime = createRuntime(memoryStore());
    const v2 = automationSnapshot(5, { schemaVersion: 2 } as never);
    await expect(runtime.hotReload(v2)).resolves.toMatchObject({ schemaVersion: 2, status: "applied" });
    expect(runtime.currentSnapshot).toMatchObject({ schemaVersion: 2 });
    await expect(runtime.hotReload(automationSnapshot(5))).rejects.toMatchObject({ code: "snapshot_revision_conflict" });
    await expect(runtime.hotReload(automationSnapshot(4))).rejects.toMatchObject({ code: "snapshot_old_revision" });
    await expect(runtime.hotReload(automationSnapshot(6))).resolves.toMatchObject({ schemaVersion: 1 });
  });
  it("recovers the persisted snapshot on startup and computes its desired state", async () => {
    const persisted = automationSnapshot(3);
    const recompute = vi.fn().mockResolvedValue({ "fixture-1": 40 });
    const applyDesiredState = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(memoryStore(persisted), { recompute, applyDesiredState });

    await runtime.initialize();

    expect(runtime.currentRevision).toBe(3);
    expect(runtime.currentSnapshot).toEqual(persisted);
    expect(applyDesiredState).toHaveBeenCalledWith({ "fixture-1": 40 }, {});
  });

  it("keeps revision 4 active when a newer snapshot is invalid", async () => {
    const store = memoryStore();
    const recompute = vi.fn().mockResolvedValue({});
    const applyDesiredState = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(store, { recompute, applyDesiredState });
    await runtime.hotReload(automationSnapshot(4));

    await expect(runtime.hotReload({ ...automationSnapshot(5), timeZone: "invalid-zone" }))
      .rejects.toMatchObject({ code: "snapshot_invalid" });

    expect(runtime.currentRevision).toBe(4);
    expect(store.apply).toHaveBeenCalledTimes(1);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(applyDesiredState).not.toHaveBeenCalled();
  });

  it("idempotently accepts an exact revision/hash and rejects conflicts and old revisions", async () => {
    const current = automationSnapshot(4);
    const store = memoryStore(current);
    const runtime = createRuntime(store);
    await runtime.initialize();
    vi.mocked(store.apply).mockClear();

    await expect(runtime.hotReload(current)).resolves.toMatchObject({
      revision: 4,
      payloadHash: current.payloadHash,
      status: "applied",
      errorCode: null
    });
    await expect(runtime.hotReload(automationSnapshot(4, { generatedAt: "2026-08-30T00:00:01.000Z" })))
      .rejects.toMatchObject({ code: "snapshot_revision_conflict" });
    await expect(runtime.hotReload(automationSnapshot(3)))
      .rejects.toMatchObject({ code: "snapshot_old_revision" });
    expect(store.apply).not.toHaveBeenCalled();
  });

  it("serializes concurrent reloads through storage, swap, and recomputation", async () => {
    let releaseRevision4!: () => void;
    const store = memoryStore();
    vi.mocked(store.apply).mockImplementation(async (snapshot) => {
      if (snapshot.revision === 4) await new Promise<void>((resolve) => { releaseRevision4 = resolve; });
    });
    const recomputed: number[] = [];
    const runtime = createRuntime(store, {
      recompute: async (snapshot) => {
        recomputed.push(snapshot.revision);
        return {};
      }
    });

    const revision4 = runtime.hotReload(automationSnapshot(4));
    const revision5 = runtime.hotReload(automationSnapshot(5));
    await vi.waitFor(() => expect(releaseRevision4).toBeTypeOf("function"));
    expect(store.apply).toHaveBeenCalledTimes(1);

    releaseRevision4();
    await Promise.all([revision4, revision5]);
    expect(recomputed).toEqual([4, 5]);
    expect(runtime.currentRevision).toBe(5);
  });

  it("does not swap or recompute when durable storage fails", async () => {
    const current = automationSnapshot(4);
    const store = memoryStore(current);
    const recompute = vi.fn().mockResolvedValue({});
    const runtime = createRuntime(store, { recompute });
    await runtime.initialize();
    recompute.mockClear();
    vi.mocked(store.apply).mockRejectedValueOnce(new Error("directory fsync failed"));

    await expect(runtime.hotReload(automationSnapshot(5)))
      .rejects.toMatchObject({ code: "snapshot_store_failed" });
    expect(runtime.currentRevision).toBe(4);
    expect(recompute).not.toHaveBeenCalled();
  });

  it("restores the persisted and in-memory snapshot when recompute fails", async () => {
    const current = automationSnapshot(4);
    const store = memoryStore(current);
    const runtime = createRuntime(store, {
      recompute: vi.fn(async (snapshot) => {
        if (snapshot.revision === 5) throw new Error("scheduler failed");
        return {};
      })
    });
    await runtime.initialize();

    await expect(runtime.hotReload(automationSnapshot(5)))
      .rejects.toMatchObject({ code: "snapshot_recompute_failed" });

    expect(runtime.currentRevision).toBe(4);
    expect(await store.load()).toEqual(current);
    expect(store.restore).toHaveBeenCalledWith(current);
  });

  it("restores config but does not acknowledge an uncertain automation state commit", async () => {
    const current = automationSnapshot(4);
    const store = memoryStore(current);
    const onActivationFailed = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(store, {
      recompute: vi.fn(async (snapshot) => {
        if (snapshot.revision === 5) throw new AutomationStateCommitUncertainError();
        return {};
      }),
      onActivationFailed
    });
    await runtime.initialize();

    await expect(runtime.hotReload(automationSnapshot(5))).rejects.toMatchObject({
      code: "automation_state_commit_uncertain",
      acknowledgeable: false
    });

    expect(runtime.currentRevision).toBe(4);
    expect(await store.load()).toEqual(current);
    expect(store.restore).toHaveBeenCalledWith(current);
    expect(onActivationFailed).toHaveBeenCalledWith(current);
  });

  it("commits every activated snapshot even when desired mesh work is suppressed", async () => {
    const onActivated = vi.fn().mockResolvedValue(undefined);
    const applyDesiredState = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(memoryStore(), {
      recompute: async () => ({ "fixture-1": 40 }),
      applyDesiredState,
      onActivated
    });

    await runtime.hotReload(automationSnapshot(3));
    await runtime.hotReload(automationSnapshot(4));

    expect(applyDesiredState).toHaveBeenCalledTimes(1);
    expect(onActivated).toHaveBeenNthCalledWith(1, automationSnapshot(3));
    expect(onActivated).toHaveBeenNthCalledWith(2, automationSnapshot(4));
  });

  it("requests mesh work only when recomputation changes the desired state", async () => {
    const applyDesiredState = vi.fn().mockResolvedValue(undefined);
    const runtime = createRuntime(memoryStore(), {
      recompute: async (snapshot) => ({ "fixture-1": snapshot.revision < 5 ? 40 : 70 }),
      applyDesiredState
    });

    await runtime.hotReload(automationSnapshot(3));
    await runtime.hotReload(automationSnapshot(4));
    await runtime.hotReload(automationSnapshot(5));

    expect(applyDesiredState).toHaveBeenNthCalledWith(1, { "fixture-1": 40 }, {});
    expect(applyDesiredState).toHaveBeenNthCalledWith(2, { "fixture-1": 70 }, { "fixture-1": 40 });
    expect(applyDesiredState).toHaveBeenCalledTimes(2);
  });
});

function createRuntime(
  store: AutomationConfigStore,
  overrides: Partial<ConstructorParameters<typeof AutomationRuntime>[0]> = {}
) {
  return new AutomationRuntime({
    store,
    scope: automationScope,
    now: () => new Date("2026-08-30T01:02:03.000Z"),
    recompute: async () => ({}),
    applyDesiredState: async () => undefined,
    ...overrides
  });
}

function memoryStore(initial: AutomationSnapshotV1 | null = null): AutomationConfigStore & {
  apply: ReturnType<typeof vi.fn<(snapshot: AutomationSnapshotV1) => Promise<void>>>;
  restore: ReturnType<typeof vi.fn<(snapshot: AutomationSnapshotV1 | null) => Promise<void>>>;
} {
  let stored = initial;
  return {
    load: vi.fn(async () => stored),
    apply: vi.fn(async (snapshot: AutomationSnapshotV1) => { stored = snapshot; }),
    restore: vi.fn(async (snapshot: AutomationSnapshotV1 | null) => { stored = snapshot; })
  };
}
