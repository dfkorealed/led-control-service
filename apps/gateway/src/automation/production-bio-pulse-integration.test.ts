import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationSnapshotV2 } from "@led-control/shared";
import { automationSnapshot } from "./automation-test-fixtures";
import { FileAutomationStateStore } from "./automation-state-store";
import { createGatewayAutomationServices as createAutomationServices, connectBioPulseSource } from "../index";
import * as bootstrap from "../index";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import { writeJsonAtomic } from "../mesh/mesh-store-file";
import { AutomationTelemetryGapJournal } from "./automation-telemetry-gap-journal";
import { BioSensorPulseSource } from "../bio/bio-sensor-pulse-source";
import type { BioSensorPulseCandidate } from "../bio/bio-command-codec";
import type { BioClientEvent } from "../bio/bio-dongle-client";
import type { BioTransportSnapshot } from "../bio/bio-usb-transport";
import type { BioConfigurationState, BioVerifiedLampTarget } from "../bio/bio-dongle-client";
import { BioPulseControlCore, type BioSourceAuthority } from "./bio-pulse-scheduler";
import { CommissionedBioPulseAuthorityProvider } from "../bio/bio-pulse-authority-provider";
import { BioTemporaryControlRuntime } from "./bio-temporary-control-runtime";
import { TemporaryControlResultOutbox } from "./temporary-control-result-outbox";

const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002";
const rule = "00000000-0000-4000-8000-000000000003";
const c = "00000000-0000-4000-8000-000000000006";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function rehash(value: Omit<AutomationSnapshotV2, "payloadHash">): AutomationSnapshotV2 {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === "object"
    ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : input;
  return { ...value, payloadHash: `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}` };
}
async function fixture(qualified = true, extraTarget = false, nativeSelf?: import("./schedule-runtime").ScheduleRuntimeOptions["nativeSelf"]) {
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
  let extraConfiguration: BioConfigurationState = { configuredHighBrightnessPercent: 35, bioMode: "sensor" };
  const target: BioVerifiedLampTarget = { kind: "unicast", nativeUuid: "001122334466", logicalAddress: 2, networkId: 2 };
  const writes: BioConfigurationState[] = []; const reads: string[] = []; let failRestore = false;
  let onRead: (() => void) | undefined;
  const targetPort = {
    async readBioState(id: string) { reads.push(id); onRead?.(); return { target: id === c ? { ...target, nativeUuid: "001122334477", logicalAddress: 3 } : { ...target },
      configuration: { ...(id === c ? extraConfiguration : configuration) } }; },
    async restoreBioState(id: string, _target: BioVerifiedLampTarget, value: BioConfigurationState) {
      writes.push({ ...value }); if (failRestore) throw new Error("outcome unknown");
      if (id === c) extraConfiguration = { ...value }; else configuration = { ...value }; return { ...value };
    }
  };
  let saved: AutomationSnapshotV2 | null = null; const errors: unknown[] = [];
  const genericWrites: unknown[] = [];
  let storageFailure = false;
  const store = new FileAutomationStateStore(join(path, "state.json"), async (path, state) => {
    if (storageFailure) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    await writeJsonAtomic(path, state);
  }, undefined, { gapJournal: new AutomationTelemetryGapJournal(join(path, "gap")) });
  const createServices = (stateStore = store) => createAutomationServices({ scope: { siteId: a, gatewayId: b }, adapterKind: "bio-usb",
    stateStore, bioNormalAssignmentVersion: 1, ...(nativeSelf ? { nativeSelf } : {}),
    configStore: { load: async () => saved, apply: async snapshot => { saved = snapshot as AutomationSnapshotV2; }, restore: async snapshot => { saved = snapshot as AutomationSnapshotV2 | null; } },
    clockTrust: { isTrusted: async () => true }, wallClock: () => new Date(Date.UTC(2026, 9, 2) + ms), monotonicClock: () => ms,
    execute: async actions => actions.map(action => {
      genericWrites.push(action);
      configuration = { configuredHighBrightnessPercent: action.brightnessPercent, bioMode: "force-on" };
      return { fixtureId: action.fixtureId, status: "succeeded" as const, brightnessPercent: action.brightnessPercent,
        faultCode: null, errorCode: null, occurredAt: new Date(Date.UTC(2026, 9, 2) + ms).toISOString() };
    }), bioProductPulse: { source, targetPort, scope: { siteId: a, gatewayId: b } } });
  const services = createServices();
  await services.scheduleRuntime.initialize(); await services.automationRuntime.initialize();
  const connection = connectBioPulseSource(source, services.scheduleRuntime, error => { errors.push(error); });
  const snapshot = (revision = 4, status: "enabled" | "disabled" = "enabled") => rehash({ schemaVersion: 2,
    siteId: a, gatewayId: b, revision, timeZone: "UTC", schedules: [], generatedAt: "2026-10-02T00:00:00Z",
    vehicleEventRules: [{ id: rule, name: "Explicit qualified software fixture", status, sensorProtocol: "bio-usb-pulse",
      sourceFixtureIds: [a], targetFixtureIds: extraTarget ? [b, c] : [b], action: { dimmingEnabled: true, brightnessPercent: 80 }, holdSeconds: 10 }] });
  return { ...services, source, connection, writes, reads, errors, snapshot, targetPort, genericWrites, store,
    now: () => new Date(Date.UTC(2026, 9, 2) + ms),
    failStorage: () => { storageFailure = true; },
    pulse: (sequence = 1) => listener?.({ kind: "sensor-status-candidate", innerOpcode: 9, innerBody: Buffer.from([3]), generation: 1,
      receivedMonotonicMs: ms, deviceUuid: "bio:001122334455", logicalAddress: 1, networkId: 2, destination: 0,
      rssiDbm: -40, ttl: 1, control: false, sequence }),
    advance: (amount: number) => { ms += amount; }, configuration: () => ({ ...configuration }),
    unhealthy: () => { healthy = false; authorityChanged?.(); }, revoke: () => { authorityPresent = false; authorityChanged?.(); },
    changeMapping: () => { mappingAddress = 2; }, failRestore: () => { failRestore = true; },
    revision: (value: number) => { activeRevision = value; authorityChanged?.(); },
    extraConfiguration: () => ({ ...extraConfiguration }),
    restart: async () => { await connection.stopAndDrain(); const nextStore = new FileAutomationStateStore(join(path, "state.json"));
      const next = createServices(nextStore); await next.scheduleRuntime.initialize(); await next.automationRuntime.initialize(); return { ...next, store: nextStore }; },
    onRead: (callback: () => void) => { onRead = callback; } };
}

describe("production BIO local bootstrap/lifecycle (software qualification only)", () => {
  it("applies self-only native configuration before ACK without creating a pulse force-output activation", async () => {
    let native = false;
    const f = await fixture(true, false, { initialize: async () => {}, reconcile: async snapshot => {
      native = !!(snapshot?.schemaVersion === 3 && snapshot.vehicleEventRules.some(rule => rule.status === "enabled" && rule.selfControlEnabled));
    }, rollback: async () => { native = false; }, protectedFixtureIds: () => native ? [a] : [] });
    try {
      const { payloadHash: _hash, ...base } = f.snapshot();
      const snapshot = rehash({ ...base, schemaVersion: 3, holidayDatasets: [], vehicleEventRules: base.vehicleEventRules.map(rule => ({ ...rule, selfControlEnabled: true, targetFixtureIds: [] })) } as never);
      const ack = await f.automationRuntime.hotReload(snapshot);
      expect(ack.status).toBe("applied"); expect(native).toBe(true);
      f.pulse(); await new Promise(resolve => setTimeout(resolve, 20));
      expect(f.store.read().vehicleRules).toEqual({}); expect(f.store.read().bioActivationsByRule).toEqual({});
      expect(f.writes).toEqual([]); expect(f.genericWrites).toEqual([]);
      const { payloadHash: _nativeHash, ...nativeBody } = snapshot;
      await f.automationRuntime.hotReload(rehash({ ...nativeBody, schemaVersion: 3, revision: 5, vehicleEventRules: [] } as never));
      expect(native).toBe(false);
    } finally { await f.connection.stopAndDrain(); f.source.stop(); }
  });
  it.each([false, true])("skip proof never erases prior uncertainty and clears before a live renewed capture (prior uncertain=%s)", async uncertain => {
    const f = await fixture(true, true);
    const runtime = new BioTemporaryControlRuntime({ store: f.store, now: f.now, clockTrust: { isTrusted: async () => true },
      preflight: async () => {}, port: { read: async () => { throw new Error("unexpected temporary GET"); },
        apply: async () => { throw new Error("unexpected apply"); }, restore: async () => { throw new Error("unexpected restore"); } } });
    try {
      await f.automationRuntime.hotReload(f.snapshot());
      const before = { activationId: "prior-uncertain", sourceFixtureId: a, eventBrightnessPercent: 80,
        target: { kind: "unicast" as const, nativeUuid: "001122334466", logicalAddress: 2, networkId: 2 },
        preState: { configuredHighBrightnessPercent: 30, bioMode: "sensor" as const },
        applyResult: { status: "timed_out" as const, attempt: 1, at: f.now().toISOString(), observed: null }, restoreResult: null };
      if (uncertain) await f.store.updateDurable(state => { state.bioTargetsByFixture[b] = before; return state; });
      const payload = { schemaVersion: 1 as const, kind: "end" as const, sessionRevision: 2 as const,
        sessionId: "00000000-0000-4000-8000-000000000099", siteId: a, gatewayId: b, assignmentVersion: 1,
        admissionRevision: 4, sequence: 1, originSequence: 1, originCommandHash: bioEnvelopeHash({ origin: true }),
        endsAt: new Date(f.now().getTime() + 60_000).toISOString(), targets: [{ fixtureId: b, meshNodeId: b,
          nativeUuid: "001122334466", logicalAddress: "0x0002", applyGeneration: "1", releaseGeneration: "2" }] };
      const end = { ...payload, payloadHash: bioEnvelopeHash(payload) };
      await runtime.accept(end);
      f.pulse(); await vi.waitFor(() => expect(f.extraConfiguration().configuredHighBrightnessPercent).toBe(80));
      if (uncertain) {
        expect(f.store.read().bioActivationsByRule[rule]!.skippedFixtureIds).toEqual([]);
        await f.scheduleRuntime.releaseBioEvent(rule);
        expect(f.store.read().bioActivationsByRule[rule]!.completed).toBe(false);
        expect(f.store.read().bioTargetsByFixture[b]).toEqual(before);
      } else {
        expect(f.store.read().bioActivationsByRule[rule]!.skippedFixtureIds).toEqual([b]);
        await runtime.expire(f.now());
        const proof = f.store.read().temporaryEndProofs[end.sessionId]![b]!;
        const { schemaVersion, eventId, sessionId, siteId, gatewayId, assignmentVersion, admissionRevision, originCommandHash,
          originSequence, sessionRevision, targetGeneration, resultHash } = proof;
        await new TemporaryControlResultOutbox(f.store, end).confirm({ schemaVersion, eventId, sessionId, siteId, gatewayId,
          assignmentVersion, admissionRevision, originCommandHash, originSequence, sessionRevision, targetGeneration, resultHash,
          status: "applied", reason: null, ingestedAt: f.now().toISOString() });
        f.advance(100); f.pulse(2); await vi.waitFor(() => expect(f.configuration().configuredHighBrightnessPercent).toBe(80));
        expect(f.store.read().bioActivationsByRule[rule]!.skippedFixtureIds).toEqual([]);
        expect(f.store.read().bioTargetsByFixture[b]!.preState).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
      }
    } finally { await runtime.stopAndDrain(); await f.connection.stopAndDrain(); f.source.stop(); }
  });
  // Break caught: an event with one lease-suppressed target must relinquish
  // ownership without pulse renewal, RF/readback fabrication, or manual retirement.
  it.each(["expiry", "operator", "restart", "replacement"])("closes skipped event target after temporary settlement and permits subsequent automation (%s)", async mode => {
    const f = await fixture(true, true);
    let temporary: BioTemporaryControlRuntime | undefined;
    try {
      const { payloadHash: _hash, ...base } = f.snapshot();
      const snapshot = rehash({ ...base, schemaVersion: 3, holidayDatasets: [] } as never);
      await f.automationRuntime.hotReload(snapshot);
      const startedAt = f.now().toISOString(), sessionId = "00000000-0000-4000-8000-000000000099";
      const payload = { schemaVersion: 1 as const, kind: "start" as const, sessionId, sessionRevision: 1 as const,
        siteId: a, gatewayId: b, assignmentVersion: 1, admissionRevision: 4, sequence: 1, brightness: 60,
        startedAt, endsAt: new Date(f.now().getTime() + 60_000).toISOString(), targets: [{ fixtureId: b, meshNodeId: b,
          nativeUuid: "001122334466", logicalAddress: "0x0002", applyGeneration: "1", releaseGeneration: "2" }] };
      const command = { ...payload, payloadHash: bioEnvelopeHash(payload) };
      let current: Pick<typeof f, "store" | "automationRuntime" | "scheduleRuntime"> = f;
      const options: ConstructorParameters<typeof BioTemporaryControlRuntime>[0] = { store: f.store, now: f.now, snapshot: () => current.automationRuntime.currentAppliedSnapshot,
        clockTrust: { isTrusted: async () => true }, preflight: async () => {}, releasePreflight: async () => {}, port: {
          read: async (id, control) => { await control.beforeWrite?.(); return f.targetPort.readBioState(id); },
          apply: async (id, brightness, control) => { await control.beforeMutation("high_brightness"); await control.beforeWrite?.();
            if (!control.mayStartWrite?.()) throw new Error("veto"); control.onWriteStarted?.();
            const physical = await f.targetPort.readBioState(id);
            await f.targetPort.restoreBioState(id, physical.target, { configuredHighBrightnessPercent: brightness, bioMode: "force-on" });
            return { brightnessPercent: brightness, mode: "force-on" }; },
          restore: async (id, target, goal, control) => { await control.beforeMutation("high_brightness"); await control.beforeWrite?.();
            if (!control.mayStartWrite?.()) throw new Error("veto"); control.onWriteStarted?.(); return f.targetPort.restoreBioState(id, target, goal); }
        } };
      temporary = new BioTemporaryControlRuntime(options);
      await temporary.accept(command, { generatedAt: f.now().getTime(), expiresAt: f.now().getTime() + 10_000 });
      expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 60, bioMode: "force-on" });
      f.pulse(); await vi.waitFor(() => expect(f.extraConfiguration().configuredHighBrightnessPercent).toBe(80));
      expect(f.store.read().bioTargetsByFixture[b]).toBeUndefined();
      if (mode === "restart") {
        await temporary.stopAndDrain(); current = await f.restart();
        temporary = new BioTemporaryControlRuntime({ ...options, store: current.store });
        expect(current.store.read().bioActivationsByRule[rule]!.skippedFixtureIds).toEqual([b]);
        await current.scheduleRuntime.tick(); // Establish existing fresh-health restart hold.
      }
      const writesBefore = f.writes.length;
      if (mode === "operator") await current.scheduleRuntime.releaseBioEvent(rule);
      else { f.advance(11_000); await current.scheduleRuntime.tick(); }
      expect(f.configuration().configuredHighBrightnessPercent).toBe(60);
      expect(f.extraConfiguration()).toEqual({ configuredHighBrightnessPercent: 35, bioMode: "sensor" });
      expect(f.writes.length).toBe(writesBefore + 1);
      f.advance(60_000); await temporary.expire(f.now());
      const proof = current.store.read().temporarySessions[sessionId]!.targets[b]!.releaseResult!;
      const { schemaVersion, eventId, siteId, gatewayId, assignmentVersion, admissionRevision, originCommandHash,
        originSequence, sessionRevision, targetGeneration, resultHash } = proof;
      await new TemporaryControlResultOutbox(current.store, command).confirm({ schemaVersion, eventId, sessionId, siteId, gatewayId,
        assignmentVersion, admissionRevision, originCommandHash, originSequence, sessionRevision, targetGeneration, resultHash,
        status: "applied", reason: null, ingestedAt: f.now().toISOString() });
      await current.scheduleRuntime.tick();
      expect(current.store.read().bioActivationsByRule[rule]!.completed).toBe(true);
      expect(current.store.read().bioActivationsByRule[rule]!.retiredFixtureIds).toEqual([]);
      expect(current.store.read().bioTargetsByFixture[b]).toBeUndefined();
      if (mode === "replacement") {
        // NB1: a completed A's RF0 history cannot prohibit a later rule B's real
        // capture and RF after replacement. Keep A's proof intact throughout.
        const historical = current.store.read().bioActivationsByRule[rule]!;
        const replacementRule = "00000000-0000-4000-8000-000000000009";
        await current.automationRuntime.hotReload(rehash({ ...base, revision: 5, schemaVersion: 3, holidayDatasets: [],
          vehicleEventRules: [{ ...base.vehicleEventRules[0]!, id: replacementRule, name: "replacement B", targetFixtureIds: [b],
            action: { dimmingEnabled: true, brightnessPercent: 70 } }] } as never));
        expect(current.store.read().bioActivationsByRule[rule]).toEqual(historical);
        const beforePulse = f.writes.length;
        f.revision(5); // External software authority must attest B's installed revision.
        f.advance(100); f.pulse(2);
        await vi.waitFor(() => {
          expect(f.errors).toEqual([]);
          expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 70, bioMode: "force-on" });
        });
        expect(f.errors).toEqual([]);
        expect(f.writes).toHaveLength(beforePulse + 1);
        expect(current.store.read().bioTargetsByFixture[b]).toMatchObject({
          activationId: `${replacementRule}:${f.now().toISOString()}`,
          preState: { configuredHighBrightnessPercent: 30, bioMode: "sensor" },
          applyResult: { status: "succeeded", observed: { configuredHighBrightnessPercent: 70, bioMode: "force-on" } }, restoreResult: null
        });
        expect(current.store.read().bioActivationsByRule[rule]).toEqual(historical);
        return;
      }
      (current.scheduleRuntime as any).setBioNormalAuthority({ preflight: async () => {}, current: () => true });
      const schedule = { id: "00000000-0000-4000-8000-000000000008", name: "after settlement", status: "enabled",
        activeFrom: "2026-10-02T00:00:00Z", activeUntil: "2026-10-03T00:00:00Z", localStartTime: "00:00", localEndTime: "01:00",
        excludeWeekends: false, excludeHolidays: false, recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
        action: { dimmingEnabled: true, brightnessPercent: 45 }, fixtureIds: [b] };
      await current.automationRuntime.hotReload(rehash({ ...base, revision: 5, schemaVersion: 3, holidayDatasets: [], schedules: [schedule] } as never));
      await current.scheduleRuntime.tick();
      expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 45, bioMode: "force-on" });
    } finally { await temporary?.stopAndDrain(); await f.connection.stopAndDrain(); f.source.stop(); }
  });
  it("preserves independent sensor-normal authority after a temporary lease is settled", async () => {
    const f = await fixture();
    try {
      const { payloadHash: _hash, ...base } = f.snapshot();
      await f.automationRuntime.hotReload(rehash({ ...base, schemaVersion: 3, holidayDatasets: [] } as never));
      await f.store.updateDurable(state => {
        state.baseBrightnessByFixture[b] = 30; state.lastDesiredByFixture[b] = 80;
        state.bioNormalConfigurations[b] = { identity: { fixtureId: b, meshNodeId: b, nativeUuid: "001122334466", logicalAddress: "0x0002" },
          siteId: a, gatewayId: b, assignmentVersion: 1, networkId: 2, configuration: f.configuration(), observedAt: f.now().toISOString(),
          baselineBrightness: 30, snapshotRevision: 4, snapshotPayloadHash: f.automationRuntime.currentSnapshot!.payloadHash }; return state;
      });
      await f.scheduleRuntime.tick();
      expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
      expect(f.genericWrites).toEqual([]);
      const read = await f.targetPort.readBioState(b);
      await f.targetPort.restoreBioState(b, read.target, { configuredHighBrightnessPercent: 70, bioMode: "force-on" });
      await f.scheduleRuntime.tick();
      expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 70, bioMode: "force-on" });
      (f.scheduleRuntime as any).setBioNormalAuthority({ preflight: async () => {}, current: () => true });
      await f.scheduleRuntime.tick();
      expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
      await f.automationRuntime.hotReload(automationSnapshot(5, { siteId: a, gatewayId: b, vehicleEventRules: [], schedules: [] }));
      f.failStorage();
      await expect(f.scheduleRuntime.prepareManualControl({ sourceId: rule, fixtureIds: [b], brightnessPercent: 20,
        requestedAt: f.now().toISOString() })).rejects.toThrow();
      expect(f.store.read().bioNormalConfigurations[b]).toBeDefined();
    } finally { await f.connection.stopAndDrain(); f.source.stop(); }
  });
  it.each(["none", "source", "mapping-await", "mapping-native", "handoff"])("wires temporary owner guard through the final native frame (%s)", async race => {
    const f = await fixture(); const create = (bootstrap as any).createGatewayTemporaryControlServices;
    expect(create).toBeTypeOf("function");
    let guard: ((id: string) => boolean) | undefined;
    let mappedAddress = 2;
    let mappingRace = false;
    const mappingListeners = new Set<() => void>();
    const changeMapping = () => { mappedAddress = 3; for (const listener of mappingListeners) listener(); };
    const port = { read: f.targetPort.readBioState,
      apply: async (id: string, brightness: number, control: any) => {
        expect(guard?.(id)).toBe(true); await control.beforeMutation("high_brightness");
        mappingRace = race === "mapping-await"; await control.beforeWrite();
        if (race === "source") f.unhealthy();
        if (race === "mapping-native") changeMapping();
        if (!control.mayStartWrite()) throw new Error("submission veto");
        const observed = await f.targetPort.readBioState(id);
        await f.targetPort.restoreBioState(id, observed.target, { configuredHighBrightnessPercent: brightness, bioMode: "force-on" });
        control.onWriteStarted?.(); return { brightnessPercent: brightness, mode: "force-on" };
      }, restore: async (id: string, target: any, configuration: any, control: any) => {
        await control.beforeMutation("high_brightness"); await control.beforeWrite();
        return f.targetPort.restoreBioState(id, target, configuration);
      } };
    const services = create({ store: f.store, automationRuntime: f.automationRuntime, scheduleRuntime: f.scheduleRuntime,
      scope: { siteId: a, gatewayId: b, assignmentVersion: 1 }, clockTrust: { isTrusted: async () => true }, now: f.now,
      adapter: { setBioTemporaryLeaseGuard: (value: typeof guard) => { guard = value; }, temporaryTargetPort: () => port },
      mappings: { findByFixtureId: async (id: string) => ({ fixtureId: id, nodeId: id, nativeUuid: "001122334466", logicalAddress: mappedAddress,
        deviceUuid: "bio:001122334466", status: "confirmed" }),
        onChange: (listener: () => void) => { mappingListeners.add(listener); return () => { mappingListeners.delete(listener); }; } },
      source: { subscribe: f.source.subscribe.bind(f.source), onRevoked: f.source.onRevoked.bind(f.source),
        sourceAuthority: f.source.sourceAuthority.bind(f.source), preflight: async (...args: Parameters<typeof f.source.preflight>) => {
          const authority = await f.source.preflight(...args); if (mappingRace) { mappingRace = false; changeMapping(); } return authority;
        } },
      connection: () => ({ ready: true, protocolReady: true, generation: 1 }) });
    try {
      const { payloadHash: _hash, ...base } = f.snapshot(); await f.automationRuntime.hotReload(rehash({ ...base, schemaVersion: 3, holidayDatasets: [] } as never));
      const payload = { schemaVersion: 1, kind: "start", sessionId: "00000000-0000-4000-8000-000000000099", sessionRevision: 1,
        siteId: a, gatewayId: b, assignmentVersion: 1, admissionRevision: 4, sequence: 1, brightness: 60,
        startedAt: f.now().toISOString(), endsAt: new Date(f.now().getTime() + 60_000).toISOString(),
        targets: [{ fixtureId: b, meshNodeId: "00000000-0000-4000-8000-000000000088", nativeUuid: "001122334466", logicalAddress: "0x0002", applyGeneration: "1", releaseGeneration: "2" }] };
      await services.runtime.accept({ ...payload, payloadHash: bioEnvelopeHash(payload) },
        { generatedAt: f.now().getTime(), expiresAt: f.now().getTime() + 10_000 });
      if (race !== "none" && race !== "handoff") {
        expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
        expect(f.store.read().temporarySessions[payload.sessionId]?.targets[b]?.applyResult?.rfWriteEvidence).toBe("not_started");
        return;
      }
      expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 60, bioMode: "force-on" });
      expect(f.store.read().temporarySessions[payload.sessionId]?.state).toBe("holding");
      if (race === "handoff") {
        f.advance(60_000); await services.runtime.expire(f.now());
        const accepted = f.store.read().temporarySessions[payload.sessionId]!.targets[b]!.releaseResult!;
        const { schemaVersion, eventId, sessionId, siteId, gatewayId, assignmentVersion, admissionRevision, originCommandHash,
          originSequence, sessionRevision, targetGeneration, resultHash } = accepted;
        const schedule = { id: rule, name: "current schedule", status: "enabled", activeFrom: "2026-10-02T00:00:00Z", activeUntil: "2026-10-03T00:00:00Z",
          localStartTime: "00:00", localEndTime: "00:03", excludeWeekends: false, excludeHolidays: false,
          recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
          action: { dimmingEnabled: true, brightnessPercent: 45 }, fixtureIds: [b] };
        await f.automationRuntime.hotReload(rehash({ ...base, revision: 5, schemaVersion: 3, holidayDatasets: [], schedules: [schedule] } as never));
        await services.runtime.expire(f.now());
        expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 45, bioMode: "force-on" });
        const newerResult = f.store.read().temporarySessions[payload.sessionId]!.targets[b]!.releaseResult!;
        expect(newerResult.eventId).not.toBe(eventId);
        await services.mqtt.handleReceipt(Buffer.from(JSON.stringify({ schemaVersion, eventId, sessionId, siteId, gatewayId,
          assignmentVersion, admissionRevision, originCommandHash, originSequence, sessionRevision, targetGeneration, resultHash,
          status: "applied", reason: null, ingestedAt: f.now().toISOString() })));
        expect(guard?.(b)).toBe(false);
        expect(f.store.read().temporarySessions[payload.sessionId]!.targets[b]!.releaseResult).toEqual(accepted);
        await services.mqtt.handleReceipt(Buffer.from(JSON.stringify({ schemaVersion, eventId: newerResult.eventId, sessionId,
          siteId, gatewayId, assignmentVersion, admissionRevision, originCommandHash, originSequence, sessionRevision,
          targetGeneration, resultHash: newerResult.resultHash, status: "rejected", reason: "stale_owner", ingestedAt: f.now().toISOString() })));
        expect(f.store.read().temporarySessions[payload.sessionId]!.targets[b]!.releaseAcknowledged).toBe(true);
        expect(guard?.(b)).toBe(false);
        // The historical accepted result is not today's readback. A changed
        // current schedule must GET/reconcile without a synthetic scalar base.
        const readsBefore = f.reads.length;
        await f.automationRuntime.hotReload(rehash({ ...base, revision: 6, schemaVersion: 3, holidayDatasets: [],
          schedules: [{ ...schedule, action: { dimmingEnabled: true, brightnessPercent: 55 } }] } as never));
        await f.scheduleRuntime.tick();
        expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 55, bioMode: "force-on" });
        expect(f.reads.length).toBeGreaterThanOrEqual(readsBefore + 2);
        expect(f.genericWrites).toEqual([]); expect(f.store.read().baseBrightnessByFixture[b]).toBeUndefined();
        const physical = await f.targetPort.readBioState(b);
        await f.targetPort.restoreBioState(b, physical.target, { configuredHighBrightnessPercent: 70, bioMode: "force-on" });
        const writesBeforeBoundary = f.writes.length;
        f.onRead(() => { f.onRead(() => {}); f.advance(180_000); });
        await f.scheduleRuntime.tick();
        expect(f.writes).toHaveLength(writesBeforeBoundary);
        expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 70, bioMode: "force-on" });
        await f.scheduleRuntime.tick();
        expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
        expect(f.store.read().baseBrightnessByFixture[b]).toBeUndefined();
        return;
      }
      mappedAddress = 3; f.advance(60_000); await services.runtime.expire(f.now());
      expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 60, bioMode: "force-on" });
      expect(f.store.read().temporarySessions[payload.sessionId]?.state).toBe("recovery_pending");
      mappedAddress = 2; f.unhealthy(); await services.runtime.expire(f.now());
      expect(f.store.read().temporarySessions[payload.sessionId]?.state).toBe("recovery_pending"); expect(guard?.(b)).toBe(true);
    } finally { await services.mqtt.stopAndDrain(); expect(mappingListeners.size).toBe(0); await f.connection.stopAndDrain(); f.source.stop(); }
  });
  it("retains commissioned wire2 capability authority for exact V3 snapshot bindings", async () => {
    const f = await fixture();
    const asset = createRequire(import.meta.url)("../../../../test/fixtures/bio-sensor-common-path-v1.json");
    const health = { healthEpoch: "health", healthySinceMonotonicMs: 0, commission: { networkId: 2,
      mapping: { nativeUuid: "001122334455", logicalAddress: 1 },
      report: { eventId: "report", connectionGeneration: 1, fingerprint: asset.profile.fingerprint, profileKey: "profile" } } };
    const provider = new CommissionedBioPulseAuthorityProvider({ scope: { siteId: a, gatewayId: b, assignmentVersion: 1 },
      catalog: { onChange: () => () => {}, snapshot: () => ({ executionPolicy: { enabled: true } }) } as never,
      monitor: { onChange: () => () => {}, snapshot: () => health, preflightRelease: async () => true, releaseIdentityCurrent: () => true } as never,
      delivery: { onChange: () => () => {}, releaseSnapshotPins: () => {}, retainAcknowledgedRevision: () => true,
        acknowledgedCommissionProof: () => ({ capabilityRevision: 7, healthEpoch: "health", reportEventId: "report" }) } as never });
    try {
      const { payloadHash: _hash, ...base } = f.snapshot(); const v3 = rehash({ ...base, schemaVersion: 3, holidayDatasets: [] } as never);
      provider.stage(v3); provider.commit(v3);
      const authority = provider.read(a, { epoch: "connection", generation: 1 });
      expect(authority).toMatchObject({ independentlyQualified: true, binding: { snapshotRevision: 4, capabilityRevision: 7 } });
      expect(provider.releaseIdentityCurrent(authority!.binding)).toBe(true);
    } finally { provider.stop(); await f.connection.stopAndDrain(); f.source.stop(); }
  });
  it("installs V3 intact and preserves real source protection and pulse execution", async () => {
    const f = await fixture();
    const { payloadHash: _hash, ...base } = f.snapshot();
    const snapshot = rehash({ ...base, schemaVersion: 3, holidayDatasets: [] } as never);
    try {
      await expect(f.automationRuntime.hotReload(snapshot)).resolves.toMatchObject({ schemaVersion: 3, status: "applied" });
      expect(f.scheduleRuntime.currentSnapshot).toEqual(snapshot);
      expect(f.scheduleRuntime.isBioSourceTarget([a])).toBe(true);
      f.pulse();
      await vi.waitFor(() => expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 80, bioMode: "force-on" }));
    } finally { await f.connection.stopAndDrain(); f.source.stop(); await f.scheduleRuntime.stopAndDrain(); }
  });
  it.each(["schedule", "event"] as const)("a disabled %s does not reserve an active BIO source, but re-enabling it is rejected", async kind => {
    const f = await fixture();
    const { payloadHash: _hash, ...base } = f.snapshot();
    const schedule = { id: c, name: "paused schedule", status: "disabled" as "enabled" | "disabled",
      activeFrom: "2026-10-02T00:00:00Z", activeUntil: "2026-10-03T00:00:00Z", localStartTime: "00:00", localEndTime: "01:00",
      excludeWeekends: false, excludeHolidays: false, recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
      action: { dimmingEnabled: true, brightnessPercent: 45 }, fixtureIds: [a] };
    const event = { ...base.vehicleEventRules[0]!, id: c, status: "disabled" as "enabled" | "disabled",
      sensorProtocol: "bluez-stateful" as const, sourceFixtureIds: [c], targetFixtureIds: [a] };
    const make = (revision: number, status: "enabled" | "disabled") => rehash({ ...base, revision, schemaVersion: 3, holidayDatasets: [],
      schedules: kind === "schedule" ? [{ ...schedule, status }] : [],
      vehicleEventRules: kind === "event" ? [...base.vehicleEventRules, { ...event, status }] : base.vehicleEventRules } as never);
    try {
      await expect(f.automationRuntime.hotReload(make(4, "disabled"))).resolves.toMatchObject({ status: "applied", schemaVersion: 3 });
      expect(f.writes).toEqual([]); expect(f.genericWrites).toEqual([]);
      await expect(f.automationRuntime.hotReload(make(5, "enabled"))).rejects.toThrow("snapshot_recompute_failed");
      expect(f.automationRuntime.currentRevision).toBe(4);
      expect(f.writes).toEqual([]); expect(f.genericWrites).toEqual([]);
    } finally { await f.connection.stopAndDrain(); f.source.stop(); await f.scheduleRuntime.stopAndDrain(); }
  });
  it.each(["bio-usb-pulse", "bluez-stateful"] as const)("ignores disabled %s target reservations but still rejects enabled overlap", async sensorProtocol => {
    const f = await fixture();
    try {
      const { payloadHash: _hash, ...body } = f.snapshot();
      const inactive = { ...body.vehicleEventRules[0], id: "00000000-0000-4000-8000-000000000099", sensorProtocol,
        status: "disabled" as const, sourceFixtureIds: [sensorProtocol === "bio-usb-pulse" ? a : "00000000-0000-4000-8000-000000000098"] };
      const disabled = rehash({ ...body, vehicleEventRules: [...body.vehicleEventRules, inactive] });
      const authority = await f.source.preflight({ sourceFixtureId: a, snapshotRevision: 4 }, { requireHealthy: true });
      const legacyDir = await mkdtemp(join(tmpdir(), "bio-legacy-reservation-")); dirs.push(legacyDir);
      const legacy = new BioPulseControlCore({ bindings: [authority!.binding], sourceAuthority: () => authority,
        targetPort: f.targetPort, enabledRulesOnly: false }, new FileAutomationStateStore(join(legacyDir, "state")), () => new Date(), () => 1000);
      expect(() => legacy.install(disabled)).toThrow("bio_target_activation_conflict");
      await expect(f.automationRuntime.hotReload(disabled)).resolves.toMatchObject({ status: "applied", payloadHash: disabled.payloadHash });
      f.pulse(); await vi.waitFor(() => expect(f.writes).toHaveLength(1));
      f.advance(11000); await f.scheduleRuntime.tick(); expect(f.writes).toHaveLength(2);
      const conflicting = rehash({ ...body, revision: 5, vehicleEventRules: [...body.vehicleEventRules, { ...inactive, status: "enabled" }] });
      await expect(f.automationRuntime.hotReload(conflicting)).rejects.toThrow("snapshot_recompute_failed");
      expect(f.automationRuntime.currentRevision).toBe(4); expect(f.writes).toHaveLength(2);
    } finally { await f.connection.stopAndDrain(); f.source.stop(); }
  });

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
  it("permits only persisted explicit release through a distinct fresh identity proof after live authority is gone", async () => {
    const f = await fixture(); await f.automationRuntime.hotReload(f.snapshot()); f.pulse();
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.revoke(); let identity = false;
    f.source.preflightRelease = async () => identity;
    f.source.releaseIdentityCurrent = () => identity;
    f.advance(11000); await f.scheduleRuntime.tick(); expect(f.writes).toHaveLength(1);
    await f.scheduleRuntime.releaseBioEvent(rule); expect(f.writes).toHaveLength(1);
    identity = true; await f.scheduleRuntime.releaseBioEvent(rule);
    expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
    expect(f.source.sourceAuthority(a)).toBeNull();
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
