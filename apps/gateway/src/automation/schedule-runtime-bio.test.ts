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
  const writer = async (destination: string, value: unknown) => {
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
  let onRead: (() => void) | undefined;
  const port = {
    async readBioState(id: string) { onRead?.(); return structuredClone(lamps.get(id)!); },
    async restoreBioState(id: string, _target: BioVerifiedLampTarget, configuration: BioConfigurationState) {
      const durable = JSON.parse(await readFile(path, "utf8"));
      expect(durable.bioPulseInbox[a]).toBeDefined();
      expect(durable.bioTargetsByFixture[id].preState).not.toBeNull();
      expect(durable.pendingTelemetryHandoffs.length).toBeGreaterThan(0);
      writes.push({ fixtureId: id, configuration: { ...configuration } });
      if (failures.has(id)) throw new Error("unknown RF outcome");
      lamps.get(id)!.configuration = { ...configuration };
      return { ...configuration };
    }
  };
  const genericWrites: unknown[] = [];
  const make = async (enabled = true) => {
    const store = new FileAutomationStateStore(path, writer);
    const runtime = new ScheduleRuntime({ store, wallClock: now, monotonicClock: () => ms,
      clockTrust: { isTrusted: async () => true }, execute: async actions => {
        genericWrites.push(...actions);
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
    onRead: (callback: () => void) => { onRead = callback; }, wallOffset: (value: number) => { wallOffset = value; } };
}

function rehash(snapshot: AutomationSnapshotV2) {
  const { payloadHash: _hash, ...payload } = snapshot;
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : input;
  snapshot.payloadHash = `sha256:${createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")}`;
  return snapshot;
}

describe("synthetic V2 BIO scheduler integration; product gate remains OFF", () => {
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
    const { bioActivationsByRule: _activations, ...v8 } = emptyAutomationState();
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
});
