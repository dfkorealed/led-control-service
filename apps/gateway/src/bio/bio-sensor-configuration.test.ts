import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { bioSensorCatalogCanonicalJson, type BioSensorCatalogV1 } from "@led-control/shared";
import { FileBioSensorProfileCatalog } from "./bio-sensor-profile-catalog";
import { BioNodeLinkMonitor } from "./bio-node-link-monitor";
import { BioSensorPreparationHandler } from "../commands/bio-sensor-preparation-handler";
import { CommandJournal } from "../commands/command-journal";
import { BioDeviceMappingStore } from "./bio-device-mapping-store";
import { BioCapabilityDeliveryController } from "./bio-capability-delivery";
import { CommissionedBioPulseAuthorityProvider } from "./bio-pulse-authority-provider";
import { BioSensorPulseSource } from "./bio-sensor-pulse-source";
import { AutomationRuntime } from "../automation/automation-runtime";
import { automationSnapshot } from "../automation/automation-test-fixtures";
import type { AutomationSnapshotV2 } from "@led-control/shared";
import { FileAutomationStateStore } from "../automation/automation-state-store";
import { createGatewayAutomationServices, connectBioPulseSource } from "../index";
import { createBioSensorRuntime } from "./bio-sensor-runtime";
import type { BioSensorPulseCandidate } from "./bio-command-codec";

const scope = { siteId: "10000000-0000-4000-8000-000000000001", gatewayId: "10000000-0000-4000-8000-000000000002", assignmentVersion: 2 };
const fixtureId = "10000000-0000-4000-8000-000000000003", nodeId = "10000000-0000-4000-8000-000000000004";
const fingerprint = { deviceType: 1, firmware: { major: 5, minor: 5, revision: 8, build: 12889 }, sensorType: 2, infraredType: 1, ambientLightType: 0, hardwareType: 3 };
const profile = { profileId: "10000000-0000-4000-8000-000000000009", revision: 1, status: "approved" as const,
  fingerprint, bodyHexes: ["0102030405060708"], linkPolicy: { kind: "mode-get" as const, probeIntervalMs: 100, maxAgeMs: 300 },
  evidenceDigest: `sha256:${"a".repeat(64)}` as const, reuseScope: "fake transport qualification" };
const catalogValue = (revision = 1): BioSensorCatalogV1 => ({ schemaVersion: 1, ...scope, eventId: randomUUID(), catalogRevision: revision,
  issuedAt: new Date().toISOString(), profiles: [profile], executionPolicy: { enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null } });
const dirs: string[] = []; const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); vi.useRealTimers(); });
const hash = (v: unknown) => `sha256:${createHash("sha256").update(bioSensorCatalogCanonicalJson(v)).digest("hex")}`;
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "bio-config-")); dirs.push(dir);
  const catalog = new FileBioSensorProfileCatalog(join(dir, "catalog.json"), scope); await catalog.initialize();
  const mappings = new BioDeviceMappingStore(join(dir, "mappings.json"));
  await mappings.reserve({ fixtureId, nodeId: fixtureId, deviceUuid: "bio:001122334455", nativeUuid: "001122334455", logicalAddress: 256,
    observedLogicalAddressBeforeAssignment: 5, commandId: "registration", firmware: "legacy", protocol: "crc16" });
  await mappings.confirm("bio:001122334455", 256);
  let generation = 1, mono = 10, fail = false, mode = "sensor"; const writes: string[] = [];
  const changes = new Set<() => void>(); const events = new Set<(v: { kind: string }) => void>();
  const device = { nativeUuid: "001122334455", deviceUuid: "bio:001122334455", logicalAddress: 256, networkId: 0, firmwareVersion: "legacy", rssi: -40, fingerprint };
  const pulses = new Set<(value: BioSensorPulseCandidate) => void>();
  const client = {
    onSensorPulseCandidate: (listener: (value: BioSensorPulseCandidate) => void) => { pulses.add(listener); return () => { pulses.delete(listener); }; },
    sensorSourceSnapshot: () => ({ generation, ready: true, protocolReady: true, transportConnected: true }),
    onSensorSourceState: (fn: () => void) => { changes.add(fn); return () => { changes.delete(fn); }; },
    onEvent: (fn: (v: { kind: string }) => void) => { events.add(fn); return () => { events.delete(fn); }; },
    scanObservations: async () => { writes.push("SCAN"); return [structuredClone(device)]; },
    restoreSensorMode: async () => { writes.push("SET_MODE"); mode = "sensor"; },
    readDeviceInfo: async (_target?: { logicalAddress: number }) => { writes.push("GET_MODE"); if (fail) throw new Error("timeout"); return { ...device, mode, kind: "control-mode-report" }; }
  };
  const handler = new BioSensorPreparationHandler({ scope, catalog, mappings, client: client as never,
    journal: new CommandJournal(join(dir, "commands.json")), clockTrusted: async () => true });
  stops.push(() => handler.stopAndDrain());
  const command = () => ({ schemaVersion: 1 as const, ...scope, fixtureId, nodeId, commandId: randomUUID(),
    deviceIdentityHash: createHash("sha256").update(device.deviceUuid).digest("hex"), meshAddress: "0x0100", operation: "query" as const,
    catalogRevision: 1, requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
  return { dir, catalog, mappings, client, handler, command, device, writes, changes, events, pulses,
    advance: (n: number) => { mono += n; }, monotonic: () => mono, fail: () => { fail = true; },
    mode: (v: string) => { mode = v; }, reconnect: () => { generation++; for (const fn of changes) fn(); } };
}
it("starts OFF/empty, durably applies exact scope and rejects catalog rollback/conflict", async () => {
  const f = await harness(); expect(f.catalog.snapshot()).toBeNull(); const value = catalogValue();
  expect((await f.catalog.apply(value)).status).toBe("applied");
  expect((await f.catalog.apply(value)).status).toBe("duplicate");
  expect((await f.catalog.apply({ ...value, profiles: [] })).status).toBe("rejected");
  expect((await f.catalog.apply({ ...catalogValue(2), gatewayId: fixtureId })).status).toBe("rejected");
  await f.catalog.apply(catalogValue(2)); expect((await f.catalog.apply(value)).status).toBe("stale");
  const restored = new FileBioSensorProfileCatalog(join(f.dir, "catalog.json"), scope); await restored.initialize();
  expect(restored.snapshot()?.catalogRevision).toBe(2); const copy = restored.snapshot()!; copy.profiles.length = 0;
  expect(restored.snapshot()?.profiles).toHaveLength(1);
});

async function liveControllerHarness() {
  const f = await harness(); const fixture2 = "10000000-0000-4000-8000-000000000022";
  const device2 = { ...f.device, nativeUuid: "001122334466", deviceUuid: "bio:001122334466", logicalAddress: 257 };
  await f.mappings.reserve({ fixtureId: fixture2, nodeId: fixture2, deviceUuid: device2.deviceUuid, nativeUuid: device2.nativeUuid,
    logicalAddress: 257, observedLogicalAddressBeforeAssignment: 5, commandId: "registration-two", firmware: "legacy", protocol: "crc16" });
  await f.mappings.confirm(device2.deviceUuid, 257);
  let badSecond = false, wrongFirstNetwork = false;
  f.client.scanObservations = async () => [ { ...f.device, networkId: wrongFirstNetwork ? 9 : 0 }, device2 ];
  f.client.readDeviceInfo = async target => ({ ...(target?.logicalAddress === 257 ? device2 : f.device),
    mode: target?.logicalAddress === 257 && badSecond ? "force-off" : "sensor", kind: "control-mode-report" });
  const approved = catalogValue(); approved.profiles[0] = { ...profile, linkPolicy: { ...profile.linkPolicy, maxAgeMs: 20000 } };
  approved.executionPolicy = { enabled: true, ownerUserId: fixtureId, maximumResponseSeconds: 30, escalationAction: "operator" };
  await f.catalog.apply(approved);
  const c1 = f.command(), r1 = await f.handler.handle(c1);
  const c2 = { ...f.command(), fixtureId: fixture2, nodeId: fixture2, meshAddress: "0x0101", deviceIdentityHash: createHash("sha256").update(device2.deviceUuid).digest("hex") };
  const r2 = await f.handler.handle(c2);
  const monitor = new BioNodeLinkMonitor({ client: f.client as never, mappings: f.mappings, catalog: f.catalog, monotonic: f.monotonic });
  const delivery = new BioCapabilityDeliveryController(join(f.dir, "live.json"), { scope: () => scope, clockTrusted: async () => true,
    identity: { findByFixtureId: id => f.mappings.findByFixtureId(id), snapshot: () => f.client.sensorSourceSnapshot() } });
  await delivery.initialize(); delivery.setLiveProofReader(id => monitor.snapshot(id));
  const provider = new CommissionedBioPulseAuthorityProvider({ scope, catalog: f.catalog, monitor, delivery });
  const source = new BioSensorPulseSource({ client: f.client as never, mappings: f.mappings }); source.configure(f.catalog, provider);
  stops.push(async () => { source.stop(); provider.stop(); await monitor.stopAndDrain(); await delivery.stopAndDrain(); });
  const accept = async (id = fixtureId) => {
    await monitor.probe(id); await delivery.recordLiveProof(monitor.snapshot(id)!);
    const row = (await delivery.pending()).filter(row => row.proof.command.fixtureId === id).at(-1)!;
    await delivery.acknowledge({ schemaVersion: 2, ...scope, meshNodeId: row.delivery.report.meshNodeId, eventId: row.delivery.report.eventId,
      capabilityRevision: row.delivery.report.capabilityRevision, deliveryPayloadHash: row.deliveryPayloadHash,
      status: "applied", errorCode: null, ingestedAt: new Date().toISOString() });
  };
  monitor.commission({ command: c1, report: r1, mapping: (await f.mappings.findByFixtureId(fixtureId))!, networkId: 0 }); await accept();
  let configuration = { configuredHighBrightnessPercent: 30, bioMode: "sensor" as "sensor" | "force-on" | "force-off" };
  const targetWrites: unknown[] = [];
  const services = createGatewayAutomationServices({ scope, adapterKind: "bio-usb", clockTrust: { isTrusted: async () => true },
    wallClock: () => new Date(Date.UTC(2026, 9, 8) + f.monotonic()), monotonicClock: f.monotonic,
    stateStore: new FileAutomationStateStore(join(f.dir, "controller.json")), configStore: { load: async () => null, apply: async () => {}, restore: async () => {} },
    execute: async actions => actions.map(action => ({ fixtureId: action.fixtureId, status: "succeeded" as const, brightnessPercent: action.brightnessPercent,
      faultCode: null, errorCode: null, occurredAt: new Date().toISOString() })), bioSnapshotLifecycle: provider,
    bioProductPulse: { scope, source, targetPort: {
      readBioState: async () => ({ target: { kind: "unicast", nativeUuid: "001122334499", logicalAddress: 300, networkId: 0 }, configuration: { ...configuration } }),
      restoreBioState: async (_id, _target, value) => { configuration = { ...value }; targetWrites.push({ ...value }); return value; }
    } } });
  await services.scheduleRuntime.initialize(); await services.automationRuntime.initialize();
  const snapshot = automationSnapshot(4, { siteId: scope.siteId, gatewayId: scope.gatewayId, schemaVersion: 2, vehicleEventRules: [{
    id: nodeId, name: "F1 rule", sensorProtocol: "bio-usb-pulse", status: "enabled", sourceFixtureIds: [fixtureId], targetFixtureIds: [scope.gatewayId],
    holdSeconds: 10, action: { dimmingEnabled: true, brightnessPercent: 80 }
  }] } as never);
  await services.automationRuntime.hotReload(snapshot);
  const intake = connectBioPulseSource(source, services.scheduleRuntime); stops.push(() => intake.stopAndDrain());
  const pulse = (sequence = 1) => { for (const listener of f.pulses) listener({ kind: "sensor-status-candidate", innerOpcode: 9, innerBody: Buffer.from(profile.bodyHexes[0], "hex"),
    generation: f.client.sensorSourceSnapshot().generation, receivedMonotonicMs: f.monotonic(), deviceUuid: f.device.deviceUuid, logicalAddress: 256,
    networkId: 0, sequence, destination: 0, rssiDbm: -40, ttl: 1, control: false }); };
  return { ...f, ...services, source, monitor, delivery, accept, pulse, targetWrites, configuration: () => configuration,
    second: async () => { monitor.commission({ command: c2, report: r2, mapping: (await f.mappings.findByFixtureId(fixture2))!, networkId: 0 }); await accept(fixture2); },
    failSecond: async () => { badSecond = true; await monitor.probe(fixture2); }, wrongNetwork: () => { wrongFirstNetwork = true; } };
}

it("keeps F1 pin, queued receipt and full hold restoration across F2 commissioning and failure", async () => {
  const f = await liveControllerHarness(); const original = f.source.sourceAuthority(fixtureId)!;
  f.advance(100); await f.accept(); expect(f.delivery.acknowledgedCommissionProof(fixtureId)?.capabilityRevision).toBe(2);
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const lookup = f.mappings.findByNativeUuid.bind(f.mappings); let once = true;
  f.mappings.findByNativeUuid = async id => { if (once) { once = false; entered(); await gate; } return lookup(id); };
  const revoked: string[] = []; f.source.onRevoked(id => revoked.push(id)); f.pulse(); await started;
  try { await f.second(); await f.failSecond(); } finally { release(); }
  expect(f.source.sourceAuthority(fixtureId)).toEqual(original); expect(revoked).not.toContain(fixtureId);
  await vi.waitFor(() => expect(f.targetWrites).toHaveLength(1));
  f.advance(11000); await f.accept(); await f.scheduleRuntime.tick();
  expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
  expect(f.targetWrites).toHaveLength(2);
});

it("restores a revoked-profile activation by fresh identity only and keeps mismatched identity pending", async () => {
  const f = await liveControllerHarness(); f.pulse(); await vi.waitFor(() => expect(f.targetWrites).toHaveLength(1));
  await f.catalog.apply({ ...catalogValue(2), profiles: [] });
  f.advance(11000); f.pulse(2); await f.scheduleRuntime.tick(); expect(f.targetWrites).toHaveLength(1);
  expect(f.source.sourceAuthority(fixtureId)).toBeNull(); expect(f.monitor.snapshot(fixtureId)).toBeNull();
  await f.scheduleRuntime.releaseBioEvent(nodeId);
  expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
  expect(f.source.sourceAuthority(fixtureId)).toBeNull(); expect(f.monitor.snapshot(fixtureId)).toBeNull();
  const mismatch = await liveControllerHarness(); mismatch.pulse(); await vi.waitFor(() => expect(mismatch.targetWrites).toHaveLength(1));
  await mismatch.catalog.apply({ ...catalogValue(2), profiles: [] }); mismatch.wrongNetwork();
  await mismatch.scheduleRuntime.releaseBioEvent(nodeId);
  expect(mismatch.targetWrites).toHaveLength(1); expect(mismatch.scheduleRuntime.state().bioActivationsByRule[nodeId]?.completed).toBe(false);
});

it("Task6: rejected current live ACK fences cached and queued execution until post-rejection GET and exact newer ACK", async () => {
  const f = await liveControllerHarness(); await f.second();
  const secondId = "10000000-0000-4000-8000-000000000022";
  const second = f.delivery.acknowledgedCommissionProof(secondId);
  const original = f.source.sourceAuthority(fixtureId)!;
  f.pulse(); await vi.waitFor(() => expect(f.targetWrites).toHaveLength(1));
  const report = async () => {
    f.advance(100); await f.monitor.probe(fixtureId); await f.delivery.recordLiveProof(f.monitor.snapshot(fixtureId)!);
    return (await f.delivery.pending()).filter(row => row.proof.command.fixtureId === fixtureId).at(-1)!;
  };
  const ack = (row: Awaited<ReturnType<typeof report>>, status: "applied" | "rejected") => ({ schemaVersion: 2, ...scope,
    meshNodeId: row.delivery.report.meshNodeId, eventId: row.delivery.report.eventId, capabilityRevision: row.delivery.report.capabilityRevision,
    deliveryPayloadHash: row.deliveryPayloadHash, status, errorCode: status === "rejected" ? "bio_current_evidence_unverified" : null,
    ingestedAt: new Date().toISOString() });
  const rejected = await report();
  // The sole outbox coalesces unacknowledged reports, but a newer GET can already
  // have completed before rejection. Queue that captured proof behind the ACK.
  f.advance(100); await f.monitor.probe(fixtureId); const beforeRejection = f.monitor.snapshot(fixtureId)!;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const lookup = f.mappings.findByNativeUuid.bind(f.mappings); let once = true;
  f.mappings.findByNativeUuid = async id => { if (once) { once = false; entered(); await gate; } return lookup(id); };
  f.pulse(2); await started;
  try {
    const rejection = f.delivery.acknowledge(ack(rejected, "rejected"));
    const pendingProof = f.delivery.recordLiveProof(beforeRejection);
    await rejection; await pendingProof;
    expect(f.delivery.acknowledgedCommissionProof(fixtureId)).toBeNull();
    expect(f.source.sourceAuthority(fixtureId)).toBeNull();
  } finally { release(); }
  const premature = (await f.delivery.pending()).filter(row => row.proof.command.fixtureId === fixtureId).at(-1)!;
  expect(premature.delivery.report.capabilityRevision).toBe(3);
  await f.delivery.acknowledge(ack(premature, "applied"));
  expect(f.delivery.acknowledgedCommissionProof(fixtureId)).toBeNull();
  expect(await f.source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 4 }, { requireHealthy: true })).toBeNull();
  f.advance(11000); f.pulse(3); await f.scheduleRuntime.tick(); expect(f.targetWrites).toHaveLength(1);
  expect(f.delivery.acknowledgedCommissionProof(secondId)).toEqual(second);
  // Identity-only operator restoration is available while execution stays fenced.
  await f.scheduleRuntime.releaseBioEvent(nodeId); expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
  const recovered = await report();
  expect(f.delivery.acknowledgedCommissionProof(fixtureId)).toBeNull();
  await f.delivery.acknowledge(ack(recovered, "applied"));
  expect((await f.source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 4 }, { requireHealthy: true }))?.binding.capabilityRevision).toBe(4);
  expect(original.binding.capabilityRevision).toBe(1);
  // Immutable late receipts cannot revoke a newer accepted revision or restore
  // a superseded pre-rejection proof, even with the original exact payload hash.
  await f.delivery.acknowledge(ack(rejected, "rejected"));
  expect(await f.delivery.acknowledge(ack(premature, "rejected"))).toBe("ignored");
  expect(f.source.sourceAuthority(fixtureId)?.binding.capabilityRevision).toBe(4);
});

it("Task6: delayed rejection from a previous commission cannot revoke current source pins", async () => {
  const f = await liveControllerHarness(); f.advance(100); await f.monitor.probe(fixtureId);
  await f.delivery.recordLiveProof(f.monitor.snapshot(fixtureId)!); const old = (await f.delivery.pending()).at(-1)!;
  const commission = f.monitor.snapshot(fixtureId)!.commission;
  const command = { ...commission.command, commandId: randomUUID() };
  const report = { ...commission.report, commandId: command.commandId, commandPayloadHash: hash(command) as `sha256:${string}`, eventId: randomUUID() };
  f.monitor.commission({ ...commission, command, report }); f.advance(100); await f.accept();
  const current = await f.source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 4 }, { requireHealthy: true });
  expect(current?.binding.capabilityRevision).toBe(3);
  expect(await f.delivery.acknowledge({ schemaVersion: 2, ...scope, meshNodeId: old.delivery.report.meshNodeId,
    eventId: old.delivery.report.eventId, capabilityRevision: old.delivery.report.capabilityRevision, deliveryPayloadHash: old.deliveryPayloadHash,
    status: "rejected", errorCode: "bio_current_evidence_unverified", ingestedAt: new Date().toISOString() })).toBe("ignored");
  expect(f.source.sourceAuthority(fixtureId)).toEqual(current);
});

it("Task6: ongoing GET advances only link verifiedAt, never the commission mode instant", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-08T00:00:00.200Z"));
  const f = await liveControllerHarness();
  vi.setSystemTime(new Date("2026-10-08T00:00:00.500Z")); f.advance(100); await f.monitor.probe(fixtureId);
  await f.delivery.recordLiveProof(f.monitor.snapshot(fixtureId)!);
  const row = (await f.delivery.pending()).at(-1)!;
  expect(row.delivery.report).toMatchObject({ sensorModeVerifiedAt: "2026-10-08T00:00:00.200Z", verifiedAt: "2026-10-08T00:00:00.500Z" });
});
it("queries with SET0, gates ensure by full fresh fingerprint, and journals exact ACK", async () => {
  const f = await harness(); await f.catalog.apply(catalogValue()); const c = f.command();
  const report = await f.handler.handle(c); expect(report.status).toBe("ready"); expect(report.nodeId).toBe(nodeId);
  expect(f.writes).toEqual(["SCAN", "GET_MODE"]);
  const ack = { schemaVersion: 1, ...scope, fixtureId, nodeId, commandId: c.commandId, eventId: report.eventId,
    reportPayloadHash: hash(report), status: "applied", occurredAt: new Date().toISOString() };
  expect(await f.handler.acknowledge({ ...ack, reportPayloadHash: `sha256:${"0".repeat(64)}` })).toBe(false);
  expect(await f.handler.acknowledge(ack)).toBe(true);
  expect((await f.handler.handle(c)).eventId).toBe(report.eventId); expect(f.writes).toHaveLength(2);
  f.device.fingerprint = { ...fingerprint, hardwareType: 99 };
  const denied = await f.handler.handle({ ...f.command(), operation: "ensure_sensor" });
  expect(denied.status).toBe("unverified"); expect(f.writes.filter(w => w === "SET_MODE")).toHaveLength(0);
  f.device.fingerprint = fingerprint; f.mode("force-on");
  expect((await f.handler.handle(f.command())).status).toBe("needs_setup");
  expect((await f.handler.handle({ ...f.command(), operation: "ensure_sensor" })).status).toBe("ready");
  expect(f.writes.slice(-3)).toEqual(["SCAN", "SET_MODE", "GET_MODE"]);
});
it("keeps continuous healthySince, expires independently, and retires late GET on reconnect", async () => {
  const f = await harness(); await f.catalog.apply(catalogValue()); const command = f.command(); const report = await f.handler.handle(command);
  const monitor = new BioNodeLinkMonitor({ client: f.client as never, mappings: f.mappings, catalog: f.catalog, monotonic: f.monotonic });
  stops.push(() => monitor.stopAndDrain());
  monitor.commission({ command, report, mapping: (await f.mappings.findByFixtureId(fixtureId))!, networkId: 0 });
  await monitor.probe(fixtureId); expect(monitor.snapshot(fixtureId)?.healthySinceMonotonicMs).toBe(10);
  f.advance(100); await monitor.probe(fixtureId); expect(monitor.snapshot(fixtureId)?.healthySinceMonotonicMs).toBe(10);
  f.advance(301); expect(monitor.snapshot(fixtureId)).toBeNull();
  await monitor.probe(fixtureId); expect(monitor.snapshot(fixtureId)?.healthySinceMonotonicMs).toBe(411);
  let release!: () => void; f.client.readDeviceInfo = async () => { await new Promise<void>(r => { release = r; }); return { ...f.device, mode: "sensor", kind: "control-mode-report" }; };
  const pending = monitor.probe(fixtureId); for (let i = 0; i < 30 && !release; i++) await new Promise(r => setTimeout(r, 1));
  f.reconnect(); release(); await pending; expect(monitor.snapshot(fixtureId)).toBeNull();
});
it("requires exact current-epoch live ACK and preserves accepted evidence across repeat probes", async () => {
  const f = await harness(); await f.catalog.apply(catalogValue()); const command = f.command(); const report = await f.handler.handle(command);
  const monitor = new BioNodeLinkMonitor({ client: f.client as never, mappings: f.mappings, catalog: f.catalog, monotonic: f.monotonic });
  stops.push(() => monitor.stopAndDrain()); monitor.commission({ command, report, mapping: (await f.mappings.findByFixtureId(fixtureId))!, networkId: 0 });
  await monitor.probe(fixtureId);
  const delivery = new BioCapabilityDeliveryController(join(f.dir, "capability.json"), { scope: () => scope, clockTrusted: async () => true,
    identity: { findByFixtureId: id => f.mappings.findByFixtureId(id), snapshot: () => f.client.sensorSourceSnapshot() } });
  stops.push(() => delivery.stopAndDrain()); await delivery.initialize();
  delivery.setLiveProofReader(id => monitor.snapshot(id));
  await delivery.recordLiveProof(monitor.snapshot(fixtureId)!);
  expect(delivery.acknowledgedCommissionProof(fixtureId)).toBeNull();
  const row = (await delivery.pending())[0]!;
  const ack = { schemaVersion: 2, ...scope, meshNodeId: nodeId, eventId: row.delivery.report.eventId, capabilityRevision: 1,
    deliveryPayloadHash: row.deliveryPayloadHash, status: "applied", errorCode: null, ingestedAt: new Date().toISOString() };
  expect(await delivery.acknowledge({ ...ack, capabilityRevision: 99 })).toBe("ignored");
  expect(await delivery.acknowledge(ack)).toBe("terminal");
  expect(delivery.acknowledgedCommissionProof(fixtureId)?.capabilityRevision).toBe(1);
  f.advance(100); await monitor.probe(fixtureId); await delivery.recordLiveProof(monitor.snapshot(fixtureId)!);
  expect(delivery.acknowledgedCommissionProof(fixtureId)?.capabilityRevision).toBe(1);
  delivery.disconnect(); expect(delivery.acknowledgedCommissionProof(fixtureId)).toBeNull();
  expect(await delivery.acknowledge(ack)).toBe("ignored");
});
it("pins accepted revision for validated runtime contexts through healthy repeats and rolls failed stages back", async () => {
  const f = await harness(); const configured = catalogValue();
  configured.executionPolicy = { enabled: true, ownerUserId: fixtureId, maximumResponseSeconds: 30, escalationAction: "operator" };
  await f.catalog.apply(configured); const command = f.command(); const report = await f.handler.handle(command);
  const monitor = new BioNodeLinkMonitor({ client: f.client as never, mappings: f.mappings, catalog: f.catalog, monotonic: f.monotonic });
  stops.push(() => monitor.stopAndDrain()); monitor.commission({ command, report, mapping: (await f.mappings.findByFixtureId(fixtureId))!, networkId: 0 });
  await monitor.probe(fixtureId);
  const delivery = new BioCapabilityDeliveryController(join(f.dir, "capability.json"), { scope: () => scope, clockTrusted: async () => true,
    identity: { findByFixtureId: id => f.mappings.findByFixtureId(id), snapshot: () => f.client.sensorSourceSnapshot() } });
  stops.push(() => delivery.stopAndDrain()); await delivery.initialize(); delivery.setLiveProofReader(id => monitor.snapshot(id));
  const acceptLive = async () => {
    await delivery.recordLiveProof(monitor.snapshot(fixtureId)!); const row = (await delivery.pending()).at(-1)!;
    await delivery.acknowledge({ schemaVersion: 2, ...scope, meshNodeId: nodeId, eventId: row.delivery.report.eventId,
      capabilityRevision: row.delivery.report.capabilityRevision, deliveryPayloadHash: row.deliveryPayloadHash,
      status: "applied", errorCode: null, ingestedAt: new Date().toISOString() }); return row;
  };
  await acceptLive();
  const provider = new CommissionedBioPulseAuthorityProvider({ scope, catalog: f.catalog, monitor, delivery });
  const source = new BioSensorPulseSource({ client: f.client as never, mappings: f.mappings }); source.configure(f.catalog, provider);
  stops.push(async () => { source.stop(); provider.stop(); });
  const snapshot = (revision: number) => automationSnapshot(revision, { siteId: scope.siteId, gatewayId: scope.gatewayId, schemaVersion: 2,
    vehicleEventRules: [{ id: nodeId, name: "BIO", sensorProtocol: "bio-usb-pulse", status: "enabled", sourceFixtureIds: [fixtureId],
      targetFixtureIds: [scope.gatewayId], holdSeconds: 10, action: { dimmingEnabled: true, brightnessPercent: 80 } }] } as never) as unknown as AutomationSnapshotV2;
  let fail = false;
  const runtime = new AutomationRuntime({ scope, store: { load: async () => null, apply: async () => {}, restore: async () => {} },
    bioSnapshotLifecycle: provider, bioSnapshotPreflight: async value => {
      if (!await source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: value.revision }, { requireHealthy: true })) throw new Error("unqualified");
    }, recompute: async () => { if (fail) throw new Error("activation failed"); return {}; }, applyDesiredState: async () => {} });
  expect(await source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 4 }, { requireHealthy: true })).toBeNull();
  await runtime.hotReload(snapshot(4)); const original = source.sourceAuthority(fixtureId)!; expect(original.binding.capabilityRevision).toBe(1);
  f.advance(100); await monitor.probe(fixtureId); await acceptLive();
  expect(source.sourceAuthority(fixtureId)).toEqual(original);
  expect(await source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 999 }, { requireHealthy: true })).toBeNull();
  fail = true; await expect(runtime.hotReload(snapshot(5))).rejects.toThrow();
  expect(await source.preflight({ sourceFixtureId: fixtureId, snapshotRevision: 5 }, { requireHealthy: true })).toBeNull();
  expect((await source.preflight(original.binding, { requireHealthy: true }))?.binding).toEqual(original.binding);
  f.fail(); await monitor.probe(fixtureId); expect(source.sourceAuthority(fixtureId)).toBeNull();
  expect(delivery.acknowledgedCommissionProof(fixtureId)).toBeNull();
});
it("matches one approved profile across distinct registered identities and leaves legacy discovery unverified", async () => {
  const f = await harness(); await f.catalog.apply(catalogValue());
  for (let n = 0; n < 3; n++) {
    const fixture = n === 0 ? fixtureId : `10000000-0000-4000-8000-00000000001${n}`;
    if (n) {
      f.device.nativeUuid = `00112233445${n}`; f.device.deviceUuid = `bio:${f.device.nativeUuid}`; f.device.logicalAddress = 256 + n;
      await f.mappings.reserve({ fixtureId: fixture, nodeId: fixture, deviceUuid: f.device.deviceUuid, nativeUuid: f.device.nativeUuid,
        logicalAddress: 256 + n, observedLogicalAddressBeforeAssignment: 5, commandId: `reg-${n}`, firmware: "legacy", protocol: "crc16" });
      await f.mappings.confirm(f.device.deviceUuid, 256 + n);
    }
    const command = { ...f.command(), fixtureId: fixture, nodeId: randomUUID(), meshAddress: `0x010${n}` };
    expect((await f.handler.handle(command)).profileKey).toBe(`${profile.profileId}@1`);
  }
  delete (f.device as { fingerprint?: unknown }).fingerprint;
  expect((await f.handler.handle({ ...f.command(), fixtureId: "10000000-0000-4000-8000-000000000012", meshAddress: "0x0102" })).status).toBe("unverified");
});
it("revokes an awaited preparation on catalog replacement and retries durable results until exact receipt", async () => {
  const f = await harness(); await f.catalog.apply(catalogValue()); let release!: () => void;
  f.client.readDeviceInfo = async () => { await new Promise<void>(r => { release = r; }); return { ...f.device, mode: "sensor", kind: "control-mode-report" }; };
  const pending = f.handler.handle(f.command());
  for (let i = 0; i < 30 && !release; i++) await new Promise(r => setTimeout(r, 1));
  await f.catalog.apply({ ...catalogValue(2), profiles: [] }); release(); const result = await pending; expect(result.status).toBe("unverified");
  const sent: unknown[] = []; await f.handler.connect(async (_topic, value) => { sent.push(value); }); await f.handler.wake();
  expect(sent).toEqual([result, result]);
  await f.handler.acknowledge({ schemaVersion: 1, ...scope, fixtureId, nodeId, commandId: result.commandId, eventId: result.eventId,
    reportPayloadHash: hash(result), status: "applied", occurredAt: new Date().toISOString() });
  await f.handler.wake(); expect(sent).toHaveLength(2);
});
it("keeps degraded release identity separate from health and rejects fresh wrong network", async () => {
  const f = await harness(); await f.catalog.apply(catalogValue()); const command = f.command(), report = await f.handler.handle(command);
  const monitor = new BioNodeLinkMonitor({ client: f.client as never, mappings: f.mappings, catalog: f.catalog, monotonic: f.monotonic });
  stops.push(() => monitor.stopAndDrain()); monitor.commission({ command, report, mapping: (await f.mappings.findByFixtureId(fixtureId))!, networkId: 0 });
  const binding = { sourceFixtureId: fixtureId, nativeUuid: f.device.nativeUuid, logicalAddress: 256, networkId: 0,
    capabilityRevision: 11, snapshotRevision: 4, profileId: `${profile.profileId}@1`, firmwareFingerprint: "old", sensorFingerprint: "old" };
  f.mode("force-off"); await monitor.probe(fixtureId); expect(monitor.snapshot(fixtureId)).toBeNull();
  expect(await monitor.preflightRelease(binding)).toBe(true); expect(monitor.releaseIdentityCurrent(binding)).toBe(true);
  const beforeGuard = f.writes.length;
  expect(await monitor.preflightRelease(binding, false)).toBe(true); expect(f.writes).toHaveLength(beforeGuard);
  expect(monitor.snapshot(fixtureId)).toBeNull();
  f.reconnect(); expect(monitor.releaseIdentityCurrent(binding)).toBe(false);
  expect(await monitor.preflightRelease(binding, false)).toBe(false);
  // Reconnection requires fresh identity, never a re-approved profile or historical healthy ACK.
  expect(await monitor.preflightRelease(binding)).toBe(true);
  expect(monitor.snapshot(fixtureId)).toBeNull();
  f.device.networkId = 9; expect(await monitor.preflightRelease(binding)).toBe(false); expect(monitor.releaseIdentityCurrent(binding)).toBe(false);
});
it("boots real scheduler with an enabled retained snapshot and no recovered health or RF", async () => {
  const f = await harness(); const source = new BioSensorPulseSource({ client: f.client as never, mappings: f.mappings });
  stops.push(async () => source.stop());
  const retained = automationSnapshot(4, { siteId: scope.siteId, gatewayId: scope.gatewayId, schemaVersion: 2, vehicleEventRules: [{
    id: nodeId, name: "BIO", sensorProtocol: "bio-usb-pulse", status: "enabled", sourceFixtureIds: [fixtureId], targetFixtureIds: [scope.gatewayId],
    holdSeconds: 10, action: { dimmingEnabled: true, brightnessPercent: 80 }
  }] } as never);
  const services = createGatewayAutomationServices({ scope, adapterKind: "bio-usb", clockTrust: { isTrusted: async () => true },
    stateStore: new FileAutomationStateStore(join(f.dir, "automation.json")),
    configStore: { load: async () => retained, apply: async () => {}, restore: async () => {} }, execute: async () => { throw new Error("unexpected RF"); },
    bioSnapshotLifecycle: { stage() {}, commit() {}, rollback() {}, retain() {} },
    bioProductPulse: { scope, source, targetPort: { readBioState: async () => { throw new Error("unexpected GET"); }, restoreBioState: async () => { throw new Error("unexpected SET"); } } } });
  await services.scheduleRuntime.initialize(); await expect(services.automationRuntime.initialize()).resolves.toBeUndefined();
  expect(services.automationRuntime.currentRevision).toBeNull(); expect(services.scheduleRuntime.isBioSourceTarget([fixtureId])).toBe(true);
  expect(source.sourceAuthority(fixtureId)).toBeNull(); expect(f.writes).toEqual([]);
});
it("wires production preparation ACK to fresh GET and durable live capability without restoring it on restart", async () => {
  const f = await harness();
  const source = new BioSensorPulseSource({ client: f.client as never, mappings: f.mappings });
  const deliveryPath = join(f.dir, "delivery.json");
  const deliveryOptions = { scope: () => scope, clockTrusted: async () => true,
    identity: { findByFixtureId: (id: string) => f.mappings.findByFixtureId(id), snapshot: () => f.client.sensorSourceSnapshot() } };
  const delivery = new BioCapabilityDeliveryController(deliveryPath, deliveryOptions); await delivery.initialize();
  const runtime = await createBioSensorRuntime({ client: f.client as never, mappings: f.mappings, source }, delivery, scope, join(f.dir, "production"), async () => true);
  stops.push(async () => { await runtime.stopAndDrain(); await delivery.stopAndDrain(); source.stop(); });
  await runtime.catalog.apply(catalogValue()); const sent: unknown[] = [];
  await delivery.connect(async (_topic, value) => { sent.push(value); });
  const command = f.command(); const report = await runtime.preparation.handle(command);
  expect(sent).toEqual([]); expect(runtime.monitor.snapshot(fixtureId)).toBeNull();
  await runtime.preparation.acknowledge({ schemaVersion: 1, ...scope, fixtureId, nodeId, commandId: command.commandId, eventId: report.eventId,
    reportPayloadHash: hash(report), status: "applied", occurredAt: new Date().toISOString() });
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(f.writes.slice(0, 3)).toEqual(["SCAN", "GET_MODE", "GET_MODE"]);
  expect(sent[0]).toMatchObject({ schemaVersion: 2, report: { readiness: "ready", meshNodeId: nodeId, capabilityRevision: 1 } });
  const first = (await delivery.pending())[0]!;
  await delivery.recordLiveProof(runtime.monitor.snapshot(fixtureId)!);
  expect(await delivery.pending()).toHaveLength(1);
  await delivery.acknowledge({ schemaVersion: 2, ...scope, meshNodeId: nodeId, eventId: first.delivery.report.eventId, capabilityRevision: 1,
    deliveryPayloadHash: first.deliveryPayloadHash, status: "applied", errorCode: null, ingestedAt: new Date().toISOString() });
  expect(delivery.acknowledgedCommissionProof(fixtureId)?.capabilityRevision).toBe(1);
  for (const listener of f.events) listener({ kind: "invalid-notification" });
  expect(runtime.monitor.snapshot(fixtureId)).toBeNull(); expect(delivery.acknowledgedCommissionProof(fixtureId)).toBeNull();
  const restarted = new BioCapabilityDeliveryController(deliveryPath, deliveryOptions); await restarted.initialize();
  stops.push(() => restarted.stopAndDrain()); expect(restarted.acknowledgedCommissionProof(fixtureId)).toBeNull();
  await runtime.catalog.apply({ ...catalogValue(2), profiles: [] });
  await runtime.stopAndDrain();
  const restoredSource = new BioSensorPulseSource({ client: f.client as never, mappings: f.mappings });
  const writesBeforeRestart = f.writes.length;
  const restored = await createBioSensorRuntime({ client: f.client as never, mappings: f.mappings, source: restoredSource },
    restarted, scope, join(f.dir, "production"), async () => true);
  stops.push(async () => { await restored.stopAndDrain(); restoredSource.stop(); });
  expect(f.writes).toHaveLength(writesBeforeRestart);
  const binding = { sourceFixtureId: fixtureId, nativeUuid: f.device.nativeUuid, logicalAddress: 256, networkId: 0,
    capabilityRevision: 1, snapshotRevision: 4, profileId: `${profile.profileId}@1`, firmwareFingerprint: "saved", sensorFingerprint: "saved" };
  f.mode("force-off");
  expect(await restored.monitor.preflightRelease(binding, false)).toBe(false);
  expect(await restored.monitor.preflightRelease(binding)).toBe(true);
  expect(f.writes.slice(writesBeforeRestart)).toEqual(["SCAN", "GET_MODE"]);
  expect(restored.monitor.snapshot(fixtureId)).toBeNull();
  expect(restoredSource.sourceAuthority(fixtureId)).toBeNull();
  expect(restarted.acknowledgedCommissionProof(fixtureId)).toBeNull();
  f.fail(); expect(await restored.monitor.preflightRelease(binding)).toBe(false);
  expect(restored.monitor.releaseIdentityCurrent(binding)).toBe(false);
});
