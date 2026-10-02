import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationSnapshotV2 } from "@led-control/shared";
import { automationSnapshot } from "./automation-test-fixtures";
import { FileAutomationStateStore } from "./automation-state-store";
import { createGatewayAutomationServices as createAutomationServices, connectBioPulseSource } from "../index";
import { BioSensorPulseSource } from "../bio/bio-sensor-pulse-source";
import type { BioSensorPulseCandidate } from "../bio/bio-command-codec";
import type { BioClientEvent } from "../bio/bio-dongle-client";
import type { BioTransportSnapshot } from "../bio/bio-usb-transport";
import type { BioConfigurationState, BioVerifiedLampTarget } from "../bio/bio-dongle-client";
import type { BioSourceAuthority } from "./bio-pulse-scheduler";

const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002";
const rule = "00000000-0000-4000-8000-000000000003";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function rehash(value: Omit<AutomationSnapshotV2, "payloadHash">): AutomationSnapshotV2 {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : input;
  return { ...value, payloadHash: `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}` };
}
async function fixture(qualified = true) {
  const path = await mkdtemp(join(tmpdir(), "product-bio-")); dirs.push(path);
  let ms = 1000; let healthy = true; let authorityPresent = qualified; let activeRevision = 4;
  let listener: ((value: BioSensorPulseCandidate) => void) | undefined;
  let authorityChanged: (() => void) | undefined;
  let mappingAddress = 1;
  const client = { sensorSourceSnapshot: (): BioTransportSnapshot => ({ state: "ready", generation: 1,
    ready: true, protocolReady: true, transportConnected: true }),
    onSensorPulseCandidate: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; },
    onSensorSourceState: (_callback: (state: BioTransportSnapshot) => void) => () => undefined,
    onEvent: (_callback: (event: BioClientEvent) => void) => () => undefined };
  const mapping = () => ({ fixtureId: a, nodeId: a, nativeUuid: "001122334455", deviceUuid: "bio:001122334455",
    logicalAddress: mappingAddress, firmware: "test", protocol: "crc16", status: "confirmed" as const, updatedAt: "2026-10-02T00:00:00Z" });
  const source = new BioSensorPulseSource({ client, mappings: { findByNativeUuid: async () => mapping(),
    findByFixtureId: async () => mapping(), onChange: () => () => undefined },
    profiles: qualified ? [{ id: "explicit-qualified-software-fixture", firmwareFingerprint: "fw", sensorFingerprint: "sensor", bodyHex: "03" }] : undefined,
    authority: { read: (_id, connection, request): BioSourceAuthority | null => authorityPresent ? {
      binding: { sourceFixtureId: a, nativeUuid: "001122334455", logicalAddress: 1, networkId: 2,
        capabilityRevision: 7, snapshotRevision: request?.snapshotRevision ?? activeRevision,
        profileId: "explicit-qualified-software-fixture", firmwareFingerprint: "fw", sensorFingerprint: "sensor" },
      independentlyQualified: true, connection, observation: { health: healthy ? "healthy" : "degraded",
        reason: healthy ? "qualified" : "liveness_failed", connectionEpoch: connection.epoch,
        connectionGeneration: connection.generation, healthySinceMonotonicMs: 0 }
    } : null, onChange: callback => { authorityChanged = callback; return () => { authorityChanged = undefined; }; } } });
  let configuration: BioConfigurationState = { configuredHighBrightnessPercent: 30, bioMode: "sensor" };
  const target: BioVerifiedLampTarget = { kind: "unicast", nativeUuid: "001122334466", logicalAddress: 2, networkId: 2 };
  const writes: BioConfigurationState[] = []; const reads: string[] = []; let failRestore = false;
  let onRead: (() => void) | undefined;
  const targetPort = {
    async readBioState(id: string) { reads.push(id); onRead?.(); return { target: { ...target }, configuration: { ...configuration } }; },
    async restoreBioState(_id: string, _target: BioVerifiedLampTarget, value: BioConfigurationState) {
      writes.push({ ...value }); if (failRestore) throw new Error("outcome unknown"); configuration = { ...value }; return { ...value };
    }
  };
  let saved: AutomationSnapshotV2 | null = null; const errors: unknown[] = [];
  const genericWrites: unknown[] = [];
  const services = createAutomationServices({ scope: { siteId: a, gatewayId: b }, adapterKind: "bio-usb",
    stateStore: new FileAutomationStateStore(join(path, "state.json")),
    configStore: { load: async () => saved, apply: async snapshot => { saved = snapshot as AutomationSnapshotV2; }, restore: async snapshot => { saved = snapshot as AutomationSnapshotV2 | null; } },
    clockTrust: { isTrusted: async () => true }, wallClock: () => new Date(Date.UTC(2026, 9, 2) + ms), monotonicClock: () => ms,
    execute: async actions => actions.map(action => {
      genericWrites.push(action);
      configuration = { configuredHighBrightnessPercent: action.brightnessPercent, bioMode: "force-on" };
      return { fixtureId: action.fixtureId, status: "succeeded" as const, brightnessPercent: action.brightnessPercent,
        faultCode: null, errorCode: null, occurredAt: new Date(Date.UTC(2026, 9, 2) + ms).toISOString() };
    }), bioProductPulse: { source, targetPort, scope: { siteId: a, gatewayId: b } } });
  await services.scheduleRuntime.initialize(); await services.automationRuntime.initialize();
  const connection = connectBioPulseSource(source, services.scheduleRuntime, error => { errors.push(error); });
  const snapshot = (revision = 4, status: "enabled" | "disabled" = "enabled") => rehash({ schemaVersion: 2,
    siteId: a, gatewayId: b, revision, timeZone: "UTC", schedules: [], generatedAt: "2026-10-02T00:00:00Z",
    vehicleEventRules: [{ id: rule, name: "Explicit qualified software fixture", status, sensorProtocol: "bio-usb-pulse",
      sourceFixtureIds: [a], targetFixtureIds: [b], action: { dimmingEnabled: true, brightnessPercent: 80 }, holdSeconds: 10 }] });
  return { ...services, source, connection, writes, reads, errors, snapshot, targetPort, genericWrites,
    pulse: (sequence = 1) => listener?.({ kind: "sensor-status-candidate", innerOpcode: 9, innerBody: Buffer.from([3]), generation: 1,
      receivedMonotonicMs: ms, deviceUuid: "bio:001122334455", logicalAddress: 1, networkId: 2, destination: 0,
      rssiDbm: -40, ttl: 1, control: false, sequence }),
    advance: (amount: number) => { ms += amount; }, configuration: () => ({ ...configuration }),
    unhealthy: () => { healthy = false; authorityChanged?.(); }, revoke: () => { authorityPresent = false; authorityChanged?.(); },
    changeMapping: () => { mappingAddress = 2; }, failRestore: () => { failRestore = true; },
    revision: (value: number) => { activeRevision = value; authorityChanged?.(); },
    onRead: (callback: () => void) => { onRead = callback; } };
}

describe("production BIO local bootstrap/lifecycle (software qualification only)", () => {
  it("preserves V1 and no-BIO V2 configuration/ACK without qualified hardware", async () => {
    const f = await fixture(false);
    const v1 = automationSnapshot(1, { siteId: a, gatewayId: b });
    await expect(f.automationRuntime.hotReload(v1)).resolves.toMatchObject({ schemaVersion: 1, payloadHash: v1.payloadHash });
    const { payloadHash: _hash, ...value } = f.snapshot(2);
    const v2 = rehash({ ...value, vehicleEventRules: [] });
    await expect(f.automationRuntime.hotReload(v2)).resolves.toMatchObject({ schemaVersion: 2, payloadHash: v2.payloadHash });
    expect(f.scheduleRuntime.currentSnapshot).toEqual(v2); expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
    await f.connection.stopAndDrain(); f.source.stop();
  });

  it.each(["scope", "hash", "old-revision"])("rejects %s before any target RF or new activation", async kind => {
    const f = await fixture(); await f.automationRuntime.hotReload(f.snapshot());
    let next = f.snapshot(5);
    if (kind === "scope") { const { payloadHash: _hash, ...value } = next; next = rehash({ ...value, gatewayId: rule }); }
    if (kind === "hash") next = { ...next, payloadHash: `sha256:${"0".repeat(64)}` };
    if (kind === "old-revision") next = f.snapshot(3);
    await expect(f.automationRuntime.hotReload(next)).rejects.toThrow();
    expect(f.automationRuntime.currentRevision).toBe(4); expect(f.writes).toEqual([]); expect(f.reads).toEqual([]);
    await f.connection.stopAndDrain(); f.source.stop();
  });
  it("installs a qualified canonical snapshot without a pulse, consumes the actual source, and exactly restores on expiry", async () => {
    const f = await fixture(); const snapshot = f.snapshot();
    await expect(f.automationRuntime.hotReload(snapshot)).resolves.toMatchObject({ status: "applied", revision: 4, payloadHash: snapshot.payloadHash });
    expect(f.scheduleRuntime.currentSnapshot).toEqual(snapshot); expect(f.writes).toEqual([]);
    f.pulse(); await vi.waitFor(() => expect(f.writes).toEqual([{ configuredHighBrightnessPercent: 80, bioMode: "force-on" }]));
    f.advance(11000); await f.scheduleRuntime.tick();
    expect(f.writes).toEqual([{ configuredHighBrightnessPercent: 80, bioMode: "force-on" }, { configuredHighBrightnessPercent: 30, bioMode: "sensor" }]);
    expect(f.scheduleRuntime.state().bioActivationsByRule[rule].completed).toBe(true);
    await f.connection.stopAndDrain(); await f.scheduleRuntime.stopAndDrain(); f.source.stop();
  });

  it("keeps the unqualified production path OFF but accepts disabled V2 with original hash and no RF", async () => {
    const f = await fixture(false);
    await expect(f.automationRuntime.hotReload(f.snapshot())).rejects.toThrow("bio_pulse_control_unavailable");
    const draft = f.snapshot(4, "disabled");
    await expect(f.automationRuntime.hotReload(draft)).resolves.toMatchObject({ status: "applied", payloadHash: draft.payloadHash });
    expect(f.scheduleRuntime.currentSnapshot).toEqual(draft); expect(f.reads).toEqual([]); expect(f.writes).toEqual([]);
    await f.connection.stopAndDrain(); f.source.stop();
  });

  it("restores old exact targets before disabled replacement, retains unknown outcomes and refuses a false new applied", async () => {
    const f = await fixture(); await f.automationRuntime.hotReload(f.snapshot());
    f.pulse(); await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.failRestore(); await expect(f.automationRuntime.hotReload(f.snapshot(5, "disabled"))).rejects.toThrow();
    expect(f.automationRuntime.currentRevision).toBe(4);
    expect(f.scheduleRuntime.state().bioTargetsByFixture[b].restoreResult?.status).toBe("timed_out");
    expect(f.scheduleRuntime.state().bioActivationsByRule[rule].completed).toBe(false);
    expect(f.scheduleRuntime.state().pendingTelemetryHandoffs.length).toBeGreaterThan(0);
    await f.connection.stopAndDrain(); f.source.stop();
  });

  it("freezes healthy expiry after revocation but explicit release needs surviving exact identity authority", async () => {
    const f = await fixture(); await f.automationRuntime.hotReload(f.snapshot());
    f.pulse(); await vi.waitFor(() => expect(f.writes).toHaveLength(1)); f.unhealthy();
    f.advance(11000); await f.scheduleRuntime.tick(); expect(f.writes).toHaveLength(1);
    await f.scheduleRuntime.releaseBioEvent(rule); expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    await f.connection.stopAndDrain(); f.source.stop();
  });

  it.each(["mapping", "authority"])("cannot restore an old activation using changed/lost %s", async kind => {
    const f = await fixture(); await f.automationRuntime.hotReload(f.snapshot());
    f.pulse(); await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    if (kind === "mapping") f.changeMapping(); else f.revoke();
    await f.scheduleRuntime.releaseBioEvent(rule);
    expect(f.writes).toHaveLength(1); expect(f.scheduleRuntime.state().bioActivationsByRule[rule].completed).toBe(false);
    expect(f.scheduleRuntime.state().bioTargetsByFixture[b].preState).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    await f.connection.stopAndDrain(); f.source.stop();
  });

  it("revalidates source mapping after target GET before any SET", async () => {
    const f = await fixture(); await f.automationRuntime.hotReload(f.snapshot());
    f.onRead(() => f.changeMapping()); f.pulse();
    await vi.waitFor(() => expect(f.reads).toHaveLength(1)); await f.scheduleRuntime.tick();
    expect(f.writes).toEqual([]); expect(f.scheduleRuntime.state().bioTargetsByFixture[b].preState).toBeNull();
    await f.connection.stopAndDrain(); f.source.stop();
  });

  it("restores before replacing an enabled snapshot and admits only the new bound revision", async () => {
    const f = await fixture(); await f.automationRuntime.hotReload(f.snapshot());
    f.pulse(); await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    const next = f.snapshot(5); await expect(f.automationRuntime.hotReload(next)).resolves.toMatchObject({ status: "applied", revision: 5 });
    expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    expect(f.writes).toHaveLength(2); expect(f.scheduleRuntime.currentSnapshot).toEqual(next);
    f.revision(5); f.advance(100); f.pulse(2); await vi.waitFor(() => expect(f.writes).toHaveLength(3));
    expect(f.scheduleRuntime.state().bioActivationsByRule[rule].binding.snapshotRevision).toBe(5);
    await f.connection.stopAndDrain(); await f.scheduleRuntime.stopAndDrain(); f.source.stop();
  });

  it("unsubscribes and blocks queued target operations during scheduler stop/drain", async () => {
    const f = await fixture(); await f.automationRuntime.hotReload(f.snapshot());
    let release!: () => void;
    const original = f.targetPort.readBioState;
    f.targetPort.readBioState = async id => { const result = await original(id); await new Promise<void>(resolve => { release = resolve; }); return result; };
    f.pulse(); await vi.waitFor(() => expect(f.reads).toHaveLength(1));
    const intake = f.connection.stopAndDrain(); const scheduler = f.scheduleRuntime.stopAndDrain();
    release(); await Promise.all([intake, scheduler]); f.pulse(2);
    expect(f.writes).toEqual([]); expect(f.scheduleRuntime.state().bioTargetsByFixture[b].preState).toBeNull(); f.source.stop();
  });

  it("preserves event-over-schedule priority using the same exact target configuration port", async () => {
    const f = await fixture(); await f.scheduleRuntime.recordFixtureState(b, 30);
    const { payloadHash: _hash, ...value } = f.snapshot();
    const snapshot = rehash({ ...value, schedules: [{ id: "00000000-0000-4000-8000-000000000004", name: "Base", status: "enabled",
      activeFrom: "2026-10-01T00:00:00Z", activeUntil: "2026-10-03T00:00:00Z", localStartTime: "00:00", localEndTime: "01:00",
      recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
      action: { dimmingEnabled: true, brightnessPercent: 20 }, fixtureIds: [b] }] });
    await f.automationRuntime.hotReload(snapshot); expect(f.configuration().configuredHighBrightnessPercent).toBe(20);
    f.pulse(); await vi.waitFor(() => expect(f.configuration().configuredHighBrightnessPercent).toBe(80));
    f.advance(11000); await f.scheduleRuntime.tick();
    expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 20, bioMode: "force-on" });
    expect(f.writes).toEqual([{ configuredHighBrightnessPercent: 80, bioMode: "force-on" }, { configuredHighBrightnessPercent: 20, bioMode: "force-on" }]);
    await f.connection.stopAndDrain(); f.source.stop();
  });

  it("rolls back canonical snapshot metadata after activation failure without erasing restored target truth", async () => {
    const f = await fixture(); const original = f.snapshot(); await f.automationRuntime.hotReload(original);
    f.pulse(); await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    vi.spyOn(f.scheduleRuntime, "commitActivation").mockRejectedValueOnce(new Error("activation failed"));
    await expect(f.automationRuntime.hotReload(f.snapshot(5, "disabled"))).rejects.toThrow();
    expect(f.automationRuntime.currentSnapshot).toEqual(original); expect(f.scheduleRuntime.currentSnapshot).toEqual(original);
    const state = f.scheduleRuntime.state();
    expect(state.bioTargetsByFixture[b].restoreResult?.status).toBe("succeeded");
    expect(state.bioActivationsByRule[rule].completed).toBe(true); expect(state.pendingTelemetryHandoffs.length).toBeGreaterThan(0);
    expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    await f.connection.stopAndDrain(); f.source.stop();
  });
});
