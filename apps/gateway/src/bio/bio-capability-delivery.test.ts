import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { BioSensorModeCommand, VehicleSensorCapabilityDeliveryV2 } from "@led-control/shared";
import { BioCapabilityDeliveryController } from "./bio-capability-delivery";
import { BioDeviceMappingStore } from "./bio-device-mapping-store";
import { VehicleSensorCapabilityPublisher } from "../mesh/vehicle-sensor-capability";

const siteId = "10000000-0000-4000-8000-000000000001", gatewayId = "10000000-0000-4000-8000-000000000002";
const fixtureId = "10000000-0000-4000-8000-000000000003", nodeId = "10000000-0000-4000-8000-000000000004";
const paths: string[] = []; const controllers: BioCapabilityDeliveryController[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(c => c.stopAndDrain())); await Promise.all(paths.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bio-capability-delivery-")); paths.push(dir);
  const mappings = new BioDeviceMappingStore(join(dir, "mappings.json"));
  await mappings.reserve({ fixtureId, nodeId: fixtureId, nativeUuid: "001122334455", deviceUuid: "bio:001122334455", logicalAddress: 256,
    observedLogicalAddressBeforeAssignment: 5, commandId: "registration", firmware: "not-authority", protocol: "crc16" });
  await mappings.confirm("bio:001122334455", 256);
  let time = Date.parse("2026-10-02T00:00:01Z"), generation = 1, assignmentVersion = 2, ready = true;
  let lookup = (id: string) => mappings.findByFixtureId(id);
  const options = { scope: () => ({ siteId, gatewayId, assignmentVersion }), now: () => new Date(time), clockTrusted: async () => true,
    identity: { findByFixtureId: (id: string) => lookup(id), snapshot: () => ({ generation, ready, transportConnected: ready, protocolReady: ready }),
      onChange: (listener: () => void) => mappings.onChange(listener) } };
  const path = join(dir, "delivery.json"); const controller = new BioCapabilityDeliveryController(path, options); controllers.push(controller);
  await controller.initialize();
  const command: BioSensorModeCommand = { version: 2, commandId: "10000000-0000-4000-8000-000000000005", siteId, gatewayId,
    fixtureId, nodeId, assignmentVersion: 2, meshAddress: "0x0100", deviceIdentityHash: createHash("sha256").update("bio:001122334455").digest("hex"),
    operation: "query", requestedAt: "2026-10-02T00:00:00Z", expiresAt: "2026-10-02T00:00:30Z" };
  const sent: VehicleSensorCapabilityDeliveryV2[] = [];
  return { controller, path, command, options, sent, mappings,
    connect: () => controller.connect(async (_topic, delivery) => { sent.push(delivery); }),
    expire: () => { time += 30000; }, changeGeneration: () => { generation++; }, changeAssignment: () => { assignmentVersion++; },
    disconnectIdentity: () => { ready = false; }, lookup: (fn: typeof lookup) => { lookup = fn; } };
}
function ack(delivery: VehicleSensorCapabilityDeliveryV2, hash: string, patch = {}) {
  return { schemaVersion: 2, siteId, gatewayId, assignmentVersion: delivery.assignmentVersion, eventId: delivery.report.eventId,
    meshNodeId: delivery.report.meshNodeId, capabilityRevision: delivery.report.capabilityRevision, deliveryPayloadHash: hash,
    status: "applied", errorCode: null, ingestedAt: "2026-10-02T00:00:02Z", ...patch };
}
describe("BIO assignment-bound durable OFF delivery", () => {
  it("retires the old canonical node for the same Fixture/native binding without reviving it on exact proof replay", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    const original = (await f.controller.pending())[0];
    const newNode = "10000000-0000-4000-8000-000000000009";
    await f.controller.recordIdentityProof({ ...f.command, commandId: "10000000-0000-4000-8000-000000000006", nodeId: newNode });
    await f.controller.recordIdentityProof(f.command);
    await f.connect(); expect(f.sent.map(d => d.report.meshNodeId)).toEqual([newNode]);
    const pending = await f.controller.pending(); expect(pending).toHaveLength(2);
    expect(pending[0].delivery).toEqual(original.delivery); expect(pending[0].deliveryPayloadHash).toBe(original.deliveryPayloadHash);
    expect(await f.controller.acknowledge(ack(original.delivery, original.deliveryPayloadHash))).toBe("ignored");
  });
  it("does not revive the old Fixture of a canonical node on exact proof replay", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    const original = (await f.controller.pending())[0];
    const nextFixture = "10000000-0000-4000-8000-000000000009";
    await f.mappings.reserve({ fixtureId: nextFixture, nodeId: nextFixture, nativeUuid: "001122334466", deviceUuid: "bio:001122334466", logicalAddress: 257,
      observedLogicalAddressBeforeAssignment: 5, commandId: "replacement-registration", firmware: "not-authority", protocol: "crc16" });
    await f.mappings.confirm("bio:001122334466", 257);
    await f.controller.recordIdentityProof({ ...f.command, commandId: "10000000-0000-4000-8000-000000000006", fixtureId: nextFixture,
      meshAddress: "0x0101", deviceIdentityHash: createHash("sha256").update("bio:001122334466").digest("hex") });
    await f.controller.recordIdentityProof(f.command); await f.connect();
    expect(f.sent.map(d => d.report.capabilityRevision)).toEqual([2]);
    const pending = await f.controller.pending(); expect(pending).toHaveLength(2); expect(pending[0].delivery).toEqual(original.delivery);
  });
  it("blocks an awaited publication when its Fixture receives a new canonical-node proof", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    let release!: () => void; let entered!: () => void; let blockOnce = true;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    f.lookup(async id => { if (blockOnce) { blockOnce = false; entered(); await gate; } return f.mappings.findByFixtureId(id); });
    const connecting = f.connect(); await started;
    const newNode = "10000000-0000-4000-8000-000000000009";
    await f.controller.recordIdentityProof({ ...f.command, commandId: "10000000-0000-4000-8000-000000000006", nodeId: newNode });
    release(); await connecting; expect(f.sent).toEqual([]);
    await f.controller.wake(); expect(f.sent.map(d => d.report.meshNodeId)).toEqual([newNode]);
  });
  it("keeps independent canonical nodes with different Fixture/native identities concurrently reportable", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    const nextFixture = "10000000-0000-4000-8000-000000000009", nextNode = "10000000-0000-4000-8000-000000000008";
    await f.mappings.reserve({ fixtureId: nextFixture, nodeId: nextFixture, nativeUuid: "001122334466", deviceUuid: "bio:001122334466", logicalAddress: 257,
      observedLogicalAddressBeforeAssignment: 5, commandId: "independent-registration", firmware: "not-authority", protocol: "crc16" });
    await f.mappings.confirm("bio:001122334466", 257);
    await f.controller.recordIdentityProof({ ...f.command, commandId: "10000000-0000-4000-8000-000000000006", fixtureId: nextFixture, nodeId: nextNode,
      meshAddress: "0x0101", deviceIdentityHash: createHash("sha256").update("bio:001122334466").digest("hex") });
    await f.connect(); expect(f.sent.map(d => d.report.meshNodeId)).toEqual([nodeId, nextNode]);
  });
  it("preserves but does not resend the superseded canonical-node binding", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    const nextFixture = "10000000-0000-4000-8000-000000000009";
    await f.mappings.reserve({ fixtureId: nextFixture, nodeId: nextFixture, nativeUuid: "001122334466", deviceUuid: "bio:001122334466", logicalAddress: 257,
      observedLogicalAddressBeforeAssignment: 5, commandId: "replacement-registration", firmware: "not-authority", protocol: "crc16" });
    await f.mappings.confirm("bio:001122334466", 257);
    await f.controller.recordIdentityProof({ ...f.command, commandId: "10000000-0000-4000-8000-000000000006", fixtureId: nextFixture,
      meshAddress: "0x0101", deviceIdentityHash: createHash("sha256").update("bio:001122334466").digest("hex") });
    await f.connect(); expect(f.sent.map(d => d.report.capabilityRevision)).toEqual([2]);
    expect(await f.controller.pending()).toHaveLength(2);
  });
  it("invalidates an awaited publish permit on a durable mapping epoch change even if source identity stays equal", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    f.lookup(async id => { entered(); await gate; return f.mappings.findByFixtureId(id); });
    const connecting = f.connect(); await started;
    await f.mappings.reserve({ fixtureId: nodeId, nodeId, nativeUuid: "001122334466", deviceUuid: "bio:001122334466", logicalAddress: 257,
      observedLogicalAddressBeforeAssignment: 5, commandId: "another-registration", firmware: "not-authority", protocol: "crc16" });
    release(); await connecting; expect(f.sent).toEqual([]); expect(await f.controller.pending()).toHaveLength(1);
  });
  it("checks the final synchronous publish permit after an asynchronous guard yields", async () => {
    let allowed = true; const sent: unknown[] = [];
    const publisher = new VehicleSensorCapabilityPublisher({ pending: async () => [{ report: { value: "pending" } }], acknowledge: async () => "ignored" as const },
      { siteId, gatewayId }, { beforePublish: async () => { queueMicrotask(() => { allowed = false; }); return true; }, mayPublish: () => allowed });
    try { await publisher.connect(async (_topic, report) => { sent.push(report); }); expect(sent).toEqual([]); }
    finally { await publisher.stopAndDrain(); }
  });
  it.each(["assignment", "stop", "mapping"])("blocks proof creation on %s change while mapping is awaited", async kind => {
    const f = await fixture(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    f.lookup(async id => { entered(); await gate; const mapping = await f.mappings.findByFixtureId(id);
      return kind === "mapping" && mapping ? { ...mapping, logicalAddress: 257 } : mapping; });
    const recording = f.controller.recordIdentityProof(f.command); await started;
    if (kind === "assignment") f.changeAssignment();
    const stopping = kind === "stop" ? f.controller.stopAndDrain() : Promise.resolve();
    release(); await Promise.all([recording, stopping]); expect(await f.controller.pending()).toEqual([]);
  });
  it("does not repackage a persisted pending delivery under a new assignment", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    const original = await readFile(f.path, "utf8"); f.changeAssignment(); await f.connect();
    expect(f.sent).toEqual([]); expect(await readFile(f.path, "utf8")).toBe(original);
  });
  it.each(["assignment", "generation", "disconnect", "stop", "mapping"])("blocks publication on %s while fresh mapping is awaited", async kind => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    f.lookup(async id => { entered(); await gate; const mapping = await f.mappings.findByFixtureId(id);
      return kind === "mapping" && mapping ? { ...mapping, logicalAddress: 257 } : mapping; });
    const connecting = f.connect(); await started;
    if (kind === "assignment") f.changeAssignment(); if (kind === "generation") f.changeGeneration();
    if (kind === "disconnect") f.controller.disconnect();
    const stopping = kind === "stop" ? f.controller.stopAndDrain() : Promise.resolve();
    release(); await Promise.all([connecting, stopping]); expect(f.sent).toEqual([]); expect(await f.controller.pending()).toHaveLength(1);
  });
  it("reports only authenticated canonical node identity, never mapping.nodeId or pulse qualification", async () => {
    const f = await fixture(); await f.connect(); expect(f.sent).toEqual([]);
    await f.controller.recordIdentityProof(f.command);
    await f.controller.wake();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ schemaVersion: 2, assignmentVersion: 2,
      report: { meshNodeId: nodeId, capabilityRevision: 1, readiness: "off", verifiedFingerprintId: null, sensorModeVerifiedAt: null } });
    expect((await f.controller.pending())[0].proof.command).toEqual(f.command);
  });
  it.each(["expiry", "assignment", "generation", "disconnect", "stop"])("preserves pending without transmission after %s", async kind => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command);
    if (kind === "expiry") f.expire(); if (kind === "assignment") f.changeAssignment(); if (kind === "generation") f.changeGeneration();
    if (kind === "disconnect") f.disconnectIdentity(); if (kind === "stop") await f.controller.stopAndDrain();
    await f.connect(); expect(f.sent).toEqual([]); expect(await f.controller.pending()).toHaveLength(1);
  });
  it("restarts without reminting revision/event and replays only after fresh exact proof", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command); const original = (await f.controller.pending())[0].delivery;
    await f.controller.stopAndDrain();
    const restarted = new BioCapabilityDeliveryController(f.path, f.options); controllers.push(restarted); await restarted.initialize();
    const sent: VehicleSensorCapabilityDeliveryV2[] = []; await restarted.connect(async (_topic, d) => { sent.push(d); }); expect(sent).toEqual([]);
    await restarted.recordIdentityProof({ ...f.command, commandId: "10000000-0000-4000-8000-000000000006" }); await restarted.wake();
    expect(sent).toEqual([original]); expect(await restarted.pending()).toHaveLength(1);
  });
  it("requires full envelope hash and exact ACK attribution; applied is terminal delivery, not readiness", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command); const record = (await f.controller.pending())[0];
    for (const patch of [{ assignmentVersion: 3 }, { siteId: nodeId }, { meshNodeId: fixtureId }, { deliveryPayloadHash: `sha256:${"0".repeat(64)}` }]) {
      expect(await f.controller.acknowledge(ack(record.delivery, record.deliveryPayloadHash, patch))).toBe("ignored");
    }
    expect(await f.controller.acknowledge(ack(record.delivery, record.deliveryPayloadHash))).toBe("terminal");
    expect(await f.controller.pending()).toEqual([]);
    const stored = JSON.parse(await readFile(f.path, "utf8")); expect(stored.records[0].delivery.report.readiness).toBe("off");
    expect(stored.records[0].receipt.status).toBe("applied");
  });
  it("keeps a rejected ACK truth durable across restart and duplicate proof", async () => {
    const f = await fixture(); await f.controller.recordIdentityProof(f.command); const record = (await f.controller.pending())[0];
    expect(await f.controller.acknowledge(ack(record.delivery, record.deliveryPayloadHash, { status: "rejected", errorCode: "IDENTITY_MISMATCH" }))).toBe("rejected");
    await f.controller.recordIdentityProof(f.command); expect(await f.controller.pending()).toEqual([]);
    const stored = JSON.parse(await readFile(f.path, "utf8")); expect(stored.records).toHaveLength(1); expect(stored.records[0].receipt.status).toBe("rejected");
  });
  it("rechecks generation after asynchronous mapping and rejects forged identity", async () => {
    const f = await fixture(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    f.lookup(async id => { entered(); await gate; return f.mappings.findByFixtureId(id); });
    const recording = f.controller.recordIdentityProof(f.command); await started; f.changeGeneration(); release(); await recording;
    expect(await f.controller.pending()).toEqual([]);
    await f.controller.recordIdentityProof({ ...f.command, deviceIdentityHash: "0".repeat(64) }); expect(await f.controller.pending()).toEqual([]);
  });
});
