import "reflect-metadata";
import { PrismaClient, Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { disposablePostgres } from "./support/disposable-postgres";
import { FixturesModule } from "../src/fixtures/fixtures.module";
import { MqttModule } from "../src/mqtt/mqtt.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { MqttService } from "../src/mqtt/mqtt.service";
import { RedisProvider } from "../src/redis/redis.provider";
import { SessionAuthGuard } from "../src/auth/session-auth.guard";
import { CommandDbClockHealth } from "../src/mqtt/command-db-clock-health.service";
import { FixtureRegistrationRemovalsService } from "../src/fixtures/fixture-registration-removals.service";
import { FixtureRegistrationRemovalPublisherService } from "../src/mqtt/fixture-registration-removal-publisher.service";
import { FixtureRegistrationRemovalCleanupService } from "../src/fixtures/fixture-registration-removal-cleanup.service";
import { FixtureRegistrationRetirementService } from "../src/fixtures/fixture-registration-retirement.service";
import { MeshControlGroupService } from "../src/mesh-control-groups/mesh-control-group.service";
import { SiteAccessService } from "../src/access/site-access.service";
import { FloorEditorService } from "../src/floor-editor/floor-editor.service";
import { AuditService } from "../src/audit/audit.service";
import { hashEditorLeaseToken } from "../src/floor-editor/editor-lease-token";
import { ProvisioningDeviceTerminalService } from "../src/mqtt/provisioning-device-terminal.service";
import { EnergyDimensionHistoryService } from "../src/energy/energy-dimension-history.service";
import { closeSiteEnergyForSettingsChange, FixtureStateIngestionService } from "../src/energy/fixture-state-ingestion.service";
import { BioSensorProfilesService } from "../src/automation/bio-sensor-profiles.service";
import { fixtureRegistrationRemovalCommandSchema, fixtureRegistrationRemovalTerminalSchema, fixtureRegistrationRemovalTopics } from "@led-control/shared";
import { canonicalPayloadHash } from "../src/automation/automation-payload-hash";
import type { AuthenticatedUser } from "../src/auth/auth.types";
const { FixtureRegistrationRemovalHandler } = require("../../gateway/src/commands/fixture-registration-removal-handler");
const { FixtureRegistrationRemovalJournal } = require("../../gateway/src/state/fixture-registration-removal-journal");
const { BioDeviceMappingStore } = require("../../gateway/src/bio/bio-device-mapping-store");

const enabled = process.env.FIXTURE_REMOVAL_API_DISPOSABLE_POSTGRES === "1";
(enabled ? describe : describe.skip)("registration removal production HTTP/PG/software transport", () => {
  jest.setTimeout(90_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>, db: PrismaClient, app: INestApplication;
  let base: string, actor: AuthenticatedUser, ids: Record<string, string>;
  let operations: FixtureRegistrationRemovalsService, publisher: FixtureRegistrationRemovalPublisherService;
  let published: unknown[] = [];
  let gatewayHandler: any, gatewayJournal: any, gatewayRoot: string, dropTerminal = false;
  const transport = { publishTopic: jest.fn(async (topic: string, payload: any) => {
    published.push(payload);
    if (topic.endsWith("/commands/registration-removal")) {
      const command = fixtureRegistrationRemovalCommandSchema.parse(payload);
      const terminal = await gatewayHandler.handle(command);
      if (!dropTerminal) await operations.ingest(fixtureRegistrationRemovalTopics.terminal(command.siteId, command.gatewayId), terminal, new Date());
    }
  }), stopInboundAndDrain: async () => {}, close: async () => {} };
  beforeAll(async () => {
    cluster = await disposablePostgres(); const url = cluster.database();
    const deploy = cluster.deploy(url); if (deploy.status !== 0) throw new Error(deploy.stdout + deploy.stderr);
    db = new PrismaClient({ datasourceUrl: url });
    const clock = new CommandDbClockHealth({ read: async () => {
      const [row] = await db.$queryRaw<any[]>`SELECT clock_timestamp() AS now, pg_postmaster_start_time() AS started,
        inet_server_addr()::text AS address, inet_server_port() AS port`;
      return { issuedAt: row.now, offsetMs: 0, stepGeneration: 0, clearedStepGeneration: 0,
        failoverGeneration: 0, clearedFailoverGeneration: 0, primary: { startedAt: row.started, address: row.address, port: row.port } };
    } });
    const module = await Test.createTestingModule({ imports: [FixturesModule, MqttModule] })
      .overrideProvider(PrismaService).useValue(db)
      .overrideProvider(CommandDbClockHealth).useValue(clock)
      .overrideProvider(MqttService).useValue(transport)
      .overrideProvider(RedisProvider).useValue({})
      .overrideGuard(SessionAuthGuard).useValue({ canActivate(context: any) { context.switchToHttp().getRequest().user = actor; return true; } })
      .compile();
    operations = module.get(FixtureRegistrationRemovalsService);
    publisher = module.get(FixtureRegistrationRemovalPublisherService);
    // Only this test's explicit batches run. Keep all production providers in DI,
    // but disable their timer hooks before boot so tests own scheduling and I/O.
    const timerNames = ["FixtureRegistrationRemovalPublisherService", "FixtureFreshnessService", "MeshGroupSyncWorker",
      "OutboxPublisherService", "RecoveryOutboxPublisherService", "LegacyStatusCheckPublisherService", "CommandTimeoutService",
      "AutomationOutboxPublisherService", "ProvisioningScanOutboxPublisherService", "ProvisioningDeviceOutboxPublisherService",
      "SensorModePublisherService", "BioRegistrationRevalidationPublisherService", "BioSensorCatalogOutboxService"];
    for (const imported of (module as any).container.getModules().values()) for (const provider of imported.providers.values()) {
      if (provider.instance && timerNames.includes(provider.instance.constructor.name)) provider.instance.onModuleInit = () => {};
    }
    app = module.createNestApplication(); app.useLogger(false); await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); await db?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    ids = Object.fromEntries(["org", "actor", "site", "floor", "gateway", "inventory", "cert", "fixture", "node", "candidate", "session", "provision", "event"].map(key => [key, randomUUID()]));
    const now = new Date(); published = []; dropTerminal = false;
    await db.organization.create({ data: { id: ids.org, type: "customer", name: "test" } });
    await db.user.create({ data: { id: ids.actor, organizationId: ids.org, name: "test", loginId: ids.actor, passwordHash: "test", role: "admin" } });
    actor = { id: ids.actor, organizationId: ids.org, organizationType: "customer", name: "test", loginId: ids.actor,
      role: "admin", status: "active", mustChangePassword: false };
    await db.site.create({ data: { id: ids.site, organizationId: ids.org, adminUserId: ids.actor, name: "test" } });
    await db.floor.create({ data: { id: ids.floor, siteId: ids.site, name: "B1", level: -1 } });
    await db.gateway.create({ data: { id: ids.gateway, siteId: ids.site, name: "test", serialNumber: ids.gateway,
      firmwareVersion: "test", claimedAt: now, assignmentVersion: 1, lastHeartbeatAt: now, fixtureRegistrationRemovalVersion: 1 } });
    await db.gatewayInventory.create({ data: { id: ids.inventory, serialNumber: ids.inventory, claimedGatewayId: ids.gateway, claimedAt: now } });
    await db.gatewayCertificate.create({ data: { inventoryId: ids.inventory, gatewayId: ids.gateway, purpose: "mqtt", status: "active", certificateSerial: ids.cert,
      fingerprint: ids.cert, issuer: "test", notBefore: new Date(now.getTime() - 60_000), notAfter: new Date(now.getTime() + 600_000) } });
    const deviceUuid = `bio:${ids.node.replaceAll("-", "").slice(0, 12)}`;
    await db.meshNode.create({ data: { id: ids.node, gatewayId: ids.gateway, deviceUuid, meshAddress: "0x0100", firmwareVersion: "test", vehicleSensorProtocol: "bio_usb_pulse" } });
    await db.fixture.create({ data: { id: ids.fixture, floorId: ids.floor, meshNodeId: ids.node, name: "old", ratedWatt: 20, x: 1, y: 2 } });
    await db.$transaction(tx => new EnergyDimensionHistoryService().ensureFixtureDimensions(tx, [{ fixtureId: ids.fixture, siteId: ids.site,
      floorId: ids.floor, floorName: "B1", name: "old", ratedWatt: new Prisma.Decimal(20), trackingStartedAt: now }], now));
    await db.provisioningSession.create({ data: { id: ids.session, siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway,
      requestedBy: ids.actor, scanStatus: "completed", status: "completed" } });
    await db.discoveredMeshNode.create({ data: { id: ids.candidate, sessionId: ids.session, deviceUuid, serialNumber: "test", rssi: -60,
      oobCapability: "none", firmwareVersion: "test", meshAddress: "0x0100", status: "provisioned", identifyState: "confirmed" } });
    const provision = { siteId: ids.site, gatewayId: ids.gateway, commandId: ids.provision, sessionId: ids.session, nodeId: ids.candidate,
      deviceUuid, meshAddress: "0x0100", requestedAt: now.toISOString() };
    await db.provisioningDeviceOutbox.create({ data: { id: ids.provision, sessionId: ids.session, nodeId: ids.candidate,
      topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/provisioning/provision-device`, payload: provision, publishedAt: now } });
    await db.processedGatewayEvent.create({ data: { eventId: ids.event, gatewayId: ids.gateway, sequence: 1n,
      eventType: "provisioning_device_terminal", payloadHash: canonicalPayloadHash(provision), occurredAt: now } });
    const ack = { siteId: ids.site, gatewayId: ids.gateway, commandId: ids.provision, sessionId: ids.session, nodeId: ids.candidate,
      deviceUuid, meshAddress: "0x0100", eventId: ids.event, sequence: 1, ingestedAt: now.toISOString(), operation: "provision" };
    await db.mqttOutbox.create({ data: { gatewayId: ids.gateway, topic: `sites/${ids.site}/gateways/${ids.gateway}/acks/provisioning/device-terminal-ingested`,
      payload: ack, payloadHash: canonicalPayloadHash(ack), applicationAckKey: `provisioning-device-terminal:${ids.gateway}:${ids.provision}`, publishedAt: now } });
    gatewayRoot = await mkdtemp(join(await realpath("/tmp"), "removal-api-gateway-"));
    const port = new BioDeviceMappingStore(join(gatewayRoot, "mappings.json"));
    await port.reserve({ fixtureId: ids.fixture, nodeId: ids.candidate, deviceUuid, nativeUuid: deviceUuid.slice(4),
      logicalAddress: 0x100, observedLogicalAddressBeforeAssignment: 0x100, commandId: ids.provision, firmware: "test", protocol: "bio-usb-v1" });
    await port.confirm(deviceUuid, 0x100);
    gatewayJournal = new FixtureRegistrationRemovalJournal(join(gatewayRoot, "removals.json")); await gatewayJournal.initialize();
    gatewayHandler = new FixtureRegistrationRemovalHandler({ journal: gatewayJournal, port,
      scope: { siteId: ids.site, gatewayId: ids.gateway, gatewaySerial: ids.gateway, assignmentVersion: 1 },
      clockTrusted: async () => true, blockedReason: async () => null, afterRetire: async () => {} });
  });
  afterEach(async () => {
    await gatewayHandler?.stopAndDrain();
    if (gatewayRoot) await rm(gatewayRoot, { recursive: true, force: true });
    if (db && ids?.site) await db.site.deleteMany({ where: { id: ids.site } });
  });
  const path = () => `/sites/${ids.site}/floors/${ids.floor}/fixtures/${ids.fixture}`;
  async function http(suffix: string, body?: unknown) {
    const response = await fetch(base + path() + suffix, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as any };
  }
  async function admit() {
    const fixture = await db.fixture.findUniqueOrThrow({ where: { id: ids.fixture } });
    const request = { clientRequestId: randomUUID(), expectedUpdatedAt: fixture.updatedAt.toISOString() };
    const result = await http("/registration-removals", request);
    expect(result).toMatchObject({ status: 202, body: { status: "pending" } });
    return { request, operationId: result.body.operationId as string };
  }
  async function applyCatalog(operationId: string) {
    const row = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    await db.$transaction(tx => app.get(FixtureRegistrationRemovalCleanupService).prepare(tx, row, new Date()));
    const catalog = await db.bioSensorCatalogDelivery.findFirstOrThrow({ where: { gatewayId: ids.gateway, supersededAt: null } });
    const payload: any = catalog.payload;
    await expect(app.get(BioSensorProfilesService).ingestCatalogAck({ schemaVersion: 1, siteId: ids.site, gatewayId: ids.gateway,
      assignmentVersion: 1, eventId: randomUUID(), catalogRevision: payload.catalogRevision, deliveryPayloadHash: catalog.payloadHash,
      status: "applied", occurredAt: new Date().toISOString() }, { siteId: ids.site, gatewayId: ids.gateway })).rejects.toThrow();
    await app.get(BioSensorProfilesService).ingestCatalogAck({ schemaVersion: 1, siteId: ids.site, gatewayId: ids.gateway,
      assignmentVersion: 1, eventId: payload.eventId, catalogRevision: payload.catalogRevision, deliveryPayloadHash: catalog.payloadHash,
      status: "applied", occurredAt: new Date().toISOString() }, { siteId: ids.site, gatewayId: ids.gateway });
  }
  it("boots production Nest providers and performs HTTP -> exact terminal -> atomic retirement preserving history", async () => {
    expect(app.get(FixtureRegistrationRemovalPublisherService)).toBeInstanceOf(FixtureRegistrationRemovalPublisherService);
    expect(await http("/registration-removal-preview")).toMatchObject({ status: 200, body: { allowed: true } });
    const { request, operationId } = await admit();
    expect(await http(`/registration-removals/by-request/${request.clientRequestId}`)).toMatchObject({ status: 200, body: { operationId } });
    expect(await http("/registration-removals", request)).toMatchObject({ status: 202, body: { operationId } });
    await applyCatalog(operationId);
    await publisher.processBatch(); await operations.finalize(operationId);
    const row = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    expect(row).toMatchObject({ status: "completed", nodeId: ids.candidate, meshNodeId: ids.node });
    expect(row.nodeId).not.toBe(row.meshNodeId);
    expect(await db.meshNode.findUniqueOrThrow({ where: { id: ids.node } })).toMatchObject({ deviceUuid: null, retiredAt: expect.any(Date) });
    expect(await db.fixture.findUniqueOrThrow({ where: { id: ids.fixture } })).toMatchObject({ retiredAt: expect.any(Date) });
    expect(await db.provisioningDeviceOutbox.count({ where: { id: ids.provision } })).toBe(1);
    expect(await db.processedGatewayEvent.count({ where: { eventId: ids.event } })).toBe(1);
    expect((await fetch(`${base}/sites/${ids.site}/floors/${ids.floor}/fixtures/settings`).then(r => r.json()) as any).items).toEqual([]);
    await db.$transaction(tx => closeSiteEnergyForSettingsChange(tx, { siteId: ids.site, timeZone: "Asia/Seoul", tariffKwhRate: new Prisma.Decimal(500) }));
    await db.meshNode.create({ data: { gatewayId: ids.gateway, deviceUuid: row.deviceUuid, meshAddress: "0x0101", firmwareVersion: "new", vehicleSensorProtocol: "bio_usb_pulse" } });
  });
  it("rechecks offline/version0, disabled rule/group links, lease and actor at POST", async () => {
    await db.gateway.update({ where: { id: ids.gateway }, data: { fixtureRegistrationRemovalVersion: 0, lastHeartbeatAt: null } });
    const preview = await http("/registration-removal-preview");
    expect(preview.body.blockedReasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(["GATEWAY_OFFLINE", "GATEWAY_UNSUPPORTED"]));
    const fixture = await db.fixture.findUniqueOrThrow({ where: { id: ids.fixture } });
    const request = { clientRequestId: randomUUID(), expectedUpdatedAt: fixture.updatedAt.toISOString() };
    expect(await http("/registration-removals", request)).toMatchObject({ status: 409 });
    await db.gateway.update({ where: { id: ids.gateway }, data: { fixtureRegistrationRemovalVersion: 1, lastHeartbeatAt: new Date() } });
    await db.floor.update({ where: { id: ids.floor }, data: { editorLeaseExpiresAt: new Date(Date.now() + 60_000) } });
    expect((await http("/registration-removals", request)).body.blockedReasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "MAP_EDITOR_BUSY" })]));
    actor = { ...actor, role: "viewer" }; expect(await http("/registration-removal-preview")).toMatchObject({ status: 403 });
    actor = { ...actor, role: "admin", id: randomUUID() }; expect(await http("/registration-removal-preview")).toMatchObject({ status: 404 });
    expect(await db.fixtureRegistrationRemovalOperation.count({ where: { siteId: ids.site } })).toBe(0);
  });
  it("closes observed energy, preserves old totals and rejects late telemetry after retirement and tariff change", async () => {
    await db.site.update({ where: { id: ids.site }, data: { tariffKwhRate: 100 } });
    const ingestion = new FixtureStateIngestionService(db as never);
    const event = { siteId: ids.site, gatewayId: ids.gateway, fixtureId: ids.fixture, eventId: randomUUID(), sequence: 10,
      occurredAt: new Date().toISOString(), brightness: 70, powerOn: true, status: "online" as const, statusReason: "reported" as const, rssi: -55, hopCount: 1 };
    await ingestion.ingest(ids.gateway, event);
    const { operationId } = await admit(); await applyCatalog(operationId); await publisher.processBatch(); await operations.finalize(operationId);
    const cursor = await db.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: ids.fixture } });
    const aggregate = await db.fixtureEnergyDailyAggregate.findMany({ where: { fixtureId: ids.fixture } });
    await db.$transaction(tx => closeSiteEnergyForSettingsChange(tx, { siteId: ids.site, timeZone: "Asia/Seoul", tariffKwhRate: new Prisma.Decimal(500) }));
    await expect(ingestion.ingest(ids.gateway, { ...event, eventId: randomUUID(), sequence: 11 })).rejects.toThrow();
    expect(await db.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: ids.fixture } })).toEqual(cursor);
    expect(await db.fixtureEnergyDailyAggregate.findMany({ where: { fixtureId: ids.fixture } })).toEqual(aggregate);
    expect(await db.energyFixtureIdentity.findUniqueOrThrow({ where: { fixtureId: ids.fixture } })).toMatchObject({ retiredAt: expect.any(Date) });
  });
  it("rejects a new control snapshot and DB-only group membership after pending admission", async () => {
    const otherNode = await db.meshNode.create({ data: { gatewayId: ids.gateway, deviceUuid: `bio:${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      meshAddress: "0x0102", firmwareVersion: "test" } });
    const otherFixture = await db.fixture.create({ data: { floorId: ids.floor, meshNodeId: otherNode.id, name: "other", ratedWatt: 20, x: 0, y: 0 } });
    const group = await db.fixtureGroup.create({ data: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway, name: "new group",
      groupFixtures: { create: { fixtureId: otherFixture.id } } } });
    await admit();
    const { TargetSnapshotService } = require("../src/automation/target-snapshot.service");
    await expect(db.$transaction(tx => new TargetSnapshotService().resolve(tx, ids.site, { type: "fixture", fixtureId: ids.fixture }))).rejects.toThrow();
    await expect(db.groupFixture.create({ data: { groupId: group.id, fixtureId: ids.fixture } })).rejects.toThrow();
  });
  it("recovers a lost terminal with the same expired command and no new operation or TTL", async () => {
    const { operationId } = await admit(); await applyCatalog(operationId);
    dropTerminal = true; await publisher.processBatch();
    const before = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    expect(before.status).toBe("pending");
    expect((await gatewayHandler.handle(before.payload)).status).toBe("removed");
    // Exercise real expiry against the self-owned DB/real server clock. The
    // durable Gateway journal survives this delay; no command time is rewritten.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, before.expiresAt.getTime() - Date.now() + 20)));
    dropTerminal = false;
    await publisher.processBatch(); await operations.finalize(operationId);
    const after = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    expect(after).toMatchObject({ status: "completed", operationId, payload: before.payload, commandHash: before.commandHash,
      requestedAt: before.requestedAt, expiresAt: before.expiresAt });
    expect(published.filter((p: any) => p.operationId === operationId && p.requestedAt)).toEqual([before.payload, before.payload]);
  });
  it("waits for exact internal group cleanup ACK including an empty floor group", async () => {
    const group = await db.meshControlGroup.create({ data: { gatewayId: ids.gateway, targetType: "floor", targetId: ids.floor,
      groupAddress: "0xc000", status: "ready", configurationVersion: 1, operationPlanVersion: 1 } });
    await db.meshControlGroupMember.create({ data: { groupId: group.id, gatewayId: ids.gateway, meshNodeId: ids.node,
      subscriptionStatus: "applied", appliedVersion: 1, statusVersion: 1 } });
    await db.meshControlGroupAppliedMember.create({ data: { groupId: group.id, gatewayId: ids.gateway, meshNodeId: ids.node, meshAddress: "0x0100" } });
    const { operationId } = await admit(); await applyCatalog(operationId);
    await publisher.processBatch();
    expect(await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } })).toMatchObject({ status: "pending", publishedAt: null });
    const mesh = new MeshControlGroupService();
    const command = await db.$transaction(tx => mesh.prepareSubscriptionSync(tx, { groupId: group.id, gatewayId: ids.gateway,
      configurationVersion: 2, requestedAt: new Date().toISOString() }));
    expect(command?.desiredMembers).toEqual([]);
    const consumer = new MqttService(db as never, mesh);
    const result = { siteId: ids.site, gatewayId: ids.gateway, groupId: group.id, version: 2, groupAddress: "0xc000",
      operations: command!.expectedOperations.map(operation => ({ ...operation, status: "ready" })), occurredAt: new Date().toISOString() };
    await consumer.handleMessage(`sites/${ids.site}/gateways/${ids.gateway}/events/mesh-group/subscription-result`, Buffer.from(JSON.stringify({ ...result, version: 1 })));
    expect((await db.meshControlGroup.findUniqueOrThrow({ where: { id: group.id } })).status).toBe("configuring");
    await consumer.handleMessage(`sites/${ids.site}/gateways/${ids.gateway}/events/mesh-group/subscription-result`, Buffer.from(JSON.stringify(result)));
    await db.fixtureRegistrationRemovalOperation.update({ where: { operationId }, data: { nextAttemptAt: new Date() } });
    await publisher.processBatch(); await operations.finalize(operationId);
    expect((await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } })).status).toBe("completed");
  });
  it("preserves removed evidence when final DB work fails and resumes with a new service instance", async () => {
    const { operationId } = await admit(); await applyCatalog(operationId); await publisher.processBatch();
    const retirement = app.get(FixtureRegistrationRetirementService);
    const failure = jest.spyOn(retirement, "retire").mockRejectedValueOnce(new Error("test DB failure"));
    await expect(operations.finalize(operationId)).rejects.toThrow("test DB failure"); failure.mockRestore();
    const before = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    expect(before.status).toBe("gateway_confirmed");
    expect((await db.meshNode.findUniqueOrThrow({ where: { id: ids.node } })).deviceUuid).toBe(before.deviceUuid);
    const restarted = new FixtureRegistrationRemovalsService(db as never, new SiteAccessService(db as never), app.get(CommandDbClockHealth),
      app.get(FixtureRegistrationRemovalCleanupService), retirement);
    await restarted.finalize(operationId);
    expect(await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } })).toMatchObject({ status: "completed",
      resultHash: before.resultHash, result: before.result, applicationAck: before.applicationAck });
  });
  it("uses fresh preview timestamp after ordinary telemetry without dropping POST concurrency protection", async () => {
    const stale = await db.fixture.findUniqueOrThrow({ where: { id: ids.fixture } });
    await db.site.update({ where: { id: ids.site }, data: { tariffKwhRate: 100 } });
    await new FixtureStateIngestionService(db as never).ingest(ids.gateway, { siteId: ids.site, gatewayId: ids.gateway,
      fixtureId: ids.fixture, eventId: randomUUID(), sequence: 10, occurredAt: new Date().toISOString(), brightness: 50,
      powerOn: true, status: "online", statusReason: "reported", rssi: -55, hopCount: 1 });
    const request = { clientRequestId: randomUUID(), expectedUpdatedAt: stale.updatedAt.toISOString() };
    expect(await http("/registration-removals", request)).toMatchObject({ status: 409 });
    const preview = await http("/registration-removal-preview");
    expect(preview.body).toMatchObject({ fixtureName: stale.name, allowed: true });
    expect(preview.body.expectedUpdatedAt).not.toBe(request.expectedUpdatedAt);
    expect(await http("/registration-removals", { ...request, expectedUpdatedAt: preview.body.expectedUpdatedAt })).toMatchObject({ status: 202 });
  });
  it("does not resurrect retired fixtures through either legacy or document restore", async () => {
    const object = await db.floorMapObject.create({ data: { floorId: ids.floor, type: "rectangle", x: 5, y: 6, width: 10, height: 20 } });
    const editor: any = new FloorEditorService(db as never, new SiteAccessService(db as never), new AuditService(db as never));
    const floor = await db.floor.findUniqueOrThrow({ where: { id: ids.floor }, include: { fixtures: true, mapObjects: true, floorPlan: true, lightSlots: true } });
    const snapshot = editor.buildSnapshot(floor);
    await db.floorMapRevision.create({ data: { floorId: ids.floor, revision: 1, snapshot, snapshotSha256: "a".repeat(64), changeSummary: {}, changedBy: ids.actor } });
    const { operationId } = await admit(); await applyCatalog(operationId); await publisher.processBatch(); await operations.finalize(operationId);
    await db.floor.update({ where: { id: ids.floor }, data: { mapRevision: 1, editorLeaseFence: 1,
      editorLeaseTokenHash: hashEditorLeaseToken("test-lease"), editorLeaseHolderId: ids.actor, editorLeaseExpiresAt: new Date(Date.now() + 60_000) } });
    const restored = await editor.restoreEditorRevision(actor, ids.floor, 1, { expectedRevision: 1, leaseToken: "test-lease", leaseFence: 1 });
    expect(restored.skippedFixtureIds).toEqual([ids.fixture]);
    expect(await db.floorMapObject.findUniqueOrThrow({ where: { id: object.id } })).toMatchObject({ x: 5, y: 6, width: 10, height: 20 });
    const document = { formatVersion: 1, generationId: randomUUID(), revision: 3, width: 1000, height: 1000, gridSize: 20,
      elementCount: 123, manifest: { assetId: randomUUID(), sha256: "b".repeat(64), byteSize: 100, decodedByteSize: 200 } };
    const source = { version: 3, document, fixtures: snapshot.fixtures, lightSlots: [] };
    const documentResult: any = await db.$transaction(tx => editor.applyDocumentRestore(tx, ids.floor, source, new Date(), document));
    expect(documentResult.result.skippedFixtureIds).toEqual([ids.fixture]);
    expect(documentResult.snapshot.document).toEqual(document);
    expect(documentResult.snapshot.fixtures).toEqual([]);
  });
  it("registers the same physical UUID through the production provisioning terminal as a fresh fixture/node", async () => {
    const { operationId } = await admit(); await applyCatalog(operationId); await publisher.processBatch(); await operations.finalize(operationId);
    const old = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    const session = await db.provisioningSession.create({ data: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway,
      requestedBy: ids.actor, scanStatus: "completed" } });
    const candidate = await db.discoveredMeshNode.create({ data: { sessionId: session.id, deviceUuid: old.deviceUuid, serialNumber: "new",
      firmwareVersion: "test", rssi: -55, oobCapability: "none", status: "provisioning", meshAddress: "0x0101",
      pendingFixtureName: "Fresh", pendingFixtureX: 0, pendingFixtureY: 0, pendingRatedWatt: 25 } });
    const commandId = randomUUID();
    const payload = { siteId: ids.site, gatewayId: ids.gateway, sessionId: session.id, nodeId: candidate.id, commandId,
      deviceUuid: old.deviceUuid, meshAddress: "0x0101", requestedAt: new Date().toISOString() };
    await db.provisioningDeviceOutbox.create({ data: { id: commandId, sessionId: session.id, nodeId: candidate.id,
      topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/provisioning/provision-device`, payload } });
    const { requestedAt: _requested, ...terminalIdentity } = payload;
    await new ProvisioningDeviceTerminalService(db as never, new MeshControlGroupService(), new EnergyDimensionHistoryService()).ingest(
      { siteId: ids.site, gatewayId: ids.gateway }, { ...terminalIdentity, eventId: randomUUID(), sequence: 100, status: "completed",
        occurredAt: new Date().toISOString(), firmwareVersion: "test" }, new Date());
    const fresh = await db.fixture.findUniqueOrThrow({ where: { id: candidate.id }, include: { meshNode: true } });
    expect(fresh.id).not.toBe(ids.fixture); expect(fresh.meshNodeId).not.toBe(ids.node);
    expect(fresh).toMatchObject({ name: "Fresh", brightness: 0, powerOn: null, retiredAt: null });
    expect(fresh.meshNode).toMatchObject({ bioPulseReadiness: "off", bioPulseProfileId: null, bioPulseVerifiedAt: null,
      vehicleSensorCapabilityStatus: "unknown", bioPulseCapabilityRevision: 0n });
    expect((await db.fixture.findUniqueOrThrow({ where: { id: ids.fixture } })).retiredAt).not.toBeNull();
  });
  it("preserves unknown terminal and ACK evidence while a later definitive result completes after TTL", async () => {
    const { operationId } = await admit(); await applyCatalog(operationId);
    const row = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    const command = fixtureRegistrationRemovalCommandSchema.parse(row.payload);
    const unknown = fixtureRegistrationRemovalTerminalSchema.parse({ ...command, commandHash: row.commandHash,
      eventId: randomUUID(), occurredAt: new Date().toISOString(), status: "reconcile_required", errorCode: "PERSISTENCE_UNCERTAIN" });
    const oldAck = await operations.ingest(fixtureRegistrationRemovalTopics.terminal(ids.site, ids.gateway), unknown, new Date());
    const removed = await gatewayHandler.handle(command);
    // A process can lose a later durable result until its original command TTL
    // expires. Cloud must converge using that result, not a fresh operation.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, row.expiresAt.getTime() - Date.now() + 20)));
    const newAck = await operations.ingest(fixtureRegistrationRemovalTopics.terminal(ids.site, ids.gateway), removed, new Date());
    await operations.finalize(operationId);
    expect(newAck.eventId).toBe(removed.eventId);
    expect(await operations.ingest(fixtureRegistrationRemovalTopics.terminal(ids.site, ids.gateway), unknown, new Date())).toEqual(oldAck);
    expect(await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } })).toMatchObject({ status: "completed",
      resultEventId: removed.eventId, resultHash: canonicalPayloadHash(removed), applicationAck: newAck });
    const evidence = await (db as any).fixtureRegistrationRemovalResultEvidence.findMany({ where: { operationId }, orderBy: { receivedAt: "asc" } });
    expect(evidence.map((entry: any) => entry.eventId)).toEqual([unknown.eventId, removed.eventId]);
    expect(evidence.map((entry: any) => entry.applicationAck)).toEqual([oldAck, newAck]);
    expect(await gatewayJournal.acknowledge(oldAck)).toBe(false);
    expect(await gatewayJournal.acknowledge(newAck)).toBe(true);
    await expect(db.fixtureRegistrationRemovalOperation.update({ where: { operationId }, data: {
      result: unknown, resultEventId: unknown.eventId, resultHash: canonicalPayloadHash(unknown), applicationAck: oldAck,
      applicationAckHash: canonicalPayloadHash(oldAck) } })).rejects.toThrow();
    await expect((db as any).fixtureRegistrationRemovalResultEvidence.deleteMany({ where: { operationId } })).rejects.toThrow();
  });
  it("restores rejected cleanup after expiry and restart, closing only after exact rollback ACKs", async () => {
    const mesh = new MeshControlGroupService();
    const group = await db.meshControlGroup.create({ data: { gatewayId: ids.gateway, targetType: "floor", targetId: ids.floor,
      groupAddress: "0xc000", status: "ready", configurationVersion: 1, operationPlanVersion: 1 } });
    await db.meshControlGroupMember.create({ data: { groupId: group.id, gatewayId: ids.gateway, meshNodeId: ids.node,
      subscriptionStatus: "applied", appliedVersion: 1, statusVersion: 1 } });
    await db.meshControlGroupAppliedMember.create({ data: { groupId: group.id, gatewayId: ids.gateway, meshNodeId: ids.node, meshAddress: "0x0100" } });
    const { operationId } = await admit(); await applyCatalog(operationId);
    const consumer = new MqttService(db as never, mesh);
    const converge = async (version: number) => {
      const command = await db.$transaction(tx => mesh.prepareSubscriptionSync(tx, { groupId: group.id, gatewayId: ids.gateway,
        configurationVersion: version, requestedAt: new Date().toISOString() }));
      await consumer.handleMessage(`sites/${ids.site}/gateways/${ids.gateway}/events/mesh-group/subscription-result`, Buffer.from(JSON.stringify({
        siteId: ids.site, gatewayId: ids.gateway, groupId: group.id, version, groupAddress: "0xc000",
        operations: command!.expectedOperations.map(operation => ({ ...operation, status: "ready" })), occurredAt: new Date().toISOString() })));
      return command;
    };
    await converge(2);
    const original = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, original.expiresAt.getTime() - Date.now() + 20)));
    await publisher.processBatch();
    expect((await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } })).result)
      .toMatchObject({ status: "rejected" });
    const restartedCleanup = new FixtureRegistrationRemovalCleanupService(app.get(BioSensorProfilesService));
    const restarted = new FixtureRegistrationRemovalsService(db as any, app.get(SiteAccessService), app.get(CommandDbClockHealth),
      restartedCleanup, app.get(FixtureRegistrationRetirementService));
    const restartedPublisher = new FixtureRegistrationRemovalPublisherService(db as any, transport as any, restarted,
      restartedCleanup, app.get(CommandDbClockHealth));
    await restartedPublisher.processBatch();
    const recovery = await (db as any).fixtureRegistrationRemovalCleanupRecovery.findUniqueOrThrow({ where: { operationId } });
    expect(recovery.rollbackSnapshot.groups).toEqual([{ id: group.id, configurationVersion: 3,
      desiredHash: canonicalPayloadHash([{ meshNodeId: ids.node, meshAddress: "0x0100" }]) }]);
    expect((await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } })).status).toBe("reconcile_required");
    await expect(db.fixtureRegistrationRemovalOperation.update({ where: { operationId }, data: { status: "rejected" } })).rejects.toThrow();
    await expect((db as any).fixtureRegistrationRemovalCleanupRecovery.update({ where: { operationId }, data: { rollbackSnapshot: {} } })).rejects.toThrow();
    await expect((db as any).fixtureRegistrationRemovalCleanupRecovery.delete({ where: { operationId } })).rejects.toThrow();
    const restoredGroup = await converge(3);
    expect(restoredGroup!.desiredMembers).toEqual([{ meshNodeId: ids.node, meshAddress: "0x0100" }]);
    await restarted.finalize(operationId);
    expect((await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } })).status).toBe("reconcile_required");
    const catalog = await db.bioSensorCatalogDelivery.findFirstOrThrow({ where: { gatewayId: ids.gateway, supersededAt: null } });
    const payload: any = catalog.payload;
    await app.get(BioSensorProfilesService).ingestCatalogAck({ schemaVersion: 1, siteId: ids.site, gatewayId: ids.gateway,
      assignmentVersion: 1, eventId: payload.eventId, catalogRevision: payload.catalogRevision, deliveryPayloadHash: catalog.payloadHash,
      status: "applied", occurredAt: new Date().toISOString() }, { siteId: ids.site, gatewayId: ids.gateway });
    await restartedPublisher.processBatch();
    const final = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    expect(final).toMatchObject({ status: "rejected", payload: original.payload, commandHash: original.commandHash, expiresAt: original.expiresAt });
    expect(await db.fixtureRegistrationRemovalOperation.count({ where: { fixtureId: ids.fixture } })).toBe(1);
    expect(await db.fixture.findUniqueOrThrow({ where: { id: ids.fixture } })).toMatchObject({ retiredAt: null });
    expect((await http("/registration-removal-preview")).body.allowed).toBe(true);
  });
  it("never rolls back unknown evidence and restores only original desired memberships after definitive rejection", async () => {
    const anchor = await db.meshNode.create({ data: { gatewayId: ids.gateway, meshAddress: "0x0101", firmwareVersion: "test" } });
    await db.fixture.create({ data: { floorId: ids.floor, meshNodeId: anchor.id, name: "anchor", ratedWatt: 20, x: 0, y: 0 } });
    const group = await db.meshControlGroup.create({ data: { gatewayId: ids.gateway, targetType: "floor", targetId: ids.floor,
      groupAddress: "0xc000", status: "ready", configurationVersion: 1, operationPlanVersion: 1 } });
    await db.meshControlGroupMember.createMany({ data: [ids.node, anchor.id].map(meshNodeId => ({ groupId: group.id,
      gatewayId: ids.gateway, meshNodeId, subscriptionStatus: "applied", appliedVersion: 1, statusVersion: 1 })) });
    const { operationId } = await admit(); await applyCatalog(operationId);
    const row = await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } });
    const command = fixtureRegistrationRemovalCommandSchema.parse(row.payload);
    const unknown = { ...command, commandHash: row.commandHash, eventId: randomUUID(), occurredAt: new Date().toISOString(),
      status: "reconcile_required", errorCode: "PERSISTENCE_UNCERTAIN" };
    await operations.ingest(fixtureRegistrationRemovalTopics.terminal(ids.site, ids.gateway), unknown, new Date());
    await operations.finalize(operationId);
    const recovery = await db.fixtureRegistrationRemovalCleanupRecovery.findUniqueOrThrow({ where: { operationId } });
    expect(recovery.rollbackSnapshot).toBeNull();
    await expect(db.fixtureRegistrationRemovalCleanupRecovery.update({ where: { operationId }, data: { rollbackSnapshot: {} } })).rejects.toThrow();
    await expect(db.fixtureRegistrationRemovalCleanupRecovery.update({ where: { operationId }, data: { beforeSnapshot: {} } })).rejects.toThrow();
    await expect(db.fixtureRegistrationRemovalOperation.update({ where: { operationId }, data: { status: "rejected" } })).rejects.toThrow();
    await expect(db.meshControlGroupMember.update({ where: { groupId_meshNodeId: { groupId: group.id, meshNodeId: ids.node } }, data: { desired: true } })).rejects.toThrow();
    await operations.ingest(fixtureRegistrationRemovalTopics.terminal(ids.site, ids.gateway), { ...unknown,
      eventId: randomUUID(), occurredAt: new Date().toISOString(), status: "rejected", errorCode: "CONTROL_UNSETTLED" }, new Date());
    await operations.finalize(operationId);
    const restored = await db.$transaction(tx => new MeshControlGroupService().prepareSubscriptionSync(tx, {
      groupId: group.id, gatewayId: ids.gateway, configurationVersion: 3, requestedAt: new Date().toISOString() }));
    expect(restored!.desiredMembers).toEqual([{ meshNodeId: ids.node, meshAddress: "0x0100" },
      { meshNodeId: anchor.id, meshAddress: "0x0101" }].sort((a, b) => a.meshNodeId.localeCompare(b.meshNodeId)));
    const outside = await db.meshControlGroup.create({ data: { gatewayId: ids.gateway, targetType: "fixture_group", targetId: randomUUID(), groupAddress: "0xc001" } });
    await expect(db.meshControlGroupMember.create({ data: { groupId: outside.id, gatewayId: ids.gateway, meshNodeId: ids.node } })).rejects.toThrow();
    await expect(db.fixtureRegistrationRemovalOperation.update({ where: { operationId }, data: { status: "rejected" } })).rejects.toThrow();
    expect((await db.fixtureRegistrationRemovalOperation.findUniqueOrThrow({ where: { operationId } })).status).toBe("reconcile_required");
  });
});
