import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposablePostgres } from "./support/disposable-postgres";
import { AutomationMqttConsumerService } from "../src/automation/automation-mqtt-consumer.service";
import { AutomationClock } from "../src/automation/automation-clock";
import { AutomationSnapshotService } from "../src/automation/automation-snapshot.service";
import { VehicleSensorCapabilityService } from "../src/automation/vehicle-sensor-capability.service";
import { canonicalPayloadHash } from "../src/automation/automation-payload-hash";
import { PrismaService } from "../src/prisma/prisma.service";
import { SitesService } from "../src/sites/sites.service";
import { SiteAccessService } from "../src/access/site-access.service";
import { mqttTopics } from "@led-control/shared";
import { bioPulseExecutionEventV2Schema } from "@led-control/shared";
import { ingestBioPulseTelemetry } from "../src/automation/bio-pulse-telemetry";
import { AutomationOutboxPublisherService } from "../src/automation/automation-outbox-publisher.service";
const { AutomationTelemetryOutbox } = require("../../gateway/src/automation/automation-telemetry-outbox");

function independentHash(value: unknown): string {
  const sorted = (value: any): any => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex")}`;
}

// Positive BIO evidence exists only in this fresh cluster. No ambient database,
// live MQTT transport, certificates, USB, RF, or product enable gate is used.
(process.env.BIO_PULSE_TELEMETRY_DISPOSABLE_POSTGRES === "1" ? describe : describe.skip)("BIO V2 durable telemetry", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let consumer: AutomationMqttConsumerService;
  let sites: SitesService;
  let siteId: string, gatewayId: string, sourceId: string, targetId: string, ruleId: string;
  let snapshotId: string;
  const now = new Date("2026-10-01T00:00:00.000Z");
  const scope = () => ({ siteId, gatewayId });
  beforeAll(async () => {
    cluster = await disposablePostgres(); const url = cluster.database(); const migrated = cluster.deploy(url);
    if (migrated.status !== 0) throw new Error(migrated.stderr + migrated.stdout);
    db = new PrismaClient({ datasources: { db: { url } } });
    const clock = new AutomationClock(); jest.spyOn(clock, "now").mockReturnValue(now);
    const snapshots = new AutomationSnapshotService(clock);
    consumer = new AutomationMqttConsumerService(db as PrismaService, new VehicleSensorCapabilityService(db as PrismaService, snapshots, clock), clock, snapshots);
    sites = new SitesService(db as PrismaService, new SiteAccessService(db as PrismaService));
  }, 60000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    const key = randomUUID();
    const org = await db.organization.create({ data: { name: key, type: "customer" } });
    siteId = (await db.site.create({ data: { organizationId: org.id, name: key } })).id;
    const floor = await db.floor.create({ data: { siteId, name: "B1", level: -1 } });
    gatewayId = (await db.gateway.create({ data: { siteId, name: key, serialNumber: key, firmwareVersion: "test", assignmentVersion: 1 } })).id;
    const inventory = await db.gatewayInventory.create({ data: { serialNumber: key, claimedGatewayId: gatewayId, claimedAt: now } });
    await db.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId, purpose: "mqtt", status: "active",
      certificateSerial: key, fingerprint: key, issuer: "synthetic", notBefore: new Date(now.getTime() - 1000), notAfter: new Date(now.getTime() + 86400000) } });
    await db.gatewayAutomationProtocolSupport.create({ data: { ...scope(), assignmentVersion: 1, declarationRevision: 1,
      declarationId: randomUUID(), maxSnapshotVersion: 2, payloadHash: `sha256:${"a".repeat(64)}`, declaredAt: now } });
    const source = await db.meshNode.create({ data: { gatewayId, meshAddress: "0x0001", firmwareVersion: "test", vehicleSensorProtocol: "bio_usb_pulse" } });
    const target = await db.meshNode.create({ data: { gatewayId, meshAddress: "0x0002", firmwareVersion: "test" } });
    sourceId = (await db.fixture.create({ data: { floorId: floor.id, meshNodeId: source.id, name: "A", ratedWatt: 20, x: 0, y: 0 } })).id;
    targetId = (await db.fixture.create({ data: { floorId: floor.id, meshNodeId: target.id, name: "B", ratedWatt: 20, x: 1, y: 0 } })).id;
    ruleId = randomUUID();
    const body = { schemaVersion: 2, ...scope(), revision: 5, timeZone: "UTC", schedules: [], generatedAt: now.toISOString(),
      vehicleEventRules: [{ id: ruleId, name: "synthetic historical rule", status: "enabled", sensorProtocol: "bio-usb-pulse",
        sourceFixtureIds: [sourceId], targetFixtureIds: [targetId], action: { dimmingEnabled: true, brightnessPercent: 80 }, holdSeconds: 60 }] };
    const payloadHash = canonicalPayloadHash(body);
    snapshotId = (await db.mqttOutbox.create({ data: { gatewayId, revision: 5, topic: mqttTopics.automationConfig(siteId, gatewayId),
      payload: { ...body, payloadHash }, payloadHash } })).id;
    // Added metadata is server-owned; older V2 snapshots must remain ineligible.
    await db.$executeRaw`UPDATE "MqttOutbox" SET "automationAssignmentVersion"=1 WHERE id=${snapshotId}`;
    await db.gatewayAutomationConfiguration.create({ data: { ...scope(), desiredRevision: 5, appliedRevision: 5, syncStatus: "APPLIED", lastAppliedAt: now, payloadHash } });
  });
  function event(sequence = 1, kind = "vehicle_detected", payload: Record<string, unknown> = {}) {
    return { schemaVersion: 2, assignmentVersion: 1, gatewayId, eventId: randomUUID(), sequence, revision: 5, ruleId,
      occurrenceKey: `${ruleId}:activation-1`, occurredAt: now.toISOString(), kind,
      payload: { sensorProtocol: "bio-usb-pulse", ...(kind === "vehicle_detected" ? { sourceFixtureId: sourceId, inputType: "pulse" } : {}), ...payload } };
  }
  async function projection() {
    const dashboard = await sites.getDashboardById(siteId);
    return dashboard.floors[0]!.fixtures.find(f => f.id === sourceId)!.bioPulseTelemetry;
  }
  it("commits exact V2 ACK and pulse projection once, revives a lost ACK, and leaves device evidence unchanged", async () => {
    const before = await db.fixture.findMany({ where: { siteId }, include: { meshNode: true } });
    const pulse = event();
    const ack = await consumer.onExecution(scope(), pulse);
    expect(ack).toMatchObject({ schemaVersion: 2, assignmentVersion: 1, eventId: pulse.eventId, sequence: 1, reportPayloadHash: independentHash(pulse) });
    expect(await consumer.onExecution(scope(), pulse)).toEqual(ack);
    expect(await db.bioPulseTelemetryEvent.count({ where: { gatewayId } })).toBe(1);
    const receipt = await db.mqttOutbox.findFirstOrThrow({ where: { gatewayId, applicationAckKey: { not: null } } });
    expect(receipt.payload).toEqual(ack);
    await db.mqttOutbox.update({ where: { id: receipt.id }, data: { publishedAt: now } });
    await consumer.onExecution(scope(), pulse);
    expect((await db.mqttOutbox.findUniqueOrThrow({ where: { id: receipt.id } })).publishedAt).toBeNull();
    expect(await projection()).toMatchObject({ lastPulseAt: now.toISOString(), health: "unverified", degradedSince: null, restorationPending: null });
    expect(await db.fixture.findMany({ where: { siteId }, include: { meshNode: true } })).toEqual(before);
    expect(await db.automationExecution.count({ where: { gatewayId } })).toBe(0);
  });
  it("rejects wrong assignment, topic, missing assignment, raw fields, unknown snapshot and mismatched source or targets", async () => {
    const base = event(); const { assignmentVersion, ...old } = base;
    for (const value of [old, { ...base, assignmentVersion: 2 }, { ...base, gatewayId: randomUUID() }, { ...base, revision: 6 },
      { ...base, payload: { ...base.payload, rawBody: "001122" } }, { ...base, payload: { ...base.payload, sourceFixtureId: targetId } },
      event(2, "event_started", { sourceFixtureId: sourceId, inputType: "pulse", holdUntil: now.toISOString(), brightnessPercent: 80, targetFixtureIds: [sourceId] })]) {
      expect(await consumer.onExecution(scope(), value)).toBeUndefined();
    }
    expect(await consumer.onExecution({ ...scope(), siteId: randomUUID() }, base)).toBeUndefined();
    expect(await db.mqttOutbox.count({ where: { gatewayId, applicationAckKey: { not: null } } })).toBe(0);
  });
  it("rejects same event identity with different sequence/hash and same sequence with another event", async () => {
    const pulse = event(); await consumer.onExecution(scope(), pulse);
    for (const changed of [{ ...pulse, sequence: 2 }, { ...pulse, occurredAt: new Date(now.getTime() - 1).toISOString() }, { ...pulse, eventId: randomUUID() }]) {
      await expect(consumer.onExecution(scope(), changed)).rejects.toThrow("identity conflict");
    }
  });
  it("canonicalizes multi-target configuration readback replay and never writes optical fixture state", async () => {
    const { floorId } = await db.fixture.findUniqueOrThrow({ where: { id: sourceId } });
    const node = await db.meshNode.create({ data: { gatewayId, meshAddress: "0x0004", firmwareVersion: "synthetic" } });
    const other = await db.fixture.create({ data: { floorId, meshNodeId: node.id, name: "B2", ratedWatt: 20, x: 2, y: 0 } });
    const snapshot = await db.mqttOutbox.findUniqueOrThrow({ where: { id: snapshotId } });
    const { payloadHash, ...body } = snapshot.payload as any;
    body.vehicleEventRules[0].targetFixtureIds = [targetId, other.id];
    const updatedHash = independentHash(body);
    await db.mqttOutbox.update({ where: { id: snapshotId }, data: { payload: { ...body, payloadHash: updatedHash }, payloadHash: updatedHash } });
    const results = [other.id, targetId].map(fixtureId => ({ fixtureId, status: "succeeded", configuration: { configuredHighBrightnessPercent: 30, bioMode: "sensor" } }));
    const action = event(1, "action_result", { verification: "configuration_readback", phase: "restore", results });
    const ack = await consumer.onExecution(scope(), action);
    const canonical = { ...action, payload: { ...action.payload, results: [...results].sort((a, b) => a.fixtureId.localeCompare(b.fixtureId)) } };
    expect(ack).toMatchObject({ reportPayloadHash: independentHash(canonical) });
    expect(await consumer.onExecution(scope(), { ...action, payload: { ...action.payload, results: [...results].reverse() } })).toEqual(ack);
    expect(await consumer.onExecution(scope(), event(2, "action_result", { verification: "configuration_readback", phase: "restore", results: [{ ...results[0], fixtureId: sourceId }] }))).toBeUndefined();
    const fixtures = await db.fixture.findMany({ where: { siteId } });
    expect(fixtures.every(f => f.brightness === 0 && f.bioControlMode === null && f.bioConfiguredBrightness === null)).toBe(true);
    expect(await db.automationExecutionFixtureResult.count()).toBe(0);
  });
  it("keeps degraded and restoration pending until recorded recovery/verified end, never wall-clock clear", async () => {
    await consumer.onExecution(scope(), event());
    await consumer.onExecution(scope(), event(2, "event_extended", { reason: "bio_source_degraded", health: "degraded", healthReason: "usb_disconnected", targetFixtureIds: [targetId], restorationPending: true }));
    expect(await projection()).toMatchObject({ lastPulseAt: now.toISOString(), degradedSince: now.toISOString(), health: "degraded", restorationPending: true });
    await consumer.onExecution(scope(), event(3));
    expect(await projection()).toMatchObject({ health: "degraded", restorationPending: true });
    await consumer.onExecution(scope(), event(4, "action_result", { verification: "configuration_readback", phase: "restore", results: [{ fixtureId: targetId, status: "succeeded", configuration: { configuredHighBrightnessPercent: 30, bioMode: "sensor" } }] }));
    expect(await projection()).toMatchObject({ restorationPending: true, configurationReadback: { verification: "configuration_readback", phase: "restore" } });
    await consumer.onExecution(scope(), event(5, "event_extended", { reason: "bio_health_recovered", health: "healthy", healthReason: "qualified", targetFixtureIds: [targetId], restorationPending: true }));
    expect(await projection()).toMatchObject({ health: "healthy", degradedSince: null, restorationPending: true });
    await consumer.onExecution(scope(), event(6, "event_ended", { reason: "hold_expired", restorationPending: false, targetFixtureIds: [targetId] }));
    expect(await projection()).toMatchObject({ restorationPending: false });
  });
  it("quarantines known stale configuration and out-of-order sequence without regressing the latest projection", async () => {
    await consumer.onExecution(scope(), event(10));
    const old = event(2, "event_extended", { reason: "bio_source_degraded", health: "degraded", healthReason: "usb_disconnected", targetFixtureIds: [targetId] });
    expect(await consumer.onExecution(scope(), old)).toMatchObject({ schemaVersion: 2 });
    expect(await projection()).toMatchObject({ health: "unverified", degradedSince: null });
    await db.gatewayAutomationConfiguration.update({ where: { gatewayId }, data: { desiredRevision: 6, syncStatus: "PENDING" } });
    expect(await consumer.onExecution(scope(), event(11))).toMatchObject({ schemaVersion: 2 });
    expect(await db.bioPulseTelemetryEvent.findFirst({ where: { gatewayId, sequence: 11n } })).toMatchObject({ disposition: "stale_configuration" });
    expect(await projection()).toBeNull();
  });
  it.each(["unclaimed", "revoked", "expired", "downgrade", "snapshot_assignment", "snapshot_legacy", "snapshot_hash", "snapshot_topic"])("rejects %s authority", async reason => {
    if (reason === "unclaimed") await db.gatewayInventory.updateMany({ where: { claimedGatewayId: gatewayId }, data: { disabledAt: now } });
    if (reason === "revoked") await db.gatewayCertificate.updateMany({ where: { gatewayId }, data: { status: "revoked", revokedAt: now } });
    if (reason === "expired") await db.gatewayCertificate.updateMany({ where: { gatewayId }, data: { notAfter: new Date(now.getTime() - 1) } });
    if (reason === "downgrade") await db.gatewayAutomationProtocolSupport.updateMany({ where: { gatewayId }, data: { maxSnapshotVersion: 1 } });
    if (reason === "snapshot_assignment") await db.$executeRaw`UPDATE "MqttOutbox" SET "automationAssignmentVersion"=2 WHERE id=${snapshotId}`;
    if (reason === "snapshot_legacy") await db.$executeRaw`UPDATE "MqttOutbox" SET "automationAssignmentVersion"=NULL WHERE id=${snapshotId}`;
    if (reason === "snapshot_hash") await db.mqttOutbox.update({ where: { id: snapshotId }, data: { payloadHash: `sha256:${"0".repeat(64)}` } });
    if (reason === "snapshot_topic") await db.mqttOutbox.update({ where: { id: snapshotId }, data: { topic: "wrong" } });
    expect(await consumer.onExecution(scope(), event())).toBeUndefined();
  });
  it("rejects replay after reassignment even with a new V2 declaration; an old snapshot cannot qualify new evidence", async () => {
    const pulse = event(); await consumer.onExecution(scope(), pulse);
    await db.gateway.update({ where: { id: gatewayId }, data: { assignmentVersion: 2 } });
    await db.gatewayAutomationProtocolSupport.create({ data: { ...scope(), assignmentVersion: 2, declarationRevision: 2,
      declarationId: randomUUID(), maxSnapshotVersion: 2, payloadHash: `sha256:${"b".repeat(64)}`, declaredAt: now } });
    expect(await consumer.onExecution(scope(), pulse)).toBeUndefined();
    expect(await consumer.onExecution(scope(), { ...event(2), assignmentVersion: 2 })).toBeUndefined();
    expect(await projection()).toBeNull();
  });
  it.each(["2099-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"])("durably quarantines authenticated clock error %s without poisoning the FIFO or changing projection", async occurredAt => {
    const untrusted = { ...event(), occurredAt };
    expect(await consumer.onExecution(scope(), untrusted)).toMatchObject({ eventId: untrusted.eventId, reportPayloadHash: independentHash(untrusted) });
    expect(await db.bioPulseTelemetryEvent.findFirst({ where: { gatewayId } })).toMatchObject({ disposition: "untrusted_time" });
    expect(await projection()).toBeNull();
    expect(await consumer.onExecution(scope(), event(2))).toMatchObject({ sequence: 2 });
    expect(await projection()).toMatchObject({ lastPulseAt: now.toISOString() });
  });
  it("serializes concurrent duplicate deliveries into one durable identity and ACK", async () => {
    const pulse = event();
    const acks = await Promise.all([consumer.onExecution(scope(), pulse), consumer.onExecution(scope(), pulse)]);
    expect(acks[0]).toEqual(acks[1]);
    expect(await db.bioPulseTelemetryEvent.count({ where: { gatewayId } })).toBe(1);
    expect(await db.mqttOutbox.count({ where: { gatewayId, applicationAckKey: { not: null } } })).toBe(1);
  });
  it("does not show a former source node's pulse after its Fixture is remapped", async () => {
    await consumer.onExecution(scope(), event());
    const replacement = await db.meshNode.create({ data: { gatewayId, meshAddress: "0x0003", firmwareVersion: "synthetic", vehicleSensorProtocol: "bio_usb_pulse" } });
    await db.fixture.update({ where: { id: sourceId }, data: { meshNodeId: replacement.id } });
    expect(await projection()).toBeNull();
    await consumer.onExecution(scope(), event(2));
    expect(await projection()).toBeNull();
  });
  it("selects the newest pulse across occurrences even when an older occurrence later emits lifecycle telemetry", async () => {
    const snapshot = await db.mqttOutbox.findUniqueOrThrow({ where: { id: snapshotId } });
    const { payloadHash, ...body } = snapshot.payload as any;
    body.generatedAt = new Date(now.getTime() - 60000).toISOString();
    const updatedHash = independentHash(body);
    await db.mqttOutbox.update({ where: { id: snapshotId }, data: { payload: { ...body, payloadHash: updatedHash }, payloadHash: updatedHash } });
    await consumer.onExecution(scope(), { ...event(1), occurredAt: new Date(now.getTime() - 1000).toISOString() });
    await consumer.onExecution(scope(), { ...event(2), occurrenceKey: `${ruleId}:activation-2` });
    await consumer.onExecution(scope(), event(3, "event_extended", { reason: "bio_release_pending", releaseReason: "operator_release", restorationPending: true, targetFixtureIds: [targetId] }));
    expect(await projection()).toMatchObject({ lastPulseAt: now.toISOString(), restorationPending: true });
    const readback = (value: number) => ({ verification: "configuration_readback", phase: "restore", results: [{ fixtureId: targetId, status: "succeeded", configuration: { configuredHighBrightnessPercent: value, bioMode: "sensor" } }] });
    await consumer.onExecution(scope(), event(4, "action_result", readback(30)));
    await consumer.onExecution(scope(), { ...event(5, "action_result", readback(40)), occurrenceKey: `${ruleId}:activation-2` });
    await consumer.onExecution(scope(), event(6, "event_extended", { reason: "bio_release_pending", releaseReason: "operator_release", restorationPending: true, targetFixtureIds: [targetId] }));
    expect(await projection()).toMatchObject({ configurationReadback: { sequence: 5, results: [{ configuration: { configuredHighBrightnessPercent: 40 } }] } });
  });
  it("cannot publish an uncommitted ACK, rolls back all evidence, and removes Gateway file record only after committed ACK", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bio-api-ack-"));
    try {
      const outbox = new AutomationTelemetryOutbox(join(directory, "outbox.json"), scope(), { assignmentVersion: 1, headroomBytes: 16384 });
      const { schemaVersion, assignmentVersion, gatewayId: ignored, eventId, sequence, ...record } = event();
      const stored = await outbox.append(record);
      const pulse = bioPulseExecutionEventV2Schema.parse(stored.event);
      let ready!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const transaction = db.$transaction(async tx => {
        await ingestBioPulseTelemetry(tx, scope(), pulse, now); ready(); await gate;
        throw new Error("injected commit failure");
      }, { timeout: 10000 }).catch(error => error);
      await started;
      try {
        expect(await db.bioPulseTelemetryEvent.count({ where: { gatewayId } })).toBe(0);
        expect(await db.mqttOutbox.count({ where: { gatewayId, applicationAckKey: { not: null } } })).toBe(0);
      } finally { release(); }
      expect(await transaction).toMatchObject({ message: "injected commit failure" });
      expect(await db.bioPulseTelemetryProjection.count({ where: { gatewayId } })).toBe(0);
      expect(await outbox.pending()).toHaveLength(1);
      const ack = await consumer.onExecution(scope(), pulse);
      expect(ack).toMatchObject({ reportPayloadHash: stored.reportPayloadHash });
      const delivered: unknown[] = [];
      const publisher = new AutomationOutboxPublisherService(db as PrismaService, { publishTopic: async (topic: string, payload: unknown) => {
        if (topic === mqttTopics.automationExecutionIngested(siteId, gatewayId)) delivered.push(payload);
      } } as never);
      await publisher.processBatch();
      expect(delivered).toEqual([ack]);
      expect(await outbox.markIngested(delivered[0])).toBe("deleted");
      expect(await outbox.pending()).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
