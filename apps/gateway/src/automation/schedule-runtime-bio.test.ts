import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AutomationSnapshotV2 } from "@led-control/shared";
import { createHash } from "node:crypto";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import type { BioConfigurationState, BioVerifiedLampTarget } from "../bio/bio-dongle-client";
import { FileAutomationStateStore, parseAutomationState, emptyAutomationState } from "./automation-state-store";
import { ScheduleRuntime } from "./schedule-runtime";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";

async function reserveTemporary(f: Awaited<ReturnType<typeof fixture>>) {
  const payload = { schemaVersion: 1 as const, kind: "start" as const, sessionId: manual, sessionRevision: 1 as const,
    siteId: a, gatewayId: b, assignmentVersion: 1, admissionRevision: 4, sequence: 1, brightness: 70,
    startedAt: f.now().toISOString(), endsAt: new Date(f.now().getTime() + 60_000).toISOString(),
    targets: [{ fixtureId: b, meshNodeId: b, nativeUuid: "001122334466", logicalAddress: "0x0002", applyGeneration: "1", releaseGeneration: "2" }] };
  const command = { ...payload, payloadHash: bioEnvelopeHash(payload) };
  await f.store.updateDurable(state => {
    const snapshot = command.targets[0]!;
    state.temporarySessions[manual] = { command, sessionRevision: 1, state: "pending", targets: { [b]: {
      snapshot, preState: null, preActivationId: null, applyConfirmed: false, releaseConfirmed: false, releaseAcknowledged: false,
      configurationMayHaveChanged: false, partialMutation: "none", applyResult: null, releaseResult: null } } };
    state.fixtureLeases[b] = { sessionId: manual, identity: snapshot, applyGeneration: "1", releaseGeneration: "2", lastGeneration: "1", phase: "pending" };
    return state;
  });
}

it("temporary lease defers only selected target writes while preserving pulse receipts and automatic state", async () => {
  const f = await fixture([b, c]); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
  await reserveTemporary(f);
  await f.runtime.recordVehicleSensorInput(f.pulse());
  expect(f.writes.map(row => row.fixtureId)).toEqual([c]);
  expect(f.store.read().bioPulseInbox[a]?.receipt.sequence).toBe(1);
  expect(f.store.read().bioActivationsByRule[rule]?.targetFixtureIds).toEqual([b, c]);
  expect(f.store.read().bioActivationsByRule[rule]?.retiredFixtureIds).toEqual([]);
  await expect(f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 20,
    requestedAt: f.now().toISOString() })).rejects.toThrow("temporary_fixture_lease_conflict");
});

it("configuration activation rollback preserves independently accepted temporary journals and leases", async () => {
  const f = await fixture();
  await f.runtime.recompute({ ...f.snapshot, schemaVersion: 1, vehicleEventRules: [] });
  await reserveTemporary(f);
  const accepted = f.store.read();
  await f.runtime.rollbackActivation();
  expect(f.store.read().temporarySessions).toEqual(accepted.temporarySessions);
  expect(f.store.read().fixtureLeases).toEqual(accepted.fixtureLeases);
});

it("rejects unintegrated V3 before replacing the active scheduler or touching RF", async () => {
  const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
  const next = { ...f.snapshot, schemaVersion: 3 as const, schedules: [], holidayDatasets: [] };
  await expect(f.runtime.recompute(next as any)).rejects.toThrow("bio_v3_runtime_unavailable");
  expect(f.writes).toEqual([]); expect(f.genericWrites).toEqual([]);
});

const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const c = "00000000-0000-4000-8000-000000000003";
const rule = "00000000-0000-4000-8000-000000000004";
const manual = "00000000-0000-4000-8000-000000000005";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(targets = [b], holdSeconds = 10) {
  const dir = await mkdtemp(join(tmpdir(), "bio-scheduler-")); dirs.push(dir);
  const path = join(dir, "state.json");
  let ms = 1000;
  let wallOffset = 0;
  let reject: (state: ReturnType<FileAutomationStateStore["read"]>) => boolean = () => false;
  let beforeWrite: ((state: ReturnType<FileAutomationStateStore["read"]>) => Promise<void>) | undefined;
  const writer = async (destination: string, value: unknown) => {
    await beforeWrite?.(value as ReturnType<FileAutomationStateStore["read"]>);
    if (reject(value as ReturnType<FileAutomationStateStore["read"]>)) throw Object.assign(new Error("full"), { code: "ENOSPC" });
    await writeJsonAtomic(destination, value);
  };
  const now = () => new Date(Date.UTC(2026, 8, 30) + ms + wallOffset);
  const binding = { sourceFixtureId: a, nativeUuid: "001122334455", logicalAddress: 1, networkId: 2,
    capabilityRevision: 7, snapshotRevision: 4, profileId: "synthetic-only", firmwareFingerprint: "test-fw", sensorFingerprint: "test-sensor" };
  const authority = { binding: { ...binding }, independentlyQualified: true,
    connection: { epoch: "test-connection", generation: 1 },
    observation: { health: "healthy" as "healthy" | "degraded" | "unverified", reason: "qualified",
      connectionEpoch: "test-connection", connectionGeneration: 1, healthySinceMonotonicMs: 0 } };
  const value = { schemaVersion: 2 as const, siteId: a, gatewayId: b, revision: 4, timeZone: "UTC", schedules: [],
    vehicleEventRules: [{ id: rule, name: "Synthetic BIO", status: "enabled" as const, sensorProtocol: "bio-usb-pulse" as const,
      sourceFixtureIds: [a], targetFixtureIds: targets, action: { dimmingEnabled: true, brightnessPercent: 80 }, holdSeconds }],
    generatedAt: now().toISOString() };
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : input;
  const snapshot: AutomationSnapshotV2 = { ...value, payloadHash: `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}` };
  const lamps = new Map([b, c].map((id, i) => [id, {
    target: { kind: "unicast", nativeUuid: i ? "001122334477" : "001122334466", logicalAddress: i + 2, networkId: 2 } as BioVerifiedLampTarget,
    configuration: { configuredHighBrightnessPercent: i ? 40 : 30, bioMode: i ? "force-off" : "sensor" } as BioConfigurationState
  }]));
  const writes: Array<{ fixtureId: string; configuration: BioConfigurationState }> = [];
  const failures = new Set<string>();
  let onRead: ((id: string) => void) | undefined;
  let afterRestore: ((id: string) => Promise<void>) | undefined;
  const port = {
    async readBioState(id: string) { onRead?.(id); return structuredClone(lamps.get(id)!); },
    async restoreBioState(id: string, _target: BioVerifiedLampTarget, configuration: BioConfigurationState) {
      const durable = JSON.parse(await readFile(path, "utf8"));
      expect(durable.bioPulseInbox[a]).toBeDefined();
      expect(durable.bioTargetsByFixture[id].preState).not.toBeNull();
      expect(durable.pendingTelemetryHandoffs.length).toBeGreaterThan(0);
      writes.push({ fixtureId: id, configuration: { ...configuration } });
      if (failures.has(id)) throw new Error("unknown RF outcome");
      lamps.get(id)!.configuration = { ...configuration };
      await afterRestore?.(id);
      return { ...configuration };
    }
  };
  const genericWrites: unknown[] = [];
  let failGeneric = false;
  let clockTrust: () => Promise<boolean> = async () => true;
  const make = async (enabled = true) => {
    const store = new FileAutomationStateStore(path, writer);
    const runtime = new ScheduleRuntime({ store, wallClock: now, monotonicClock: () => ms,
      clockTrust: { isTrusted: () => clockTrust() }, execute: async actions => {
        genericWrites.push(...actions);
        if (failGeneric) return actions.map(action => ({ fixtureId: action.fixtureId, status: "failed" as const,
          brightnessPercent: null, faultCode: null, errorCode: "synthetic_failure", occurredAt: now().toISOString() }));
        return actions.map(action => { lamps.get(action.fixtureId)!.configuration = {
          configuredHighBrightnessPercent: action.brightnessPercent, bioMode: "force-on" };
          return { fixtureId: action.fixtureId, status: "succeeded" as const, brightnessPercent: action.brightnessPercent,
            faultCode: null, errorCode: null, occurredAt: now().toISOString() }; });
      },
      bioPulseTestProfile: enabled ? { kind: "synthetic-test-only", bindings: [binding], sourceAuthority: () => structuredClone(authority), targetPort: port } : undefined });
    await runtime.initialize();
    return { store, runtime };
  };
  const current = await make();
  const pulse = (sequence = 1) => ({ type: "pulse" as const, sourceFixtureId: a, receivedMonotonicMs: ms,
    receipt: { nativeUuid: binding.nativeUuid, logicalAddress: 1, networkId: 2, sequence,
      connectionEpoch: authority.connection.epoch, connectionGeneration: authority.connection.generation } });
  return { ...current, path, snapshot, authority, lamps, writes, genericWrites, failures, pulse, make, now,
    advance: (amount: number) => { ms += amount; }, reject: (predicate: typeof reject) => { reject = predicate; },
    onRead: (callback: (id: string) => void) => { onRead = callback; }, wallOffset: (value: number) => { wallOffset = value; },
    failGeneric: (value: boolean) => { failGeneric = value; },
    afterRestore: (value: (id: string) => Promise<void>) => { afterRestore = value; },
    beforeWrite: (value: (state: ReturnType<FileAutomationStateStore["read"]>) => Promise<void>) => { beforeWrite = value; },
    clockTrust: (value: () => Promise<boolean>) => { clockTrust = value; } };
}

function rehash(snapshot: AutomationSnapshotV2) {
  const { payloadHash: _hash, ...payload } = snapshot;
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : input;
  snapshot.payloadHash = `sha256:${createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")}`;
  return snapshot;
}

describe("synthetic V2 BIO scheduler integration; product gate remains OFF", () => {
  it("exposes the active snapshot source guard for command/identify and rejects mixed manual A+B", async () => {
    const f = await fixture();
    expect(f.runtime.isBioSourceTarget([a])).toBe(false);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    expect(f.runtime.isBioSourceTarget([a, b])).toBe(true);
    expect(f.runtime.isBioSourceTarget([b])).toBe(false);
    await expect(f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [a, b], brightnessPercent: 50, requestedAt: f.now().toISOString() }))
      .rejects.toThrow("bio_source_target_forbidden");
    expect(f.writes).toEqual([]); expect(f.genericWrites).toEqual([]);
    expect(f.runtime.state().pendingManualControls).toEqual({});
  });
  it("keeps both default pulse entrypoints closed without the injected profile", async () => {
    const f = await fixture(); const { runtime } = await f.make(false);
    await expect(runtime.recordVehicleSensorInput(f.pulse())).rejects.toThrow("bio_pulse_control_unavailable");
    await expect(runtime.recordVehicleSensorEvent(f.pulse(), { sourceUnicast: 1, bootId: 1, sequence: 1 })).rejects.toThrow("bio_pulse_control_unavailable");
    expect(f.writes).toEqual([]); expect(f.genericWrites).toEqual([]);
  });

  it("durably starts, extends one activation, and restores each B configuration after healthy hold", async () => {
    const f = await fixture([b, c]);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.recordVehicleSensorInput(f.pulse());
    const started = f.store.read().vehicleRules[rule]!.startedAt;
    expect(f.lamps.get(b)!.configuration).toEqual({ configuredHighBrightnessPercent: 80, bioMode: "force-on" });
    f.advance(9000); await f.runtime.recordVehicleSensorEvent(f.pulse(2), { sourceUnicast: 1, bootId: 1, sequence: 2 });
    expect(f.store.read().vehicleRules[rule]!.startedAt).toBe(started);
    expect(f.writes).toHaveLength(2);
    f.advance(9999); await f.runtime.tick(); expect(f.writes).toHaveLength(2);
    f.advance(1); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    expect(f.lamps.get(c)!.configuration).toEqual({ configuredHighBrightnessPercent: 40, bioMode: "force-off" });
    expect(f.genericWrites).toEqual([]);
    const telemetry = JSON.stringify(f.store.read().pendingTelemetryHandoffs);
    expect(telemetry).toContain("hold_expired"); expect(telemetry).not.toContain("001122334455");
  });

  it("does not accept a receipt or send RF if the occurrence+telemetry transaction cannot commit", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    f.reject(state => Boolean(state.bioPulseInbox[a]));
    await expect(f.runtime.recordVehicleSensorInput(f.pulse())).rejects.toThrow("automation_state_store_failed");
    expect(f.store.read().vehicleRules).toEqual({}); expect(f.store.read().bioPulseInbox).toEqual({}); expect(f.writes).toEqual([]);
  });

  it.each(["capabilityRevision", "snapshotRevision", "nativeUuid"] as const)("rejects changed %s before pulse and RF", async key => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    if (key === "nativeUuid") f.authority.binding.nativeUuid = "001122334499";
    else f.authority.binding[key]++;
    await expect(f.runtime.recordVehicleSensorInput(f.pulse())).rejects.toThrow("bio_source_authority_unverified");
    expect(f.writes).toEqual([]); expect(f.store.read().bioPulseInbox).toEqual({});
  });

  it("freezes degraded targets, durably deduplicates operator status, and observes a full recovered hold", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.recordVehicleSensorInput(f.pulse()); f.advance(5000);
    f.authority.observation.health = "degraded";
    await f.runtime.setBioSourceHealth(a, "degraded", "usb_disconnected");
    const count = f.store.read().pendingTelemetryHandoffs.length;
    f.advance(60000); await f.runtime.tick(); await f.runtime.tick();
    expect(f.writes).toHaveLength(1); expect(f.store.read().pendingTelemetryHandoffs).toHaveLength(count);
    expect(JSON.stringify(f.store.read().pendingTelemetryHandoffs)).toContain("restorationPending");
    f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 66000;
    await f.runtime.setBioSourceHealth(a, "healthy", "qualified");
    f.advance(9999); await f.runtime.tick(); expect(f.writes).toHaveLength(1);
    f.advance(1); await f.runtime.tick(); expect(f.writes).toHaveLength(2);
  });

  it("restarts with the durable base and requires a fresh full healthy observation window", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.recordVehicleSensorInput(f.pulse()); f.advance(60000);
    const next = await f.make(); await next.runtime.activateBioPulseTestSnapshot(f.snapshot);
    expect(f.writes).toHaveLength(1); f.advance(9999); await next.runtime.tick(); expect(f.writes).toHaveLength(1);
    f.advance(1); await next.runtime.tick();
    expect(f.lamps.get(b)!.configuration.bioMode).toBe("sensor"); expect(f.writes).toHaveLength(2);
  });

  it("manual success retires the old target base, suppresses only that activation, and permits the next", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.recordVehicleSensorInput(f.pulse());
    await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 60, requestedAt: f.now().toISOString() });
    f.lamps.get(b)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
    await f.runtime.handoffManualTerminal(manual, [{ fixtureId: b, status: "succeeded", brightnessPercent: 60,
      faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    expect(f.store.read().bioTargetsByFixture[b]).toBeUndefined();
    f.advance(1000); await f.runtime.recordVehicleSensorInput(f.pulse(2));
    f.advance(10000); await f.runtime.tick();
    expect(f.writes).toHaveLength(1); expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(60);
    f.advance(1); await f.runtime.recordVehicleSensorInput(f.pulse(3));
    expect(f.writes).toHaveLength(2);
    await f.runtime.releaseBioEvent(rule);
    expect(f.lamps.get(b)!.configuration).toEqual({ configuredHighBrightnessPercent: 60, bioMode: "force-on" });
  });

  it("retains per-target release failure and retries it without repeating a successful B restore", async () => {
    const f = await fixture([b, c]); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.recordVehicleSensorInput(f.pulse()); f.failures.add(c);
    await f.runtime.releaseBioEvent(rule);
    expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(false);
    expect(f.store.read().bioTargetsByFixture[b]?.restoreResult?.status).toBe("succeeded");
    expect(f.store.read().bioTargetsByFixture[c]?.restoreResult?.status).toBe("timed_out");
    f.failures.clear(); await f.runtime.tick();
    expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(true);
    expect(f.writes.filter(write => write.fixtureId === b)).toHaveLength(2);
    expect(JSON.stringify(f.store.read().pendingTelemetryHandoffs)).toContain("operator_release");
  });

  it("does not mark release complete when its final durable commit fails", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.recordVehicleSensorInput(f.pulse());
    f.reject(state => state.bioActivationsByRule[rule]?.completed === true);
    await expect(f.runtime.releaseBioEvent(rule)).rejects.toThrow("automation_state_store_failed");
    expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(false);
    f.reject(() => false); await f.runtime.tick();
    expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(true); expect(f.writes).toHaveLength(2);
  });

  it("rejects overlapping event target ownership before RF", async () => {
    const f = await fixture();
    f.snapshot.vehicleEventRules.push({ ...f.snapshot.vehicleEventRules[0]!, id: manual }); rehash(f.snapshot);
    await expect(f.runtime.activateBioPulseTestSnapshot(f.snapshot)).rejects.toThrow("bio_target_activation_conflict");
    expect(f.writes).toEqual([]); expect(f.genericWrites).toEqual([]);
  });

  it("holds event priority above a schedule then resumes the current schedule after restore", async () => {
    const f = await fixture(); await f.runtime.recordFixtureState(b, 30);
    f.snapshot.schedules.push({ id: manual, name: "schedule", status: "enabled", activeFrom: "2026-09-01T00:00:00.000Z",
      activeUntil: "2026-10-30T00:00:00.000Z", localStartTime: "00:00", localEndTime: "23:00",
      recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
      action: { dimmingEnabled: true, brightnessPercent: 40 }, fixtureIds: [b] }); rehash(f.snapshot);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(40);
    await f.runtime.recordVehicleSensorInput(f.pulse()); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(80);
    expect(f.genericWrites).toHaveLength(1);
    f.advance(10000); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(40);
  });

  it("rechecks authority after asynchronous GET before any RF write", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    f.onRead(() => { f.authority.binding.capabilityRevision++; });
    await f.runtime.recordVehicleSensorInput(f.pulse());
    expect(f.writes).toEqual([]);
    expect(f.store.read().bioTargetsByFixture[b]?.applyResult.status).not.toBe("succeeded");
  });

  it("does not let a healthy hint grant qualification or revive an unbound V8 occurrence", async () => {
    const f = await fixture(); f.authority.independentlyQualified = false;
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.setBioSourceHealth(a, "healthy", "qualified");
    await expect(f.runtime.recordVehicleSensorInput(f.pulse())).rejects.toThrow("bio_source_authority_unverified");
    f.authority.independentlyQualified = true;
    await f.store.updateDurable(state => { state.vehicleRules[rule] = {
      sensorProtocol: "bio-usb-pulse", activeSourceFixtureIds: [], targetFixtureIds: [b], brightnessPercent: 80,
      startedAt: f.now().toISOString(), holdUntil: new Date(f.now().getTime() + 10000).toISOString(), preBrightness: {} }; return state; });
    const next = await f.make();
    await expect(next.runtime.activateBioPulseTestSnapshot(f.snapshot)).rejects.toThrow("bio_source_authority_unverified");
    expect(f.writes).toEqual([]);
  });

  it("retains a fault/recovery between queued health notifications and observes the whole hold", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.recordVehicleSensorInput(f.pulse()); f.advance(9999);
    const fault = f.runtime.setBioSourceHealth(a, "degraded", "usb_disconnected");
    const recovery = f.runtime.setBioSourceHealth(a, "healthy", "qualified");
    await Promise.all([fault, recovery]); f.advance(1); await f.runtime.tick();
    expect(f.writes).toHaveLength(1);
    f.advance(9999); await f.runtime.tick(); expect(f.writes).toHaveLength(2);
  });

  it.each(["terminal", "observation"] as const)("retires a manual takeover during pending release via %s", async route => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 60, requestedAt: f.now().toISOString() });
    f.advance(10000); await f.runtime.tick();
    f.lamps.get(b)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
    const current = route === "observation" ? await f.make() : f;
    if (route === "observation") await current.runtime.activateBioPulseTestSnapshot(f.snapshot);
    if (route === "terminal") await current.runtime.handoffManualTerminal(manual, [{ fixtureId: b, status: "succeeded", brightnessPercent: 60,
      faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    else await current.runtime.recordFixtureState(b, 60);
    await current.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(60);
    expect(current.store.read().bioTargetsByFixture[b]).toBeUndefined(); expect(f.writes).toHaveLength(1);
  });

  it("keeps pending manual ownership when durable retirement fails, including restart", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 60, requestedAt: f.now().toISOString() });
    f.lamps.get(b)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
    f.reject(state => state.bioActivationsByRule[rule]?.retiredFixtureIds.includes(b) === true);
    await expect(f.runtime.handoffManualTerminal(manual, [{ fixtureId: b, status: "succeeded", brightnessPercent: 60,
      faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }])).rejects.toThrow("automation_state_store_failed");
    expect(f.store.read().pendingManualControls[b]?.sourceId).toBe(manual);
    f.reject(() => false); const next = await f.make(); await next.runtime.activateBioPulseTestSnapshot(f.snapshot);
    f.advance(10000); await next.runtime.tick();
    expect(f.writes).toHaveLength(1); expect(next.store.read().bioActivationsByRule[rule]?.completed).toBe(false);
  });

  it("rejects a changed V2 payload at the same revision after restart", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    f.snapshot.vehicleEventRules[0]!.targetFixtureIds = [c]; rehash(f.snapshot);
    const next = await f.make();
    await expect(next.runtime.activateBioPulseTestSnapshot(f.snapshot)).rejects.toThrow("bio_source_authority_unverified");
    expect(f.writes).toHaveLength(1);
  });

  it("migrates strict V8 and rejects inconsistent V9 activation identity and retirement", async () => {
    const { bioActivationsByRule: _activations, temporarySessions: _temporary, fixtureLeases: _leases,
      temporaryResultOutbox: _results, temporaryEndTombstones: _ends, ...v8 } = emptyAutomationState();
    expect(parseAutomationState({ ...v8, schemaVersion: 8 }).bioActivationsByRule).toEqual({});
    expect(() => parseAutomationState({ ...v8, schemaVersion: 8, bioActivationsByRule: {} })).toThrow();
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    for (const change of [
      (row: any) => { row.binding.capabilityRevision = -1; },
      (row: any) => { row.retiredFixtureIds = [a]; },
      (row: any) => { row.completed = true; },
      (row: any) => { row.activationId = "unrelated"; },
      (row: any) => { row.targetFixtureIds = [c]; }
    ]) {
      const state = f.store.read(); change(state.bioActivationsByRule[rule]);
      expect(() => parseAutomationState(state)).toThrow();
    }
  });

  it("admits a new activation after operator release even if UTC repeats the previous start", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const first = f.store.read().vehicleRules[rule]!.startedAt;
    await f.runtime.releaseBioEvent(rule); f.advance(1); f.wallOffset(-1);
    await f.runtime.recordVehicleSensorInput(f.pulse(2));
    expect(f.store.read().vehicleRules[rule]!.startedAt).not.toBe(first);
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(80); expect(f.writes).toHaveLength(3);
  });

  it("permits a new schedule occurrence after manual takeover of the same BIO activation", async () => {
    const f = await fixture([], 1800); f.snapshot.vehicleEventRules[0]!.targetFixtureIds = [b];
    await f.runtime.recordFixtureState(b, 30);
    f.snapshot.schedules.push({ id: c, name: "new schedule", status: "enabled", activeFrom: "2026-09-01T00:00:00.000Z",
      activeUntil: "2026-10-30T00:00:00.000Z", localStartTime: "00:01", localEndTime: "23:00",
      recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
      action: { dimmingEnabled: true, brightnessPercent: 40 }, fixtureIds: [b] }); rehash(f.snapshot);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 60, requestedAt: f.now().toISOString() });
    f.lamps.get(b)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
    await f.runtime.handoffManualTerminal(manual, [{ fixtureId: b, status: "succeeded", brightnessPercent: 60,
      faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    f.advance(60000); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(40); expect(f.writes).toHaveLength(1);
  });

  it("rejects a forged completed activation whose target restore is still pending", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const state = f.store.read(); delete state.vehicleRules[rule];
    state.bioActivationsByRule[rule]!.releaseReason = "operator_release";
    state.bioActivationsByRule[rule]!.completed = true;
    expect(() => parseAutomationState(state)).toThrow();
  });

  it.each(["recovery", "operator"] as const)("freezes an expiry restore when health fails during GET, then releases through %s", async path => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    f.advance(10000); f.onRead(() => { f.authority.observation.health = "degraded"; f.authority.observation.reason = "usb_disconnected"; });
    await f.runtime.tick();
    expect(f.writes).toHaveLength(1);
    expect(f.store.read().bioActivationsByRule[rule]).toMatchObject({ completed: false, health: "degraded" });
    f.onRead(() => undefined);
    if (path === "operator") await f.runtime.releaseBioEvent(rule);
    else {
      f.authority.observation.health = "healthy"; f.authority.observation.reason = "qualified";
      f.authority.observation.healthySinceMonotonicMs = 11000;
      await f.runtime.setBioSourceHealth(a, "healthy", "qualified");
      f.advance(9999); await f.runtime.tick(); expect(f.writes).toHaveLength(1);
      f.advance(1); await f.runtime.tick();
    }
    expect(f.writes).toHaveLength(2); expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(true);
    if (path === "operator") expect(f.store.read().bioActivationsByRule[rule]?.releaseReason).toBe("operator_release");
  });

  it("persists degraded health rather than advertising healthy from a stale connection observation", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    f.authority.observation.connectionEpoch = "stale-connection";
    f.advance(10000); await f.runtime.tick();
    expect(f.writes).toHaveLength(1);
    expect(f.store.read().bioActivationsByRule[rule]).toMatchObject({ health: "degraded", healthReason: "connection_changed" });
  });

  it.each([false, true])("extends by receipt time when processing crosses the old deadline (manual=%s)", async takeover => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const startedAt = f.store.read().vehicleRules[rule]!.startedAt;
    if (takeover) {
      await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 60, requestedAt: f.now().toISOString() });
      f.lamps.get(b)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
      await f.runtime.handoffManualTerminal(manual, [{ fixtureId: b, status: "succeeded", brightnessPercent: 60,
        faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    }
    f.advance(9000); const queued = f.pulse(2); f.advance(2000);
    await f.runtime.recordVehicleSensorInput(queued);
    expect(f.store.read().vehicleRules[rule]!.startedAt).toBe(startedAt);
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(takeover ? 60 : 80);
    expect(f.writes).toHaveLength(1);
    f.advance(7999); await f.runtime.tick(); expect(f.writes).toHaveLength(1);
    f.advance(1); await f.runtime.tick(); expect(f.writes).toHaveLength(takeover ? 1 : 2);
  });

  it("restores the old base before admitting a pulse actually received after the deadline", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const startedAt = f.store.read().vehicleRules[rule]!.startedAt;
    f.advance(11000); await f.runtime.recordVehicleSensorInput(f.pulse(2));
    expect(f.store.read().vehicleRules[rule]!.startedAt).not.toBe(startedAt);
    expect(f.writes.map(write => write.configuration.configuredHighBrightnessPercent)).toEqual([80, 30, 80]);
  });

  it.each([false, true])("renews an automatic pending release from a fresh recovery pulse with original per-B bases (partial=%s)", async partial => {
    const f = await fixture(partial ? [b, c] : [b]); await f.runtime.activateBioPulseTestSnapshot(f.snapshot);
    await f.runtime.recordVehicleSensorInput(f.pulse()); const startedAt = f.store.read().vehicleRules[rule]!.startedAt;
    f.advance(10000); f.onRead(id => {
      if (!partial || id === c) { f.authority.observation.health = "degraded"; f.authority.observation.reason = "usb_disconnected"; }
    });
    await f.runtime.tick(); expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(false);
    if (partial) expect(f.store.read().bioTargetsByFixture[b]?.restoreResult?.status).toBe("succeeded");
    f.onRead(() => undefined); f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 11000;
    await f.runtime.setBioSourceHealth(a, "healthy", "qualified"); f.advance(9000);
    await expect(f.runtime.recordVehicleSensorInput(f.pulse(2))).resolves.toBeUndefined();
    expect(f.store.read().vehicleRules[rule]!.startedAt).toBe(startedAt);
    expect(f.store.read().bioActivationsByRule[rule]?.releaseReason).toBeNull();
    expect(f.store.read().bioTargetsByFixture[b]?.preState).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(80);
    f.advance(9999); await f.runtime.tick(); expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(80);
    f.advance(1); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    if (partial) expect(f.lamps.get(c)!.configuration).toEqual({ configuredHighBrightnessPercent: 40, bioMode: "force-off" });
  });

  it("does not let a recovery pulse cancel an explicit operator release", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    f.failures.add(b); await f.runtime.releaseBioEvent(rule); f.advance(1000);
    await expect(f.runtime.recordVehicleSensorInput(f.pulse(2))).rejects.toThrow("bio_release_pending");
    expect(f.store.read().bioActivationsByRule[rule]?.releaseReason).toBe("operator_release");
  });

  it.each([[false, false], [true, false], [false, true]])("resolves the latest baseline after a schedule ends beneath an active BIO event (manual=%s, restart=%s)", async (takeover, restart) => {
    const f = await fixture([b], 120); await f.runtime.recordFixtureState(b, 30);
    f.snapshot.schedules.push({ id: c, name: "short schedule", status: "enabled", activeFrom: "2026-09-01T00:00:00.000Z",
      activeUntil: "2026-10-30T00:00:00.000Z", localStartTime: "00:00", localEndTime: "00:01",
      recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
      action: { dimmingEnabled: true, brightnessPercent: 40 }, fixtureIds: [b] }); rehash(f.snapshot);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    if (takeover) {
      await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 60, requestedAt: f.now().toISOString() });
      f.lamps.get(b)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
      await f.runtime.handoffManualTerminal(manual, [{ fixtureId: b, status: "succeeded", brightnessPercent: 60,
        faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    }
    f.advance(60000); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(takeover ? 60 : 80);
    f.advance(60000); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(takeover ? 60 : 30);
    expect(f.store.read().lastDesiredByFixture[b]).toBe(takeover ? 60 : 30);
    if (!takeover) expect(f.store.read().bioTargetsByFixture[b]?.restoreResult?.observed).toEqual({
      configuredHighBrightnessPercent: 40, bioMode: "force-on" });
    if (!takeover) {
      f.advance(86280000); await f.runtime.tick(); // Next day's independent schedule.
      f.failGeneric(true); f.advance(60000); await f.runtime.tick();
      const failed = f.store.read().pendingTelemetryHandoffs.flatMap(handoff => handoff.records)
        .filter(record => record.kind === "action_result").at(-1);
      f.failGeneric(false);
      const retry = restart ? await f.make() : f;
      if (restart) await retry.runtime.activateBioPulseTestSnapshot(f.snapshot);
      else await retry.runtime.tick();
      const latest = retry.store.read().pendingTelemetryHandoffs.flatMap(handoff => handoff.records)
        .filter(record => record.kind === "action_result").at(-1);
      expect(latest).toMatchObject({ ruleId: c, payload: { sourceType: "schedule" } });
      expect(latest?.occurrenceKey).toBe(failed?.occurrenceKey);
    }
  });

  it("preserves partial restore evidence when the renewal receipt transaction fails", async () => {
    const f = await fixture([b, c]); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    f.advance(10000); f.onRead(id => { if (id === c) f.authority.observation.health = "degraded"; }); await f.runtime.tick();
    f.onRead(() => undefined); f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 11000;
    await f.runtime.setBioSourceHealth(a, "healthy", "qualified"); f.advance(1000);
    const before = f.store.read(); const writes = f.writes.length;
    f.reject(state => state.bioPulseInbox[a]?.receipt.sequence === 2);
    await expect(f.runtime.recordVehicleSensorInput(f.pulse(2))).rejects.toThrow("automation_state_store_failed");
    expect(f.store.read()).toEqual(before); expect(f.writes).toHaveLength(writes);
    const reloaded = new FileAutomationStateStore(f.path); await reloaded.initialize();
    expect(reloaded.read().bioTargetsByFixture[b]?.restoreResult?.status).toBe("succeeded");
    expect(reloaded.read().bioActivationsByRule[rule]?.releaseReason).toBe("hold_expired");
  });

  it("preserves manual retirement when a recovery pulse renews a partially released activation", async () => {
    const f = await fixture([b, c]); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    f.advance(10000); f.onRead(() => { f.authority.observation.health = "degraded"; }); await f.runtime.tick(); f.onRead(() => undefined);
    await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 60, requestedAt: f.now().toISOString() });
    f.lamps.get(b)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
    await f.runtime.handoffManualTerminal(manual, [{ fixtureId: b, status: "succeeded", brightnessPercent: 60,
      faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 11000;
    await f.runtime.setBioSourceHealth(a, "healthy", "qualified"); f.advance(1000); await f.runtime.recordVehicleSensorInput(f.pulse(2));
    expect(f.store.read().bioTargetsByFixture[b]).toBeUndefined();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(60);
    f.advance(10000); await f.runtime.tick(); expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(60);
  });

  it("rejects stale receipts without cancelling automatic release or resetting restore evidence", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); const old = f.pulse(); await f.runtime.recordVehicleSensorInput(old);
    f.advance(10000); f.onRead(() => { f.authority.observation.health = "degraded"; }); await f.runtime.tick(); f.onRead(() => undefined);
    f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 11000;
    await f.runtime.setBioSourceHealth(a, "healthy", "qualified");
    const before = f.store.read(); await f.runtime.recordVehicleSensorInput(old);
    expect(f.store.read()).toEqual(before); expect(f.writes).toHaveLength(1);
  });

  it("does not revive a short-hold pending release from a receipt only still valid for a longer rule", async () => {
    const f = await fixture(); f.snapshot.vehicleEventRules.push({ ...f.snapshot.vehicleEventRules[0]!, id: manual,
      targetFixtureIds: [c], holdSeconds: 60 }); rehash(f.snapshot);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    f.advance(10000); f.onRead(() => { f.authority.observation.health = "degraded"; }); await f.runtime.tick(); f.onRead(() => undefined);
    f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 11000;
    await f.runtime.setBioSourceHealth(a, "healthy", "qualified"); f.advance(1000); const queued = f.pulse(2); f.advance(13000);
    await f.runtime.recordVehicleSensorInput(queued);
    expect(f.store.read().vehicleRules[rule]).toBeUndefined();
    expect(f.store.read().vehicleRules[manual]).toBeDefined();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(30);
  });

  it("reports a failed latest-baseline write separately from a verified prior configuration restore and retries it", async () => {
    const f = await fixture([b], 120); await f.runtime.recordFixtureState(b, 30);
    f.snapshot.schedules.push({ id: c, name: "short schedule", status: "enabled", activeFrom: "2026-09-01T00:00:00.000Z",
      activeUntil: "2026-10-30T00:00:00.000Z", localStartTime: "00:00", localEndTime: "00:01",
      recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
      action: { dimmingEnabled: true, brightnessPercent: 40 }, fixtureIds: [b] }); rehash(f.snapshot);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    f.advance(60000); await f.runtime.tick(); f.failGeneric(true); f.advance(60000); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(40);
    expect(f.store.read().lastDesiredByFixture[b]).toBe(40);
    expect(f.store.read().transitionsByFixture[b]).toMatchObject({ status: "failed", brightnessPercent: 30 });
    const records = f.store.read().pendingTelemetryHandoffs.flatMap(handoff => handoff.records);
    expect(records).toContainEqual(expect.objectContaining({ kind: "action_result", ruleId: rule,
      payload: expect.objectContaining({ sourceType: "vehicle_event_rule", results: [expect.objectContaining({ fixtureId: b,
        status: "failed", brightnessPercent: null, errorCode: "synthetic_failure" })] }) }));
    expect(f.store.read().bioTargetsByFixture[b]?.restoreResult?.observed).toEqual({ configuredHighBrightnessPercent: 40, bioMode: "force-on" });
    f.failGeneric(false); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(30);
    expect(f.store.read().lastDesiredByFixture[b]).toBe(30);
  });

  it("does not restore another rule being renewed while retiring a receipt-expired rule of the same source", async () => {
    const f = await fixture(); f.snapshot.vehicleEventRules.push({ ...f.snapshot.vehicleEventRules[0]!, id: manual,
      targetFixtureIds: [c], holdSeconds: 60 }); rehash(f.snapshot);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const shortStartedAt = f.store.read().vehicleRules[rule]!.startedAt;
    f.advance(10000); f.onRead(() => { f.authority.observation.health = "degraded"; }); await f.runtime.tick(); f.onRead(() => undefined);
    f.authority.observation.health = "healthy"; f.authority.observation.healthySinceMonotonicMs = 11000;
    await f.runtime.setBioSourceHealth(a, "healthy", "qualified"); f.advance(61000);
    await f.runtime.recordVehicleSensorInput(f.pulse(2));
    expect(f.store.read().vehicleRules[rule]!.startedAt).toBe(shortStartedAt);
    expect(f.writes.filter(write => write.fixtureId === b)).toHaveLength(1);
    expect(f.writes.filter(write => write.fixtureId === c).map(write => write.configuration.configuredHighBrightnessPercent)).toEqual([80, 40, 80]);
  });

  it.each([false, true])("preserves an on-time arrival behind an already running deferred tick (manual=%s)", async takeover => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const startedAt = f.store.read().vehicleRules[rule]!.startedAt;
    if (takeover) {
      await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [b], brightnessPercent: 60, requestedAt: f.now().toISOString() });
      f.lamps.get(b)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
      await f.runtime.handoffManualTerminal(manual, [{ fixtureId: b, status: "succeeded", brightnessPercent: 60,
        faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    }
    let entered!: () => void; const enteredTrust = new Promise<void>(resolve => { entered = resolve; });
    let unblock!: (value: boolean) => void; const trust = new Promise<boolean>(resolve => { unblock = resolve; });
    f.clockTrust(() => { entered(); return trust; });
    f.advance(8000); const tick = f.runtime.tick(); await enteredTrust;
    f.advance(1000); const pulse = f.runtime.recordVehicleSensorInput(f.pulse(2)); // Actual arrival at t10, before dequeue.
    f.advance(2000); unblock(true); await tick; await pulse;
    expect(f.store.read().vehicleRules[rule]!.startedAt).toBe(startedAt);
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(takeover ? 60 : 80);
    expect(f.writes).toHaveLength(1);
    f.clockTrust(async () => true); f.advance(8000); await f.runtime.tick();
    expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(takeover ? 60 : 30);
  });

  it.each(["malformed", "unqualified", "connection-changed", "elapsed", "commit-failed"] as const)(
    "does not leave an expiry barrier after an ineligible or failed arrival (%s)", async failure => {
      const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
      let entered!: () => void; const enteredTrust = new Promise<void>(resolve => { entered = resolve; });
      let unblock!: (value: boolean) => void; const trust = new Promise<boolean>(resolve => { unblock = resolve; });
      f.clockTrust(() => { entered(); return trust; });
      f.advance(8000); const tick = f.runtime.tick(); await enteredTrust; f.advance(1000);
      const input = f.pulse(2);
      if (failure === "malformed") input.receipt.sequence = -1;
      if (failure === "unqualified") f.authority.independentlyQualified = false;
      if (failure === "commit-failed") f.reject(state => state.bioPulseInbox[a]?.receipt.sequence === 2);
      const pulse = f.runtime.recordVehicleSensorInput(input).catch(() => undefined);
      f.authority.independentlyQualified = true;
      if (failure === "connection-changed") {
        f.authority.connection.epoch = "new-connection"; f.authority.observation.connectionEpoch = "new-connection";
      }
      f.advance(failure === "elapsed" ? 11000 : 2000); unblock(true); await tick; await pulse;
      if (failure !== "commit-failed") expect(f.writes).toHaveLength(2);
      f.reject(() => false); f.clockTrust(async () => true); await f.runtime.tick();
      expect(f.store.read().bioPulseInbox[a]?.receipt.sequence).toBe(1);
      expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(true);
      expect(f.lamps.get(b)!.configuration.configuredHighBrightnessPercent).toBe(30);
      if (failure !== "commit-failed") expect(f.writes).toHaveLength(2);
    });

  it("bounds queued arrival barriers without extending hold from rejected overflow", async () => {
    const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    let entered!: () => void; const enteredTrust = new Promise<void>(resolve => { entered = resolve; });
    let unblock!: (value: boolean) => void; const trust = new Promise<boolean>(resolve => { unblock = resolve; });
    f.clockTrust(() => { entered(); return trust; }); f.advance(8000); const tick = f.runtime.tick(); await enteredTrust;
    f.advance(1000); const arrivals = Array.from({ length: 300 }, () => f.runtime.recordVehicleSensorInput(f.pulse(2)).catch(error => error));
    f.advance(11000); unblock(true); await tick;
    const results = await Promise.all(arrivals);
    expect(results.some(result => result instanceof Error && result.message === "bio_pulse_arrival_capacity")).toBe(true);
    expect(f.store.read().bioPulseInbox[a]?.receipt.sequence).toBe(1);
    expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(true);
    expect(f.writes.map(write => write.configuration.configuredHighBrightnessPercent)).toEqual([80, 30]);
  });

  it("blocks only the on-time rule when the same-source arrival is late for another rule", async () => {
    const f = await fixture(); f.snapshot.vehicleEventRules.push({ ...f.snapshot.vehicleEventRules[0]!, id: manual,
      targetFixtureIds: [c], holdSeconds: 60 }); rehash(f.snapshot);
    await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const startedAt = f.store.read().vehicleRules[manual]!.startedAt;
    let entered!: () => void; const enteredTrust = new Promise<void>(resolve => { entered = resolve; });
    let unblock!: (value: boolean) => void; const trust = new Promise<boolean>(resolve => { unblock = resolve; });
    f.clockTrust(() => { entered(); return trust; }); f.advance(58000); const tick = f.runtime.tick(); await enteredTrust;
    f.advance(1000); const pulse = f.runtime.recordVehicleSensorInput(f.pulse(2)); f.advance(2000); unblock(true);
    await tick; await pulse;
    expect(f.store.read().vehicleRules[manual]!.startedAt).toBe(startedAt);
    expect(f.writes.filter(write => write.fixtureId === c)).toHaveLength(1);
    expect(f.writes.filter(write => write.fixtureId === b).map(write => write.configuration.configuredHighBrightnessPercent)).toEqual([80, 30, 80]);
  });

  it.each(["read-back", "completion-commit"] as const)("retains manual retirement when a qualified pulse arrives during the last restore %s", async phase => {
    const f = await fixture([b, c]); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const startedAt = f.store.read().vehicleRules[rule]!.startedAt;
    await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [c], brightnessPercent: 60, requestedAt: f.now().toISOString() });
    f.lamps.get(c)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
    await f.runtime.handoffManualTerminal(manual, [{ fixtureId: c, status: "succeeded", brightnessPercent: 60,
      faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    let entered!: () => void; const restoring = new Promise<void>(resolve => { entered = resolve; });
    let unblock!: () => void; const readback = new Promise<void>(resolve => { unblock = resolve; });
    if (phase === "read-back") f.afterRestore(async () => { entered(); await readback; });
    else f.beforeWrite(async state => { if (state.bioActivationsByRule[rule]?.completed) { entered(); await readback; } });
    f.advance(10000); const tick = f.runtime.tick(); await restoring;
    f.advance(1000); const pulse = f.runtime.recordVehicleSensorInput(f.pulse(2));
    unblock(); await tick; await pulse;
    expect(f.store.read().vehicleRules[rule]!.startedAt).toBe(startedAt);
    expect(f.store.read().bioActivationsByRule[rule]).toMatchObject({ completed: false, releaseReason: null, retiredFixtureIds: [c] });
    expect(f.lamps.get(c)!.configuration.configuredHighBrightnessPercent).toBe(60);
    expect(f.store.read().bioTargetsByFixture[b]?.preState).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    expect(f.writes.filter(write => write.fixtureId === c)).toHaveLength(1);
    const records = f.store.read().pendingTelemetryHandoffs.flatMap(handoff => handoff.records);
    expect(records.filter(record => record.kind === "event_ended")).toHaveLength(phase === "read-back" ? 0 : 1);
    expect(records).toContainEqual(expect.objectContaining({ kind: "event_extended", payload: expect.objectContaining({
      reason: phase === "read-back" ? "bio_automatic_release_cancelled" : "bio_completed_release_reopened", previousRestores: [{ fixtureId: b, status: "succeeded",
        configuration: { configuredHighBrightnessPercent: 30, bioMode: "sensor" } }] }) }));
    if (phase === "completion-commit") expect(records.findIndex(record => record.kind === "event_ended"))
      .toBeLessThan(records.findIndex(record => record.payload.reason === "bio_completed_release_reopened"));
    f.advance(10000); await f.runtime.tick(); expect(f.lamps.get(c)!.configuration.configuredHighBrightnessPercent).toBe(60);
  });

  it.each(["operator", "operator-commit", "malformed", "stale", "stale-commit", "elapsed"] as const)(
    "completes verified restoration despite a nonreviving arrival during read-back (%s)", async path => {
      const f = await fixture(); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); const original = f.pulse();
      await f.runtime.recordVehicleSensorInput(original);
      let entered!: () => void; const restoring = new Promise<void>(resolve => { entered = resolve; });
      let unblock!: () => void; const readback = new Promise<void>(resolve => { unblock = resolve; });
      if (path.endsWith("-commit")) f.beforeWrite(async state => {
        if (state.bioActivationsByRule[rule]?.completed) { entered(); await readback; }
      });
      else f.afterRestore(async () => { entered(); await readback; });
      f.advance(10000);
      const release = path.startsWith("operator") ? f.runtime.releaseBioEvent(rule) : f.runtime.tick(); await restoring;
      f.advance(1000); const input = path.startsWith("stale") ? original : f.pulse(2);
      if (path === "malformed") input.receipt.sequence = -1;
      const pulse = f.runtime.recordVehicleSensorInput(input).catch(error => error);
      if (path === "elapsed") f.advance(10000);
      unblock(); await release; const result = await pulse;
      if (path.startsWith("operator")) expect(result).toMatchObject({ message: "bio_release_pending" });
      expect(f.store.read().bioActivationsByRule[rule]?.completed).toBe(true);
      expect(f.store.read().bioPulseInbox[a]?.receipt.sequence).toBe(1);
      expect(f.store.read().bioTargetsByFixture[b]?.restoreResult?.status).toBe("succeeded");
      expect(f.writes.map(write => write.configuration.configuredHighBrightnessPercent)).toEqual([80, 30]);
    });

  it.each(["completion", "receipt"] as const)("keeps truthful durable state if %s commit fails during token-bound revival", async failure => {
    const f = await fixture([b, c]); await f.runtime.activateBioPulseTestSnapshot(f.snapshot); await f.runtime.recordVehicleSensorInput(f.pulse());
    const startedAt = f.store.read().vehicleRules[rule]!.startedAt;
    await f.runtime.prepareManualControl({ sourceId: manual, fixtureIds: [c], brightnessPercent: 60, requestedAt: f.now().toISOString() });
    f.lamps.get(c)!.configuration = { configuredHighBrightnessPercent: 60, bioMode: "force-on" };
    await f.runtime.handoffManualTerminal(manual, [{ fixtureId: c, status: "succeeded", brightnessPercent: 60,
      faultCode: null, errorCode: null, occurredAt: f.now().toISOString() }]);
    let entered!: () => void; const committing = new Promise<void>(resolve => { entered = resolve; });
    let unblock!: () => void; const commit = new Promise<void>(resolve => { unblock = resolve; });
    f.beforeWrite(async state => { if (state.bioActivationsByRule[rule]?.completed) { entered(); await commit; } });
    f.reject(state => failure === "completion" ? state.bioActivationsByRule[rule]?.completed === true : state.bioPulseInbox[a]?.receipt.sequence === 2);
    f.advance(10000); const tick = f.runtime.tick().catch(error => error); await committing;
    f.advance(1000); const pulse = f.runtime.recordVehicleSensorInput(f.pulse(2)).catch(error => error);
    unblock(); const tickResult = await tick; const pulseResult = await pulse;
    expect(failure === "completion" ? tickResult : pulseResult).toMatchObject({ message: "automation_state_store_failed" });
    expect(f.store.read().bioActivationsByRule[rule]).toMatchObject({ startedAt, completed: failure === "receipt", retiredFixtureIds: [c] });
    expect(f.store.read().bioPulseInbox[a]?.receipt.sequence).toBe(failure === "receipt" ? 1 : 2);
    expect(f.store.read().bioTargetsByFixture[b]?.preState).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    if (failure === "receipt") expect(f.store.read().bioTargetsByFixture[b]?.restoreResult?.status).toBe("succeeded");
    expect(f.lamps.get(c)!.configuration.configuredHighBrightnessPercent).toBe(60);
    expect(f.writes.filter(write => write.fixtureId === c)).toHaveLength(1);
    const reloaded = new FileAutomationStateStore(f.path); await reloaded.initialize();
    expect(reloaded.read()).toEqual(f.store.read());
  });
});
