import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automationSnapshotSchema, mqttTopics, type AutomationSnapshot } from "@led-control/shared";
import { disposablePostgres } from "./support/disposable-postgres";
import { SiteAccessService } from "../src/access/site-access.service";
import { AutomationSnapshotService } from "../src/automation/automation-snapshot.service";
import { AutomationClock } from "../src/automation/automation-clock";
import { AutomationMqttConsumerService } from "../src/automation/automation-mqtt-consumer.service";
import { AutomationOutboxPublisherService } from "../src/automation/automation-outbox-publisher.service";
import { VehicleSensorCapabilityService } from "../src/automation/vehicle-sensor-capability.service";
import { VehicleEventRulesService } from "../src/automation/vehicle-event-rules.service";
import { TargetSnapshotService } from "../src/automation/target-snapshot.service";
import { PrismaService } from "../src/prisma/prisma.service";
import type { AuthenticatedUser } from "../src/auth/auth.types";
import type { MqttService } from "../src/mqtt/mqtt.service";
import { FixtureGroupsService } from "../src/fixture-groups/fixture-groups.service";
import { MeshControlGroupService } from "../src/mesh-control-groups/mesh-control-group.service";
import { EnergyDimensionHistoryService } from "../src/energy/energy-dimension-history.service";

// Runtime imports preserve API's emit root. These are real file stores/runtime;
// only the MQTT transport is in-process. No broker, Pi, RF or ambient DB is used.
const { AutomationRuntime } = require("../../gateway/src/automation/automation-runtime");
const { FileAutomationConfigStore } = require("../../gateway/src/automation/automation-config-store");
const { AutomationConfigAckOutbox } = require("../../gateway/src/automation/automation-config-ack-outbox");

(process.env.BIO_PULSE_CONFIG_DISPOSABLE_POSTGRES === "1" ? describe : describe.skip)("disabled BIO draft/config integration on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let prisma: PrismaClient;
  let snapshots: AutomationSnapshotService;
  let rules: VehicleEventRulesService;
  let consumer: AutomationMqttConsumerService;
  let actor: AuthenticatedUser;
  let siteId: string; let gatewayId: string; let sourceId: string; let targetId: string; let sourceNodeId: string;
  let directory: string;
  beforeAll(async () => {
    cluster = await disposablePostgres(); const url = cluster.database(); const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(deployed.stderr + deployed.stdout);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as PrismaService; const clock = new AutomationClock();
    snapshots = new AutomationSnapshotService(clock);
    rules = new VehicleEventRulesService(db, new SiteAccessService(db), new TargetSnapshotService(), snapshots);
    consumer = new AutomationMqttConsumerService(db, new VehicleSensorCapabilityService(db, snapshots, clock), clock, snapshots);
  }, 60_000);
  afterAll(async () => { await prisma?.$disconnect(); cluster?.stop(); });
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bio-config-integration-"));
    const id = randomUUID();
    const org = await prisma.organization.create({ data: { name: id, type: "customer" } });
    const user = await prisma.user.create({ data: { organizationId: org.id, loginId: id, email: `${id}@test.local`, name: "Admin", passwordHash: "unused", role: "admin" } });
    actor = { ...user, organizationType: "customer" } as unknown as AuthenticatedUser;
    siteId = (await prisma.site.create({ data: { name: id, organizationId: org.id, adminUserId: user.id } })).id;
    const floor = await prisma.floor.create({ data: { siteId, name: "B1", level: -1 } });
    gatewayId = (await prisma.gateway.create({ data: { siteId, name: id, serialNumber: id, firmwareVersion: "test", assignmentVersion: 1 } })).id;
    const inventory = await prisma.gatewayInventory.create({ data: { serialNumber: `inv-${id}`, claimedGatewayId: gatewayId, claimedAt: new Date() } });
    await prisma.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId, purpose: "mqtt", status: "active", certificateSerial: id,
      fingerprint: id, issuer: "synthetic", notBefore: new Date(), notAfter: new Date(Date.now() + 60000) } });
    // Synthetic DB prerequisite only; product capability ingestion never creates this
    // ready evidence. Config ACK must not mutate or imply source qualification.
    const source = await prisma.meshNode.create({ data: { gatewayId, meshAddress: "0x0001", firmwareVersion: "test", deviceUuid: `bio:${id.replaceAll("-", "").slice(0, 12)}`,
      vehicleSensorProtocol: "bio_usb_pulse", bioPulseReadiness: "ready", bioPulseCapabilityRevision: 1,
      bioPulseProfileId: "synthetic-only", bioPulseVerifiedAt: new Date() } });
    sourceNodeId = source.id;
    sourceId = (await prisma.fixture.create({ data: { floorId: floor.id, meshNodeId: source.id, name: "A", ratedWatt: 20, x: 0, y: 0 } })).id;
    const target = await prisma.meshNode.create({ data: { gatewayId, meshAddress: "0x0002", firmwareVersion: "test" } });
    targetId = (await prisma.fixture.create({ data: { floorId: floor.id, meshNodeId: target.id, name: "B", ratedWatt: 20, x: 1, y: 0 } })).id;
  });
  const scope = () => ({ siteId, gatewayId });
  const input = (overrides = {}) => ({ name: "BIO draft", status: "disabled", sourceFixtureIds: [sourceId], targetFixtureIds: [targetId],
    action: { dimmingEnabled: true, brightnessPercent: 80 }, holdSeconds: 60, ...overrides });
  const declare = (changes = {}) => consumer.onCurrentConfigRequest(scope(), { schemaVersion: 2, ...scope(), requestId: randomUUID(),
    assignmentVersion: 1, declarationRevision: 1, maxSnapshotVersion: 2, requestedAt: new Date().toISOString(), ...changes });
  const latest = async () => {
    const row = await prisma.mqttOutbox.findFirstOrThrow({ where: { gatewayId, revision: { not: null } }, orderBy: { revision: "desc" } });
    return automationSnapshotSchema.parse(row.payload) as AutomationSnapshot;
  };
  async function gateway(snapshot: AutomationSnapshot) {
    const runtime = new AutomationRuntime({ scope: scope(), store: new FileAutomationConfigStore(join(directory, "config.json"), scope()),
      recompute: async () => ({}), applyDesiredState: async () => { throw new Error("disabled config cannot write RF"); } });
    await runtime.initialize();
    const acknowledgements = new AutomationConfigAckOutbox(join(directory, "acks.json"), scope());
    const delivery = await acknowledgements.enqueue(await runtime.hotReload(snapshot));
    return { runtime, acknowledgements, delivery };
  }

  it.each([10, 60])("saves disabled %ss BIO, negotiates V2, publishes exact hash, and converges exact Gateway ACK", async holdSeconds => {
    const draft = await rules.create(siteId, actor, input({ holdSeconds }));
    expect(await latest()).toMatchObject({ schemaVersion: 1, vehicleEventRules: [] });
    expect((await prisma.vehicleEventRule.findUniqueOrThrow({ where: { id: draft.id } })).appliedRevision).toBe(0);
    const before = await prisma.meshNode.findUniqueOrThrow({ where: { id: sourceNodeId } });
    const snapshot = await declare(); expect(snapshot).toMatchObject({ schemaVersion: 2,
      vehicleEventRules: [{ id: draft.id, status: "disabled", sensorProtocol: "bio-usb-pulse", holdSeconds }] });
    const payload = snapshot!;
    expect(await prisma.mqttOutbox.findFirst({ where: { gatewayId, revision: payload.revision } })).toMatchObject({ automationAssignmentVersion: 1 });
    const { payloadHash, ...body } = payload;
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([l], [r]) => l.localeCompare(r)).map(([key, child]) => [key, canonical(child)])) : value;
    expect(payloadHash).toBe(`sha256:${createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex")}`);
    const published: Array<{ topic: string; payload: unknown }> = [];
    const mqtt = { publishTopic: async (topic: string, value: unknown) => { published.push({ topic, payload: value }); } } as unknown as MqttService;
    const publisher = new AutomationOutboxPublisherService(prisma as PrismaService, mqtt);
    await publisher.processBatch();
    expect(published.filter(item => item.topic === mqttTopics.automationConfig(siteId, gatewayId))).toEqual([
      { topic: mqttTopics.automationConfig(siteId, gatewayId), payload }
    ]);
    const g = await gateway(payload as AutomationSnapshot);
    expect(await consumer.onConfigApplied(scope(), { ...g.delivery, schemaVersion: 1,
      acknowledgement: { ...g.delivery.acknowledgement, schemaVersion: 1 } })).toBeUndefined();
    expect(await consumer.onConfigApplied(scope(), { ...g.delivery,
      acknowledgement: { ...g.delivery.acknowledgement, payloadHash: `sha256:${"0".repeat(64)}` } })).toBeUndefined();
    expect((await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId } })).appliedRevision).toBe(0);
    const receipt = await consumer.onConfigApplied(scope(), g.delivery);
    expect(receipt).toMatchObject({ schemaVersion: 2, acknowledgement: { schemaVersion: 2, status: "applied", payloadHash } });
    expect(await g.acknowledgements.acknowledge(receipt)).toBe("deleted");
    expect(await g.acknowledgements.pending()).toEqual([]);
    expect(await consumer.onConfigApplied(scope(), g.delivery)).toEqual(receipt);
    expect(await prisma.vehicleEventRule.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "disabled", appliedRevision: payload.revision });
    expect(await prisma.meshNode.findUniqueOrThrow({ where: { id: sourceNodeId } })).toEqual(before);
    await expect(rules.update(siteId, draft.id, actor, { status: "enabled" })).rejects.toMatchObject({ response: { code: "v2_support_unverified" } });
    const enabledBody = { ...body, revision: payload.revision + 1,
      vehicleEventRules: body.vehicleEventRules.map(rule => ({ ...rule, status: "enabled" })) };
    await expect(g.runtime.hotReload({ ...enabledBody, payloadHash: `sha256:${createHash("sha256").update(JSON.stringify(canonical(enabledBody))).digest("hex")}` }))
      .rejects.toMatchObject({ code: "bio_pulse_control_unavailable" });
  });

  it.each(["unclaimed", "certificate", "assignment", "unsupported"])("does not grant V2 for %s authority", async reason => {
    await rules.create(siteId, actor, input());
    if (reason === "unclaimed") await prisma.gatewayInventory.updateMany({ where: { claimedGatewayId: gatewayId }, data: { disabledAt: new Date() } });
    if (reason === "certificate") await prisma.gatewayCertificate.updateMany({ where: { gatewayId }, data: { status: "revoked", revokedAt: new Date() } });
    if (reason === "assignment") await prisma.gateway.update({ where: { id: gatewayId }, data: { assignmentVersion: 2 } });
    await declare(reason === "unsupported" ? { maxSnapshotVersion: 1 } : {});
    expect(await latest()).toMatchObject({ schemaVersion: 1, vehicleEventRules: [] });
    expect((await prisma.vehicleEventRule.findFirstOrThrow({ where: { gatewayId } })).appliedRevision).toBe(0);
  });

  it("revokes old V2 ACK after assignment change and explicit downgrade keeps BIO pending outside V1", async () => {
    const draft = await rules.create(siteId, actor, input()); await declare();
    const g = await gateway(await latest());
    await prisma.gateway.update({ where: { id: gatewayId }, data: { assignmentVersion: 2 } });
    expect(await consumer.onConfigApplied(scope(), g.delivery)).toBeUndefined();
    await declare({ assignmentVersion: 2, declarationRevision: 2, maxSnapshotVersion: 1 });
    expect(await latest()).toMatchObject({ schemaVersion: 1, vehicleEventRules: [] });
    expect(await consumer.onConfigApplied(scope(), g.delivery)).toBeUndefined();
    expect(await prisma.vehicleEventRule.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "disabled", appliedRevision: 0 });
  });

  it("preserves enabled five-second BlueZ V1 save and ACK semantics", async () => {
    await prisma.meshNode.update({ where: { id: sourceNodeId }, data: { vehicleSensorProtocol: "bluez_stateful",
      bioPulseReadiness: "off", bioPulseCapabilityRevision: 0, bioPulseProfileId: null, bioPulseVerifiedAt: null,
      vehicleSensorCapabilityStatus: "supported", vehicleSensorCapabilityRevision: 1, vehicleSensorCapabilityVerifiedAt: new Date(),
      vehicleSensorServerBound: true, vehicleVendorEventModelBound: true } });
    const draft = await rules.create(siteId, actor, input({ status: "enabled", holdSeconds: 5 }));
    const snapshot = await latest(); expect(snapshot).toMatchObject({ schemaVersion: 1, vehicleEventRules: [{ id: draft.id, holdSeconds: 5 }] });
    expect(snapshot.vehicleEventRules[0]).not.toHaveProperty("sensorProtocol");
    const g = await gateway(snapshot); const receipt = await consumer.onConfigApplied(scope(), g.delivery);
    expect(receipt).toMatchObject({ schemaVersion: 1 });
    expect(await prisma.vehicleEventRule.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ appliedRevision: snapshot.revision });
  });

  it("leaves V2 configuration telemetry unacknowledged without creating execution or optical fixture state", async () => {
    const draft = await rules.create(siteId, actor, input()); await declare();
    const snapshot = await latest();
    const before = await prisma.fixture.findUniqueOrThrow({ where: { id: targetId } });
    const event = { schemaVersion: 2, eventId: randomUUID(), sequence: 1, gatewayId, revision: snapshot.revision,
      ruleId: draft.id, occurrenceKey: `${draft.id}:synthetic`, occurredAt: new Date().toISOString(), kind: "action_result",
      payload: { sensorProtocol: "bio-usb-pulse", verification: "configuration_readback", phase: "apply",
        results: [{ fixtureId: targetId, status: "succeeded", configuration: { configuredHighBrightnessPercent: 80, bioMode: "force-on" } }] } };
    expect(await consumer.onExecution(scope(), event)).toBeUndefined();
    expect(await prisma.automationExecution.count({ where: { gatewayId } })).toBe(0);
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: targetId } })).toEqual(before);
  });

  it("rechecks an expanded group after a concurrent active-source membership commit", async () => {
    const draft = await rules.create(siteId, actor, input());
    const db = prisma as PrismaService;
    const groups = new FixtureGroupsService(db, new SiteAccessService(db), new MeshControlGroupService(), new EnergyDimensionHistoryService());
    const { floorId } = await prisma.fixture.findUniqueOrThrow({ where: { id: sourceId } });
    await prisma.energyFixtureIdentity.createMany({ data: [sourceId, targetId].map(fixtureId => ({ fixtureId, siteId, trackingStartedAt: new Date() })) });
    const groupInput = { name: "B only", floorId, gatewayId, fixtureIds: [targetId] };
    const group = await groups.create(actor, siteId, groupInput);
    let locked!: () => void; const lockReady = new Promise<void>(resolve => { locked = resolve; });
    let unlock!: () => void; const release = new Promise<void>(resolve => { unlock = resolve; });
    // Synthetic legacy-active DB state solely to exercise a future/old row racing
    // group expansion. The product create/update API remains unable to enable BIO.
    const sourceAdmission = prisma.$transaction(async tx => {
      await snapshots.lockMutation(tx);
      await tx.vehicleEventRule.update({ where: { id: draft.id }, data: { status: "enabled" } });
      locked(); await release;
    }, { timeout: 10000 });
    await lockReady;
    const expansion = groups.update(actor, siteId, group.id, { ...groupInput, fixtureIds: [sourceId, targetId] })
      .then(value => ({ value }), error => ({ error }));
    try {
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%lock_automation_membership_mutation%') AS waiting`;
        waiting = rows[0]!.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally { unlock(); await sourceAdmission; }
    expect(await expansion).toMatchObject({ error: { response: { code: "bio_source_target_forbidden", operation: "group" } } });
    expect(await prisma.groupFixture.findMany({ where: { groupId: group.id }, select: { fixtureId: true } })).toEqual([{ fixtureId: targetId }]);
  });
});
