import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { automationSnapshotV2Schema, bioSensorPreparationCommandV1Schema, bioSensorPreparationReportV1Schema,
  bioSensorPreparationAckV1Schema, vehicleSensorCapabilityDeliveryV2Schema, vehicleSensorCapabilityIngestedAckV2Schema } from "@led-control/shared";
import { FileBioSensorProfileCatalog, bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import { BioDeviceMappingStore } from "../bio/bio-device-mapping-store";
import { BioSensorPreparationHandler } from "../commands/bio-sensor-preparation-handler";
import { CommandJournal } from "../commands/command-journal";
import { BioNodeLinkMonitor } from "../bio/bio-node-link-monitor";
import { BioCapabilityDeliveryController } from "../bio/bio-capability-delivery";
import { CommissionedBioPulseAuthorityProvider } from "../bio/bio-pulse-authority-provider";
import { BioSensorPulseSource } from "../bio/bio-sensor-pulse-source";
import type { BioSensorPulseCandidate } from "../bio/bio-command-codec";
import { createGatewayAutomationServices, connectBioPulseSource } from "../index";
import { FileAutomationStateStore } from "./automation-state-store";
import { FileAutomationConfigStore } from "./automation-config-store";
import { AutomationConfigAckOutbox } from "./automation-config-ack-outbox";

vi.mock("node:crypto", async importOriginal => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});
const require = createRequire(import.meta.url);
const actualRandomUUID = require("node:crypto").randomUUID;
const asset = require("../../../../test/fixtures/bio-sensor-common-path-v1.json");
const { instantiateBioSensorCommonPath } = require("../../../../test/fixtures/bio-sensor-common-path.cjs");
const dirs: string[] = [], stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.restoreAllMocks(); vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function commonHarness() {
  const base = new Date().toISOString(), handoff = instantiateBioSensorCommonPath(asset, base, bioEnvelopeHash);
  expect(instantiateBioSensorCommonPath(asset, asset.exemplarBaseInstant, bioEnvelopeHash)).toEqual(asset.handoff);
  for (const row of handoff.preparations) {
    expect(bioEnvelopeHash(bioSensorPreparationCommandV1Schema.parse(row.command))).toBe(row.commandPayloadHash);
    expect(bioEnvelopeHash(bioSensorPreparationReportV1Schema.parse(row.report))).toBe(row.reportPayloadHash);
    bioSensorPreparationAckV1Schema.parse(row.ack);
  }
  for (const row of handoff.live) {
    expect(bioEnvelopeHash(vehicleSensorCapabilityDeliveryV2Schema.parse(row.delivery))).toBe(row.deliveryPayloadHash);
    vehicleSensorCapabilityIngestedAckV2Schema.parse(row.ack);
  }
  for (const row of handoff.snapshots) {
    const { payloadHash, ...body } = automationSnapshotV2Schema.parse(row.payload); expect(bioEnvelopeHash(body)).toBe(payloadHash);
  }
  const dir = await mkdtemp(join(tmpdir(), "bio-common-path-")); dirs.push(dir);
  const scope = { siteId: asset.scope.siteId, gatewayId: asset.scope.gatewayId, assignmentVersion: asset.scope.assignmentVersion };
  let mono = 10, generation = 1;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.spyOn(performance, "now").mockImplementation(() => mono);
  const at = (offset: number) => { mono += 10; vi.setSystemTime(new Date(Date.parse(base) + offset)); };
  const advance = (amount: number) => { mono += amount; vi.setSystemTime(new Date(Date.now() + amount)); };
  const mappings = new BioDeviceMappingStore(join(dir, "mappings"));
  const devices = asset.fixtures.map((f: any) => ({ nativeUuid: f.nativeUuid, deviceUuid: `bio:${f.nativeUuid}`,
    logicalAddress: parseInt(f.meshAddress.slice(2), 16), networkId: 0, firmwareVersion: "synthetic", rssi: -40,
    fingerprint: structuredClone(asset.profile.fingerprint) }));
  for (const [i, f] of asset.fixtures.entries()) {
    await mappings.reserve({ fixtureId: f.fixtureId, nodeId: f.fixtureId, deviceUuid: devices[i].deviceUuid,
      nativeUuid: f.nativeUuid, logicalAddress: devices[i].logicalAddress, observedLogicalAddressBeforeAssignment: i + 1,
      commandId: `registered-${i}`, firmware: "synthetic", protocol: "crc16" });
    await mappings.confirm(devices[i].deviceUuid, devices[i].logicalAddress);
  }
  const candidates = new Set<(value: BioSensorPulseCandidate) => void>(), states = new Set<() => void>();
  const reads: string[] = [], writes: unknown[] = [];
  let configuration = { configuredHighBrightnessPercent: 30, bioMode: "sensor" as "sensor" | "force-on" | "force-off" };
  const client = { sensorSourceSnapshot: () => ({ generation, ready: true, protocolReady: true, transportConnected: true }),
    onSensorSourceState: (fn: () => void) => { states.add(fn); return () => { states.delete(fn); }; }, onEvent: () => () => {},
    onSensorPulseCandidate: (fn: (value: BioSensorPulseCandidate) => void) => { candidates.add(fn); return () => { candidates.delete(fn); }; },
    scanObservations: async () => structuredClone(devices),
    readDeviceInfo: async (target: { nativeUuid: string }) => { reads.push(target.nativeUuid);
      return { ...devices.find((d: any) => d.nativeUuid === target.nativeUuid), kind: "control-mode-report", mode: "sensor" }; },
    restoreSensorMode: async () => { throw new Error("query must not SET"); } };
  const catalog = new FileBioSensorProfileCatalog(join(dir, "catalog"), scope); await catalog.initialize();
  at(50); expect(await catalog.apply(handoff.catalog.payload)).toEqual(handoff.catalog.ack);
  const journal = new CommandJournal(join(dir, "preparations"));
  let stopped: (() => Promise<void>) | undefined;
  async function boot() {
    await stopped?.();
    const monitor = new BioNodeLinkMonitor({ client: client as never, mappings, catalog, scope, monotonic: () => mono });
    for (const identity of await journal.acknowledgedBioRestorationIdentities()) monitor.retainRestorationIdentity(identity);
    const delivery = new BioCapabilityDeliveryController(join(dir, "capabilities"), { scope: () => scope, clockTrusted: async () => true,
      identity: { findByFixtureId: id => mappings.findByFixtureId(id), snapshot: client.sensorSourceSnapshot } });
    await delivery.initialize(); delivery.setLiveProofReader(id => monitor.snapshot(id));
    const provider = new CommissionedBioPulseAuthorityProvider({ scope, catalog, monitor, delivery });
    const source = new BioSensorPulseSource({ client: client as never, mappings }); source.configure(catalog, provider);
    const preparation = new BioSensorPreparationHandler({ scope, catalog, mappings, client: client as never, journal, clockTrusted: async () => true,
      onCommission: commission => monitor.commission(commission), onInvalidate: id => monitor.invalidate(id) });
    const services = createGatewayAutomationServices({ scope, adapterKind: "bio-usb", clockTrust: { isTrusted: async () => true },
      monotonicClock: () => mono, wallClock: () => new Date(), stateStore: new FileAutomationStateStore(join(dir, "state")),
      configStore: new FileAutomationConfigStore(join(dir, "config"), scope), bioSnapshotLifecycle: provider,
      execute: async () => { throw new Error("BIO may not use generic Set"); }, bioProductPulse: { scope, source, targetPort: {
        readBioState: async id => { reads.push(id); return { target: { kind: "unicast", nativeUuid: devices[2].nativeUuid,
          logicalAddress: devices[2].logicalAddress, networkId: 0 }, configuration: { ...configuration } }; },
        restoreBioState: async (_id, _target, value) => { configuration = { ...value }; writes.push({ ...value }); return { ...value }; }
      } } });
    await services.scheduleRuntime.initialize(); await services.automationRuntime.initialize();
    const intake = connectBioPulseSource(source, services.scheduleRuntime);
    stopped = async () => { await intake.stopAndDrain(); await preparation.stopAndDrain(); await monitor.stopAndDrain();
      await delivery.stopAndDrain(); source.stop(); provider.stop(); };
    async function prepare(index: number, exact = true) {
      const expected = handoff.preparations[index]; at(Date.parse(expected.report.observedAt) - Date.parse(base));
      // Atomic journal temp names also consume UUIDs before the report. The
      // bounded call uses one deterministic UUID, then restores real generation.
      vi.mocked(randomUUID).mockReturnValue(expected.report.eventId);
      let result;
      try { result = await preparation.handle(expected.command); }
      finally { vi.mocked(randomUUID).mockImplementation(actualRandomUUID); }
      if (exact) { expect(result).toEqual(expected.report); expect(bioEnvelopeHash(result)).toBe(expected.reportPayloadHash);
        expect(await preparation.acknowledge(expected.ack)).toBe(true); }
      return result;
    }
    async function live(index: number) {
      const expected = handoff.live[index], id = asset.fixtures.find((f: any) => f.nodeId === expected.delivery.report.meshNodeId).fixtureId;
      at(Date.parse(expected.delivery.report.verifiedAt) - Date.parse(base)); await monitor.probe(id);
      vi.mocked(randomUUID).mockReturnValueOnce(expected.delivery.report.eventId);
      await delivery.recordLiveProof(monitor.snapshot(id)!);
      const row = (await delivery.pending()).find(r => r.delivery.report.eventId === expected.delivery.report.eventId)!;
      expect(row.delivery).toEqual(expected.delivery); expect(row.deliveryPayloadHash).toBe(expected.deliveryPayloadHash);
      expect(await delivery.acknowledge(expected.ack)).toBe(expected.ack.status === "rejected" ? "rejected" : "terminal");
      return row;
    }
    return { ...services, monitor, delivery, provider, source, preparation, prepare, live };
  }
  const first = await boot(); stops.push(async () => { await stopped?.(); });
  const pulse = (index = 0, sequence = 1) => { for (const fn of candidates) fn({ kind: "sensor-status-candidate", innerOpcode: 9,
    innerBody: Buffer.from(asset.profile.bodyHexes[0], "hex"), generation, receivedMonotonicMs: mono, deviceUuid: devices[index].deviceUuid,
    logicalAddress: devices[index].logicalAddress, networkId: 0, sequence, destination: 0, rssiDbm: -40, ttl: 1, control: false }); };
  return { ...first, boot, pulse, at, advance, handoff, devices, mappings, catalog, dir, scope, reads, writes,
    configuration: () => ({ ...configuration }), reconnect: () => { generation++; for (const fn of states) fn(); } };
}

it("Task6: actual three-source preparation/live producers match immutable API handoffs and restore a full pulse hold", async () => {
  const f = await commonHarness();
  for (const i of [0, 1, 2]) await f.prepare(i);
  for (const i of [0, 1, 5]) await f.live(i);
  for (const fixture of asset.fixtures) expect(f.delivery.acknowledgedCommissionProof(fixture.fixtureId)?.capabilityRevision).toBe(1);
  const initial = f.handoff.snapshots[0]; f.at(450);
  const ack = await f.automationRuntime.hotReload(initial.payload); expect(ack).toEqual(initial.configAppliedDelivery.acknowledgement);
  const outbox = new AutomationConfigAckOutbox(join(f.dir, "acks"), { siteId: f.scope.siteId, gatewayId: f.scope.gatewayId }, undefined,
    () => initial.configAppliedDelivery.acknowledgementId);
  expect(await outbox.enqueue(ack)).toEqual(initial.configAppliedDelivery);
  const original = f.source.sourceAuthority(asset.fixtures[0].fixtureId);
  await f.live(2); expect(f.source.sourceAuthority(asset.fixtures[0].fixtureId)).toEqual(original);
  await f.automationRuntime.hotReload(initial.payload);
  expect(f.automationRuntime.currentSnapshot).toEqual(initial.payload);
  f.pulse(); await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  // An unknown third sensor remains unqualified; the API negative deliberately
  // supplies mode/link=true, while the Gateway correctly avoids an unapproved GET.
  f.devices[2].fingerprint.sensorType = 99; const reads = f.reads.length;
  const unknown = await f.prepare(4, false);
  expect(unknown).toMatchObject({ status: "unsupported", profileKey: null, modeVerified: false, linkVerified: false, errorCode: "BIO_PROFILE_UNVERIFIED" });
  expect(f.reads).toHaveLength(reads); expect(f.monitor.snapshot(asset.fixtures[2].fixtureId)).toBeNull();
  expect(f.source.sourceAuthority(asset.fixtures[0].fixtureId)).toEqual(original);
  for (let i = 0; i < 4; i++) { f.advance(2500); await f.monitor.probe(asset.fixtures[0].fixtureId); await f.monitor.probe(asset.fixtures[1].fixtureId); }
  await f.scheduleRuntime.tick(); expect(f.writes).toHaveLength(2);
  expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
  f.pulse(0, 2); await vi.waitFor(() => expect(f.writes).toHaveLength(3));
  // Local revoked catalog consumes the shared profile identity; the final
  // disabled snapshot is the exact API serializer output, not a rewritten rule.
  await f.catalog.apply({ ...f.handoff.catalog.payload, catalogRevision: 6, eventId: randomUUID(), issuedAt: new Date().toISOString(),
    profiles: [{ ...asset.profile, revision: 2, status: "revoked" }] });
  f.advance(11000); f.pulse(0, 3); await f.scheduleRuntime.tick(); expect(f.writes).toHaveLength(3);
  expect(f.source.sourceAuthority(asset.fixtures[0].fixtureId)).toBeNull();
  await f.scheduleRuntime.releaseBioEvent(initial.payload.vehicleEventRules[0].id);
  expect(f.writes).toHaveLength(4); expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
  const disabled = f.handoff.snapshots[3].payload;
  await expect(f.automationRuntime.hotReload(disabled)).resolves.toMatchObject({ status: "applied", revision: 8, payloadHash: disabled.payloadHash });
  expect(f.automationRuntime.currentSnapshot).toEqual(disabled); expect(f.writes).toHaveLength(4);
});

it("Task6: shared snapshot restarts degraded without RF and revalidates the same revision only after fresh accepted evidence", async () => {
  const f = await commonHarness(); for (const i of [0, 1, 2]) await f.prepare(i); for (const i of [0, 1, 5]) await f.live(i);
  f.at(450); await f.automationRuntime.hotReload(f.handoff.snapshots[0].payload);
  f.pulse(); await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  const ruleId = f.handoff.snapshots[0].payload.vehicleEventRules[0].id;
  const saved = f.scheduleRuntime.state().bioActivationsByRule[ruleId]!;
  const reads = f.reads.length, restarted = await f.boot();
  expect(restarted.automationRuntime.currentRevision).toBeNull(); expect(f.reads).toHaveLength(reads); expect(f.writes).toHaveLength(1);
  f.pulse(0, 2); await restarted.scheduleRuntime.tick(); expect(f.writes).toHaveLength(1);
  expect(restarted.scheduleRuntime.state().bioActivationsByRule[ruleId]).toMatchObject({ binding: saved.binding });
  // Fresh local commands use the same authenticated identity/catalog; no stored
  // ACK is replayed as commission. API same-support resync is proven separately.
  for (const i of [0, 1]) {
    f.at(1000 + i * 100); const prior = f.handoff.preparations[i].command;
    const command = { ...prior, commandId: randomUUID(), requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    const report = await restarted.preparation.handle(command);
    await restarted.preparation.acknowledge({ ...f.handoff.preparations[i].ack, commandId: command.commandId, eventId: report.eventId,
      reportPayloadHash: bioEnvelopeHash(report), occurredAt: new Date().toISOString() });
    await restarted.monitor.probe(command.fixtureId); await restarted.delivery.recordLiveProof(restarted.monitor.snapshot(command.fixtureId)!);
    const row = (await restarted.delivery.pending()).find(r => r.proof.command.commandId === command.commandId)!;
    await restarted.delivery.acknowledge({ ...f.handoff.live[i].ack, eventId: row.delivery.report.eventId,
      capabilityRevision: row.delivery.report.capabilityRevision, deliveryPayloadHash: row.deliveryPayloadHash, ingestedAt: new Date().toISOString() });
  }
  await expect(restarted.automationRuntime.hotReload(f.handoff.snapshots[0].payload)).rejects.toThrow();
  expect(restarted.automationRuntime.currentRevision).toBeNull(); expect(f.writes).toHaveLength(1);
  expect(await restarted.source.preflightRelease(saved.binding)).toBe(true);
  await restarted.scheduleRuntime.releaseBioEvent(ruleId);
  expect(f.configuration()).toEqual({ configuredHighBrightnessPercent: 30, bioMode: "sensor" });
  await restarted.automationRuntime.hotReload(f.handoff.snapshots[0].payload);
  expect(restarted.automationRuntime.currentRevision).toBe(5); expect(restarted.automationRuntime.currentSnapshot).toEqual(f.handoff.snapshots[0].payload);
});
