import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BioConfigurationState, BioVerifiedLampTarget } from "../bio/bio-dongle-client";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { FileAutomationStateStore } from "./automation-state-store";
import { BioTargetConfigurationRuntime } from "./bio-target-configuration";

const source = "00000000-0000-4000-8000-000000000001";
const b1 = "abcdef00-0000-4000-8000-000000000002";
const b2 = "00000000-0000-4000-8000-000000000003";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(modes: BioConfigurationState["bioMode"][] = ["sensor", "force-off"]) {
  const directory = await mkdtemp(join(tmpdir(), "bio-target-config-")); directories.push(directory);
  const path = join(directory, "state.json");
  let rejectWrites = false;
  let failTerminalCommit = false;
  const store = new FileAutomationStateStore(path, async (destination, value) => {
    const state = value as ReturnType<typeof store.read>;
    if (rejectWrites || (failTerminalCommit && state.bioTargetsByFixture[b1]?.applyResult.status === "succeeded")) {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
    await writeJsonAtomic(destination, value);
  });
  await store.initialize();
  const lamps = new Map([b1, b2].map((id, index) => [id, {
    target: { kind: "unicast", nativeUuid: index ? "001122334466" : "001122334455", logicalAddress: index + 1, networkId: 2 } as BioVerifiedLampTarget,
    configuration: { configuredHighBrightnessPercent: index ? 40 : 30, bioMode: modes[index] ?? "sensor" }
  }]));
  const writes: Array<{ fixtureId: string; configuration: BioConfigurationState }> = [];
  const reads: string[] = [];
  const failures = new Set<string>();
  const unknown = new Set<string>();
  const port = {
    async readBioState(fixtureId: string) {
      reads.push(fixtureId);
      if (unknown.has(fixtureId)) throw new Error("unverified");
      return structuredClone(lamps.get(fixtureId)!);
    },
    async restoreBioState(fixtureId: string, target: BioVerifiedLampTarget, configuration: BioConfigurationState) {
      expect(store.read().bioTargetsByFixture[fixtureId]?.preState).not.toBeNull();
      expect(target).toEqual(lamps.get(fixtureId)!.target);
      writes.push({ fixtureId, configuration: { ...configuration } });
      if (failures.has(fixtureId)) throw new Error("uncertain write");
      lamps.get(fixtureId)!.configuration = { ...configuration };
      return { ...configuration };
    }
  };
  const runtime = new BioTargetConfigurationRuntime(store, port);
  const request = { activationId: "activation-one", sourceFixtureId: source, targetFixtureIds: [b1, b2],
    brightnessPercent: 80, protectedSourceFixtureIds: [source] };
  return { store, runtime, path, port, lamps, writes, reads, failures, unknown, request,
    rejectWrites: (value: boolean) => { rejectWrites = value; },
    failTerminalCommit: (value: boolean) => { failTerminalCommit = value; } };
}

describe("durable BIO target configuration restoration (scheduler remains disconnected)", () => {
  it.each(["sensor", "force-on", "force-off"] as const)("preserves and restores %s configuration across restart and repeated pulses", async mode => {
    const f = await fixture([mode]);
    const request = { ...f.request, targetFixtureIds: [b1] };
    await f.runtime.apply(request);
    expect(f.lamps.get(b1)!.configuration).toEqual({ configuredHighBrightnessPercent: 80, bioMode: "force-on" });
    await f.runtime.apply(request);
    expect(f.writes).toHaveLength(1);
    expect(f.store.read().bioTargetsByFixture[b1]?.preState).toEqual({ configuredHighBrightnessPercent: 30, bioMode: mode });
    const restartedStore = new FileAutomationStateStore(f.path); await restartedStore.initialize();
    const restarted = new BioTargetConfigurationRuntime(restartedStore, f.port);
    await restarted.restore(request);
    await restarted.restore(request);
    expect(f.lamps.get(b1)!.configuration).toEqual({ configuredHighBrightnessPercent: 30, bioMode: mode });
    expect(f.writes).toHaveLength(2);
    expect(restartedStore.read().bioTargetsByFixture[b1]?.restoreResult).toMatchObject({ status: "succeeded", attempt: 1 });
  });

  it("keeps partial application and restoration failures independent and retries only unconfirmed targets", async () => {
    const f = await fixture(); f.failures.add(b2);
    await f.runtime.apply(f.request);
    expect(f.store.read().bioTargetsByFixture[b1]?.applyResult.status).toBe("succeeded");
    expect(f.store.read().bioTargetsByFixture[b2]?.applyResult.status).toBe("timed_out");
    f.failures.clear(); await f.runtime.apply(f.request);
    expect(f.store.read().bioTargetsByFixture[b2]?.preState).toEqual({ configuredHighBrightnessPercent: 40, bioMode: "force-off" });
    f.failures.add(b2); await f.runtime.restore(f.request);
    expect(f.store.read().bioTargetsByFixture[b1]?.restoreResult?.status).toBe("succeeded");
    expect(f.store.read().bioTargetsByFixture[b2]?.restoreResult?.status).toBe("timed_out");
    f.failures.clear(); await f.runtime.restore(f.request);
    expect(f.lamps.get(b2)!.configuration).toEqual({ configuredHighBrightnessPercent: 40, bioMode: "force-off" });
    expect(f.writes.filter(write => write.fixtureId === b1)).toHaveLength(2);
    expect(f.store.read().bioTargetsByFixture[b2]?.restoreResult?.attempt).toBe(2);
  });

  it("does not write any target when a batch includes A or another protected source", async () => {
    const f = await fixture();
    await expect(f.runtime.apply({ ...f.request, targetFixtureIds: [b1, source] })).rejects.toThrow("bio_source_target_forbidden");
    await expect(f.runtime.apply({ ...f.request, protectedSourceFixtureIds: [source, b2] })).rejects.toThrow("bio_source_target_forbidden");
    expect(f.writes).toEqual([]); expect(f.reads).toEqual([]);
    await f.runtime.apply(f.request);
    await expect(f.runtime.restore({ ...f.request, protectedSourceFixtureIds: [source, b1] })).rejects.toThrow("bio_source_target_forbidden");
    expect(f.writes.every(write => write.fixtureId !== source)).toBe(true);
  });

  it("refuses unverified prestate and persists target failure without preventing another B", async () => {
    const f = await fixture(); f.unknown.add(b1);
    await f.runtime.apply(f.request);
    expect(f.store.read().bioTargetsByFixture[b1]).toMatchObject({ preState: null, target: null, applyResult: { status: "failed" } });
    expect(f.writes.map(write => write.fixtureId)).toEqual([b2]);
    f.unknown.clear(); await f.runtime.apply(f.request);
    expect(f.store.read().bioTargetsByFixture[b1]?.preState?.bioMode).toBe("sensor");
  });

  it("does not submit an RF write before a durable base commit", async () => {
    const f = await fixture(); f.rejectWrites(true);
    await expect(f.runtime.apply(f.request)).rejects.toThrow("automation_state_store_failed");
    expect(f.writes).toEqual([]); expect(f.store.read().bioTargetsByFixture).toEqual({});
  });

  it("reconciles an unknown terminal commit by GET without repeating an already-applied RF write", async () => {
    const f = await fixture(); f.failTerminalCommit(true);
    const request = { ...f.request, targetFixtureIds: [b1] };
    await expect(f.runtime.apply(request)).rejects.toThrow("automation_state_store_failed");
    expect(f.store.read().bioTargetsByFixture[b1]?.applyResult.status).toBe("pending");
    f.failTerminalCommit(false);
    const restartedStore = new FileAutomationStateStore(f.path); await restartedStore.initialize();
    await new BioTargetConfigurationRuntime(restartedStore, f.port).apply(request);
    expect(f.writes).toHaveLength(1);
    expect(restartedStore.read().bioTargetsByFixture[b1]).toMatchObject({
      preState: { configuredHighBrightnessPercent: 30, bioMode: "sensor" }, applyResult: { status: "succeeded" }
    });
  });

  it("refuses to overwrite an unrestored activation or restore a replacement lamp", async () => {
    const f = await fixture(); await f.runtime.apply(f.request);
    await expect(f.runtime.apply({ ...f.request, activationId: "next-activation" })).rejects.toThrow("bio_target_activation_conflict");
    f.lamps.get(b1)!.target.nativeUuid = "ffeeddccbbaa";
    await f.runtime.restore(f.request);
    expect(f.store.read().bioTargetsByFixture[b1]?.restoreResult?.status).toBe("failed");
    expect(f.writes.filter(write => write.fixtureId === b1)).toHaveLength(1);
  });

  it("preserves the configured high brightness during force-off event and then restores the original mode", async () => {
    const f = await fixture(); const request = { ...f.request, targetFixtureIds: [b1], brightnessPercent: 0 };
    await f.runtime.apply(request);
    expect(f.lamps.get(b1)!.configuration).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "force-off" });
    await f.runtime.restore(request);
    expect(f.lamps.get(b1)!.configuration).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
  });

  it("cannot bypass source exclusion using UUID case differences", async () => {
    const f = await fixture();
    const sourceWithLetters = "abcdef00-0000-4000-8000-000000000001";
    await expect(f.runtime.apply({ ...f.request, sourceFixtureId: sourceWithLetters,
      targetFixtureIds: [b1, sourceWithLetters.toUpperCase()] })).rejects.toThrow("bio_source_target_forbidden");
    expect(f.writes).toEqual([]); expect(f.reads).toEqual([]);
  });

  it("uses one original base when a retry changes only the fixture UUID casing", async () => {
    const f = await fixture(); const request = { ...f.request, targetFixtureIds: [b1] };
    await f.runtime.apply(request);
    await f.runtime.apply({ ...request, targetFixtureIds: [b1.toUpperCase()] });
    expect(Object.keys(f.store.read().bioTargetsByFixture)).toEqual([b1]);
    expect(f.store.read().bioTargetsByFixture[b1]?.preState).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    expect(f.writes).toHaveLength(1);
  });

  it("never promotes a mismatched configuration observation to restoration success", async () => {
    const f = await fixture(); const request = { ...f.request, targetFixtureIds: [b1] };
    await f.runtime.apply(request);
    const mismatchingPort = { ...f.port,
      async restoreBioState() { return { configuredHighBrightnessPercent: 80, bioMode: "force-on" as const }; }
    };
    await new BioTargetConfigurationRuntime(f.store, mismatchingPort).restore(request);
    expect(f.store.read().bioTargetsByFixture[b1]).toMatchObject({
      preState: { configuredHighBrightnessPercent: 30, bioMode: "sensor" },
      restoreResult: { status: "failed", observed: { configuredHighBrightnessPercent: 80, bioMode: "force-on" } }
    });
    await f.runtime.restore(request);
    expect(f.store.read().bioTargetsByFixture[b1]?.restoreResult?.status).toBe("succeeded");
  });
});
