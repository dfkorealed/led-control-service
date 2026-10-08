import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "./support/disposable-postgres";
import { PrismaService } from "../src/prisma/prisma.service";
import { SiteAccessService } from "../src/access/site-access.service";
import { AuthenticatedUser } from "../src/auth/auth.types";
import { bioSensorCatalogTopics, bioSensorPreparationTopics } from "@led-control/shared";
import { BioSensorProfilesService } from "../src/automation/bio-sensor-profiles.service";
import { BioSensorPreparationService } from "../src/automation/bio-sensor-preparation.service";
import { BioSensorCatalogOutboxService } from "../src/automation/bio-sensor-catalog-outbox.service";
import { canonicalPayloadHash } from "../src/automation/automation-payload-hash";
import { VehicleSensorCapabilityService } from "../src/automation/vehicle-sensor-capability.service";
import { AutomationSnapshotService } from "../src/automation/automation-snapshot.service";
import { AutomationClock } from "../src/automation/automation-clock";
import { TargetSnapshotService } from "../src/automation/target-snapshot.service";
import { VehicleEventRulesService } from "../src/automation/vehicle-event-rules.service";
import { AutomationMqttConsumerService } from "../src/automation/automation-mqtt-consumer.service";
import { loadBioSensorEligibility } from "../src/automation/bio-sensor-eligibility";
import { BioClassificationReconciliationService } from "../src/registration/bio-classification-reconciliation.service";
import { AuditService } from "../src/audit/audit.service";

const fingerprint = { deviceType: 1, firmware: { major: 1, minor: 2, revision: 3, build: 4 }, sensorType: 1,
  infraredType: 0, ambientLightType: 0, hardwareType: 2 };
const profileInput = () => ({ profileId: randomUUID(), revision: 1, status: "approved", fingerprint,
  bodyHexes: ["0001020304050607"], linkPolicy: { kind: "mode-get", probeIntervalMs: 1000, maxAgeMs: 5000 },
  evidenceDigest: `sha256:${"a".repeat(64)}`, reuseScope: "synthetic-test-only" });

(process.env.BIO_SENSOR_CATALOG_DISPOSABLE_POSTGRES === "1" ? describe : describe.skip)("BIO catalog/preparation disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>, prisma: PrismaClient;
  let profiles: any, preparation: any, worker: any;
  let actor: AuthenticatedUser, operator: AuthenticatedUser;
  let siteId: string, gatewayId: string, fixtureId: string;
  let transactionDepth = 0; let delivered: Array<{ topic: string; payload: any }>;
  beforeAll(async () => {
    cluster = await disposablePostgres(); const url = cluster.database(); const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(deployed.stderr + deployed.stdout);
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const migrations = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`;
    console.info(`BIO disposable migration deploy: exit ${deployed.status}, ${migrations[0].count} applied, includes 20261008030000_bio_sensor_catalog_preparation`);
    const db = prisma as PrismaService; const access = new SiteAccessService(db);
    profiles = new BioSensorProfilesService(db, access);
    preparation = new BioSensorPreparationService(db, access, profiles);
    const original = db.$transaction.bind(db);
    (db as any).$transaction = (callback: any, options: any) => original(async tx => {
      transactionDepth++; try { return await callback(tx); } finally { transactionDepth--; }
    }, options);
    worker = new BioSensorCatalogOutboxService(db, { publishTopic: async (topic: string, payload: any) => {
      expect(transactionDepth).toBe(0); delivered.push({ topic, payload });
    } } as any, profiles);
  }, 60_000);
  afterAll(async () => { await prisma?.$disconnect(); cluster?.stop(); });
  beforeEach(async () => {
    if (!prisma) return;
    // Each case approves a distinct synthetic fingerprint; production rejects
    // two simultaneously approved profiles for the same exact fingerprint.
    fingerprint.firmware.build++;
    delivered = [];
    const id = randomUUID(); const org = await prisma.organization.create({ data: { name: id, type: "customer" } });
    const user = await prisma.user.create({ data: { organizationId: org.id, loginId: id, name: "Admin", role: "admin", passwordHash: "unused" } });
    actor = { ...user, organizationType: "customer" } as AuthenticatedUser;
    const provider = await prisma.organization.findFirst({ where: { type: "service_provider" } }) ?? await prisma.organization.create({ data: { name: id, type: "service_provider" } });
    const providerUser = await prisma.user.findFirst({ where: { role: "operator" } }) ?? await prisma.user.create({ data: { organizationId: provider.id, loginId: randomUUID(), name: "Operator", role: "operator", passwordHash: "unused" } });
    operator = { ...await prisma.user.update({ where: { id: providerUser.id }, data: { status: "active" } }), organizationType: "service_provider" } as AuthenticatedUser;
    siteId = (await prisma.site.create({ data: { organizationId: org.id, adminUserId: actor.id, name: id } })).id;
    const floor = await prisma.floor.create({ data: { siteId, name: "B1", level: -1 } });
    gatewayId = (await prisma.gateway.create({ data: { siteId, name: id, serialNumber: id, firmwareVersion: "synthetic", assignmentVersion: 1, claimedAt: new Date() } })).id;
    const inventory = await prisma.gatewayInventory.create({ data: { serialNumber: `inv-${id}`, claimedGatewayId: gatewayId, claimedAt: new Date() } });
    await prisma.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId, purpose: "mqtt", status: "active", certificateSerial: id,
      fingerprint: id, issuer: "synthetic", notBefore: new Date(Date.now() - 10_000), notAfter: new Date(Date.now() + 300_000) } });
    const node = await prisma.meshNode.create({ data: { gatewayId, meshAddress: "0x0001", firmwareVersion: "synthetic", deviceUuid: `bio:${id.replaceAll("-", "").slice(0, 12)}`, vehicleSensorProtocol: "bio_usb_pulse" } });
    fixtureId = (await prisma.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "A", ratedWatt: 20, x: 0, y: 0, brightness: 42 } })).id;
  });
  const request = (operation = "query") => ({ siteId, fixtureId, clientRequestId: randomUUID(), operation });
  async function report(commandId: string, changes: Record<string, unknown> = {}) {
    const row = await (prisma as any).bioSensorPreparationOperation.findUniqueOrThrow({ where: { commandId } });
    const { requestedAt: _r, expiresAt: _e, ...identity } = row.payload;
    const catalog = await profiles.buildCurrentCatalog(siteId, gatewayId);
    const profile = catalog.profiles.find((value: any) => value.status === "approved" && JSON.stringify(value.fingerprint) === JSON.stringify(fingerprint));
    return { ...identity, eventId: randomUUID(), commandPayloadHash: row.payloadHash, fingerprint,
      profileKey: profile ? `${profile.profileId}@${profile.revision}` : null, connectionGeneration: 1,
      observedAt: new Date().toISOString(), status: "ready", modeVerified: true, linkVerified: true, errorCode: null, ...changes };
  }
  const ingest = (value: any) => preparation.ingestAuthenticated(value, { siteId, gatewayId, requireActiveClaim: true });
  async function eligibility(at = new Date()) {
    return (await prisma.$queryRaw<Array<{ reasons: string[] }>>`SELECT bio_sensor_blocked_reasons(${fixtureId}, (${at}::timestamptz AT TIME ZONE 'UTC')) AS reasons`)[0].reasons;
  }
  async function qualifiedCheckpoint() {
    const profile = profileInput(); await profiles.createRevision(operator, profile);
    await profiles.setSitePolicy(actor, siteId, { enabled: true, ownerUserId: actor.id, maximumResponseSeconds: 30, escalationAction: "operator-call" });
    const created = await preparation.create(actor, request()); await acceptCatalog();
    const prepared = await report(created.commandId);
    expect((await ingest(prepared)).status).toBe("applied");
    await prisma.gatewayAutomationProtocolSupport.create({ data: { siteId, gatewayId, assignmentVersion: 1, declarationRevision: 1n,
      declarationId: randomUUID(), maxSnapshotVersion: 2, payloadHash: `sha256:${"b".repeat(64)}`, declaredAt: new Date() } });
    const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
    const live = { schemaVersion: 2 as const, eventId: randomUUID(), siteId, gatewayId, meshNodeId: fixture.meshNodeId!,
      capabilityRevision: 1, sensorProtocol: "bio-usb-pulse" as const, readiness: "ready" as const,
      verifiedFingerprintId: `${profile.profileId}@1`, sensorModeVerifiedAt: prepared.observedAt, verifiedAt: new Date().toISOString() };
    const clock = new AutomationClock(); const snapshots = new AutomationSnapshotService(clock);
    const capability = new VehicleSensorCapabilityService(prisma as never, snapshots, clock);
    expect((await capability.applyBioDelivery({ schemaVersion: 2, assignmentVersion: 1, report: live }, { siteId, gatewayId, requireActiveClaim: true })).status).toBe("applied");
    return { profile, created, fixture, capability, live, snapshots, clock };
  }
  it("Task4: mode-only and historical ready never satisfy current preparation", async () => {
    expect(await eligibility()).toEqual(expect.arrayContaining(["mode_unverified", "link_unverified", "profile_unverified"]));
  });
  it("Task4: exact accepted preparation, catalog ACK, current policy, V2 and independent live health qualify", async () => {
    await qualifiedCheckpoint(); expect(await eligibility()).toEqual([]);
    expect(await eligibility(new Date(Date.now() + 6_000))).toContain("link_unverified");
  });
  it("Task4: missing catalog ACK and other assignment fail closed", async () => {
    await qualifiedCheckpoint();
    await prisma.bioSensorCatalogDelivery.updateMany({ where: { siteId, gatewayId }, data: { appliedAt: null } });
    expect(await eligibility()).toContain("catalog_pending");
    await prisma.gateway.update({ where: { id: gatewayId }, data: { assignmentVersion: 2 } });
    expect(await eligibility()).toContain("binding_changed");
  });
  it("Task4: current owner loss really turns policy OFF and leaves durable convergence work", async () => {
    await qualifiedCheckpoint();
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
    expect(await eligibility()).toContain("operating_policy_required");
    expect(await prisma.bioSensorSitePolicy.findUnique({ where: { siteId } })).toMatchObject({ enabled: false });
    expect((await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "BioSensorConvergenceWork" WHERE "gatewayId"=${gatewayId} AND "completedAt" IS NULL AND "retiredAt" IS NULL`)[0].count).toBeGreaterThan(0n);
  });
  async function enabledRule() {
    const checkpoint = await qualifiedCheckpoint();
    const node = await prisma.meshNode.create({ data: { gatewayId, deviceUuid: `bio:${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      meshAddress: "0x0002", firmwareVersion: "synthetic" } });
    const target = await prisma.fixture.create({ data: { floorId: checkpoint.fixture.floorId, meshNodeId: node.id, name: "target", ratedWatt: 20, x: 1, y: 1 } });
    const rules = new VehicleEventRulesService(prisma as never, new SiteAccessService(prisma as never), new TargetSnapshotService(), checkpoint.snapshots);
    const rule = await rules.create(siteId, actor, { name: "pulse", status: "enabled", sourceFixtureIds: [fixtureId], targetFixtureIds: [target.id],
      action: { dimmingEnabled: true, brightnessPercent: 75 }, holdSeconds: 10 });
    return { ...checkpoint, rules, rule };
  }
  it("Task4: valid current source enables through HTTP service and direct DB guard, fresh ready refresh preserves snapshot hash", async () => {
    const h = await enabledRule(); expect(h.rule.status).toBe("enabled");
    const before = await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId } });
    expect((await h.capability.applyBioDelivery({ schemaVersion: 2, assignmentVersion: 1,
      report: { ...h.live, eventId: randomUUID(), capabilityRevision: 2, verifiedAt: new Date().toISOString() } }, { siteId, gatewayId, requireActiveClaim: true })).status).toBe("applied");
    expect(await prisma.gatewayAutomationConfiguration.findUnique({ where: { gatewayId } })).toEqual(before);
    const view = (await loadBioSensorEligibility(prisma as never, [fixtureId])).get(fixtureId)!;
    expect(view).toMatchObject({ preparationCandidate: true, status: "ready", blockedReasons: [] });
    expect(JSON.stringify(view)).not.toMatch(/bodyHexes|deviceUuid|deviceIdentityHash|meshAddress/);
  });
  it("Task4: revoked profile disables rule and policy/prepare rollback is atomic", async () => {
    const h = await enabledRule(); await profiles.revoke(operator, h.profile.profileId);
    expect(await eligibility()).toContain("profile_unverified");
    expect(await prisma.vehicleEventRule.findUnique({ where: { id: h.rule.id } })).toMatchObject({ status: "disabled" });
    const before = await prisma.bioSensorCatalogState.findUniqueOrThrow({ where: { id: 1 } });
    await expect(prisma.$transaction(async tx => {
      await tx.bioSensorCatalogState.update({ where: { id: 1 }, data: { revision: { increment: 1 } } }); throw new Error("partial rollback");
    })).rejects.toThrow("partial rollback");
    expect(await prisma.bioSensorCatalogState.findUnique({ where: { id: 1 } })).toEqual(before);
    await expect(h.rules.update(siteId, h.rule.id, actor, { status: "disabled", name: "retained" })).resolves.toMatchObject({ status: "disabled" });
    await expect(prisma.vehicleEventRule.update({ where: { id: h.rule.id }, data: { status: "enabled" } })).rejects.toThrow();
  });
  it("Task4: enabled source direct DB updates cannot erase nullable live commission metadata", async () => {
    const h = await enabledRule();
    for (const field of ["bioPulseSensorModeVerifiedAt", "bioPulseProfileId", "bioPulseVerifiedAt"] as const) {
      await expect(prisma.meshNode.update({ where: { id: h.fixture.meshNodeId! }, data: { [field]: null } })).rejects.toThrow();
    }
    expect(await eligibility()).toEqual([]);
  });
  it("Task4: external invalidation blocks old snapshot resync until durable current work settles; same V2 support keeps revision", async () => {
    const h = await enabledRule();
    const consumer = new AutomationMqttConsumerService(prisma as never, h.capability, h.clock, h.snapshots);
    const request = { schemaVersion: 2, siteId, gatewayId, requestId: randomUUID(), assignmentVersion: 1,
      declarationRevision: 2, maxSnapshotVersion: 2, requestedAt: new Date().toISOString() };
    const before = await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId } });
    await consumer.onCurrentConfigRequest({ siteId, gatewayId }, request);
    expect(await prisma.gatewayAutomationConfiguration.findUnique({ where: { gatewayId } })).toEqual(before);
    const outbox = await prisma.mqttOutbox.findFirstOrThrow({ where: { gatewayId, revision: before.desiredRevision, applicationAckKey: null } });
    await prisma.mqttOutbox.update({ where: { id: outbox.id }, data: { publishedAt: new Date() } });
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
    await consumer.onCurrentConfigRequest({ siteId, gatewayId }, request);
    expect((await prisma.mqttOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).publishedAt).not.toBeNull();
    await worker.processBatch();
    const after = await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId } });
    expect(after.desiredRevision).toBeGreaterThan(before.desiredRevision);
    const current = await prisma.mqttOutbox.findFirstOrThrow({ where: { gatewayId, revision: after.desiredRevision, applicationAckKey: null } });
    expect((current.payload as any).vehicleEventRules[0].status).toBe("disabled");
  });
  it("Task4: accepted checkpoint outlives initial command TTL only with a fresh independent live observation", async () => {
    const h = await qualifiedCheckpoint(); const at = new Date(Date.now()+130_000);
    jest.spyOn(h.clock, "now").mockReturnValue(at);
    expect((await h.capability.applyBioDelivery({ schemaVersion: 2, assignmentVersion: 1, report: {
      ...h.live, eventId: randomUUID(), capabilityRevision: 2, verifiedAt: at.toISOString()
    } }, { siteId, gatewayId, requireActiveClaim: true })).status).toBe("applied");
    expect(await eligibility(at)).toEqual([]);
  });
  async function legacyPreparation() {
    const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId }, include: { meshNode: true } });
    await prisma.meshNode.update({ where: { id: fixture.meshNodeId! }, data: { vehicleSensorProtocol: "bluez_stateful" } });
    const session = await prisma.provisioningSession.create({ data: { siteId, gatewayId, floorId: fixture.floorId, requestedBy: actor.id } });
    await prisma.discoveredMeshNode.create({ data: { id: fixtureId, sessionId: session.id, deviceUuid: fixture.meshNode!.deviceUuid!,
      meshAddress: fixture.meshNode!.meshAddress, status: "provisioned", identifyState: "confirmed", serialNumber: "synthetic",
      firmwareVersion: "synthetic", rssi: -50, oobCapability: "none" } });
    const commandId = randomUUID();
    await prisma.provisioningDeviceOutbox.create({ data: { id: commandId, sessionId: session.id, nodeId: fixtureId,
      topic: `sites/${siteId}/gateways/${gatewayId}/commands/provisioning/provision-device`, payload: { commandId, siteId, gatewayId,
        sessionId: session.id, nodeId: fixtureId, deviceUuid: fixture.meshNode!.deviceUuid, meshAddress: fixture.meshNode!.meshAddress, requestedAt: new Date().toISOString() } } });
    const db = prisma as never; const access = new SiteAccessService(db);
    const classifier = new BioClassificationReconciliationService(db, access, new AuditService(db), new AutomationClock());
    return { fixture, create: (serviceProfiles: any = profiles) => new BioSensorPreparationService(db, access, serviceProfiles, classifier).create(actor, request()) };
  }
  it("Task4: common legacy candidate uses exact classifier proof atomically; preparation failure rolls classification/audit back", async () => {
    const h = await legacyPreparation();
    expect((await loadBioSensorEligibility(prisma as never, [fixtureId])).get(fixtureId)).toMatchObject({ preparationCandidate: true, status: "unverified" });
    const broken = Object.create(profiles); broken.catalogInTransaction = async () => { throw new Error("catalog unavailable"); };
    await expect(h.create(broken)).rejects.toThrow("catalog unavailable");
    expect(await prisma.meshNode.findUnique({ where: { id: h.fixture.meshNodeId! } })).toMatchObject({ vehicleSensorProtocol: "bluez_stateful" });
    expect(await prisma.auditLog.count({ where: { siteId, action: "bio_classification_reconciled" } })).toBe(0);
    expect((await h.create()).status).toBe("pending");
    expect(await prisma.meshNode.findUnique({ where: { id: h.fixture.meshNodeId! } })).toMatchObject({ vehicleSensorProtocol: "bio_usb_pulse" });
    expect(await prisma.auditLog.count({ where: { siteId, action: "bio_classification_reconciled" } })).toBe(1);
    expect(await prisma.fixture.findUnique({ where: { id: fixtureId } })).toMatchObject({ brightness: 42 });
  });
  it("Task4: ambiguous profiles and renewed preparation cannot reuse older ready live evidence", async () => {
    const h = await qualifiedCheckpoint();
    const newer = await preparation.create(actor, request());
    const value = await report(newer.commandId); value.observedAt = new Date(Date.now()+10).toISOString();
    expect((await ingest(value)).status).toBe("applied");
    expect(await eligibility()).toContain("link_unverified");
    const priorPredicate = await prisma.$queryRaw<Array<{ reasons: string[] }>>`SELECT bio_sensor_base_blocked_reasons(${fixtureId},
      (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),'ready',${h.live.verifiedFingerprintId},(${value.observedAt}::timestamptz AT TIME ZONE 'UTC'),2::bigint) AS reasons`;
    // Concrete review counterexample: the old six-field predicate authorizes a
    // fresh old-commission GET. The current authority below must reject it.
    expect(priorPredicate[0].reasons).toEqual([]);
    const oldCommission = await h.capability.applyBioDelivery({ schemaVersion: 2, assignmentVersion: 1, report: {
      ...h.live, eventId: randomUUID(), capabilityRevision: 2, verifiedAt: value.observedAt
    } }, { siteId, gatewayId, requireActiveClaim: true });
    expect(oldCommission.status).toBe("rejected");
    expect(await eligibility()).toContain("mode_unverified");
    expect((await h.capability.applyBioDelivery({ schemaVersion: 2, assignmentVersion: 1, report: {
      ...h.live, eventId: randomUUID(), capabilityRevision: 3, sensorModeVerifiedAt: value.observedAt, verifiedAt: value.observedAt
    } }, { siteId, gatewayId, requireActiveClaim: true })).status).toBe("applied");
    await profiles.createRevision(operator, { ...h.profile, profileId: randomUUID() });
    const ambiguous = await preparation.create(actor, request());
    expect((await ingest(await report(ambiguous.commandId))).status).toBe("rejected");
    expect(await eligibility()).toEqual(expect.arrayContaining(["profile_unverified", "fingerprint_unverified"]));
  });
  it("Task4: natural live expiry disables durably without deleting checkpoint or changing policy catalog", async () => {
    const h = await enabledRule();
    // A DB-owned clock-free fixture: shorten the current profile policy through
    // a separate accepted snapshot of time is not needed. Advance only this
    // worker's timestamp parameter via a mocked JS Date for the expiry sweep.
    const actual = new Date(); const at = new Date(actual.getTime()+6_000);
    jest.useFakeTimers({ now: at, doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout"] });
    const revision = (await prisma.bioSensorCatalogState.findUniqueOrThrow({ where: { id: 1 } })).revision;
    try { await profiles.sweepUnavailableRules(); } finally { jest.useRealTimers(); }
    expect(await prisma.vehicleEventRule.findUnique({ where: { id: h.rule.id } })).toMatchObject({ status: "disabled" });
    expect((await prisma.bioSensorCatalogState.findUniqueOrThrow({ where: { id: 1 } })).revision).toBe(revision);
    const work = await prisma.bioSensorConvergenceWork.findUniqueOrThrow({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: { siteId, gatewayId, assignmentVersion: 1, catalogRevision: revision } } });
    expect(work.completedAt).toBeNull(); expect(work.retiredAt).toBeNull();
    expect(await prisma.bioSensorPreparationOperation.findUnique({ where: { commandId: h.created.commandId } })).toMatchObject({ resultHash: expect.any(String), supersededAt: null });
    // Re-created service models a restart: no memory-only queue is required.
    await prisma.bioSensorConvergenceWork.updateMany({ where: { gatewayId, catalogRevision: revision }, data: { nextAttemptAt: new Date() } });
    const restarted = new BioSensorProfilesService(prisma as never, new SiteAccessService(prisma as never));
    await restarted.processConvergenceWork({ siteId, gatewayId, assignmentVersion: 1, catalogRevision: revision });
    expect((await prisma.bioSensorConvergenceWork.findUniqueOrThrow({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: { siteId, gatewayId, assignmentVersion: 1, catalogRevision: revision } } })).completedAt).not.toBeNull();
  });
  it("Task4: mode commission compares normalized millisecond instants, not timestamp text", async () => {
    const h = await qualifiedCheckpoint(); const command = await preparation.create(actor, request());
    const value = await report(command.commandId); const instant = new Date(Date.now()+10).toISOString();
    value.observedAt = instant.replace("Z","000Z"); expect((await ingest(value)).status).toBe("applied");
    expect((await h.capability.applyBioDelivery({ schemaVersion: 2, assignmentVersion: 1, report: {
      ...h.live, eventId: randomUUID(), capabilityRevision: 2, sensorModeVerifiedAt: instant, verifiedAt: instant
    } }, { siteId, gatewayId, requireActiveClaim: true })).status).toBe("applied");
    expect(await eligibility()).toEqual([]);
  });
  it("Task4: another site's policy change invalidates all global catalog checkpoints and disables affected rules", async () => {
    const h = await enabledRule(); const otherUser = await prisma.user.create({ data: { organizationId: actor.organizationId,
      loginId: randomUUID(), name: "other", role: "admin", passwordHash: "unused" } });
    const otherSite = await prisma.site.create({ data: { organizationId: actor.organizationId, adminUserId: otherUser.id, name: "other" } });
    await profiles.setSitePolicy({ ...otherUser, organizationType: "customer" }, otherSite.id,
      { enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null });
    expect(await eligibility()).toContain("binding_changed");
    expect(await prisma.vehicleEventRule.findUnique({ where: { id: h.rule.id } })).toMatchObject({ status: "disabled" });
    expect(await prisma.bioSensorPreparationOperation.findUnique({ where: { commandId: h.created.commandId } }))
      .toMatchObject({ supersededAt: expect.any(Date), resultHash: expect.any(String) });
  });
  it("Task4: legacy auto-classification refuses nondefault retained commission metadata", async () => {
    const h = await legacyPreparation();
    await prisma.meshNode.update({ where: { id: h.fixture.meshNodeId! }, data: { bioPulseSensorModeVerifiedAt: new Date() } });
    await expect(h.create()).rejects.toThrow("nondefault qualification");
    expect(await prisma.auditLog.count({ where: { siteId, action: "bio_classification_reconciled" } })).toBe(0);
    expect(await prisma.meshNode.findUnique({ where: { id: h.fixture.meshNodeId! } })).toMatchObject({ vehicleSensorProtocol: "bluez_stateful" });
  });
  it("starts empty and OFF; query is allowed on registered BIO without prior readiness and preserves brightness/history", async () => {
    const catalog = await profiles.buildCurrentCatalog(siteId, gatewayId);
    expect(catalog.profiles.filter((profile: any) => JSON.stringify(profile.fingerprint)===JSON.stringify(fingerprint))).toEqual([]); expect(catalog.executionPolicy.enabled).toBe(false);
    const operation = await preparation.create(actor, request());
    expect(operation.status).toBe("pending");
    await worker.processBatch();
    expect(delivered.some(value => value.topic === bioSensorPreparationTopics.command(siteId, gatewayId))).toBe(false);
    const catalogDelivery = await (prisma as any).bioSensorCatalogDelivery.findFirstOrThrow({ where: { siteId, gatewayId, supersededAt: null } });
    await profiles.ingestCatalogAck({ schemaVersion: 1, siteId, gatewayId, assignmentVersion: 1, eventId: catalogDelivery.deliveryId,
      catalogRevision: Number(catalogDelivery.catalogRevision), deliveryPayloadHash: catalogDelivery.payloadHash, status: "applied", occurredAt: new Date().toISOString() }, { siteId, gatewayId });
    await worker.processBatch();
    const sent = delivered.find(value => value.topic === bioSensorPreparationTopics.command(siteId, gatewayId));
    expect(sent?.payload.operation).toBe("query");
    expect(sent?.payload).not.toHaveProperty("brightness");
    expect(await prisma.fixture.findUnique({ where: { id: fixtureId } })).toMatchObject({ id: fixtureId, brightness: 42 });
    expect(await prisma.sensorModeOperation.count({ where: { fixtureId } })).toBe(0);
    expect(await prisma.command.count()).toBe(0);
    expect(JSON.stringify(operation)).not.toMatch(/deviceIdentityHash|meshAddress|bodyHexes|deviceUuid/);
  });
  async function acceptCatalog() {
    const catalog = await profiles.buildCurrentCatalog(siteId, gatewayId);
    const row = await prisma.bioSensorCatalogDelivery.findUniqueOrThrow({ where: { deliveryId: catalog.eventId } });
    await profiles.ingestCatalogAck({ schemaVersion: 1, siteId, gatewayId, assignmentVersion: catalog.assignmentVersion, eventId: row.deliveryId,
      catalogRevision: catalog.catalogRevision, deliveryPayloadHash: row.payloadHash, status: "applied", occurredAt: new Date().toISOString() }, { siteId, gatewayId });
  }
  it("first ready result reauthorizes saved actor after dispatch and admin removal", async () => {
    await profiles.createRevision(operator, profileInput());
    const created = await preparation.create(actor, request()); await acceptCatalog(); await worker.processBatch();
    expect(delivered.some(value => value.payload.commandId === created.commandId && value.topic === bioSensorPreparationTopics.command(siteId, gatewayId))).toBe(true);
    const value = await report(created.commandId);
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
    const ack = await ingest(value);
    expect(ack.status).toBe("rejected");
    const stored = await prisma.bioSensorPreparationOperation.findUniqueOrThrow({ where: { commandId: created.commandId } });
    expect(stored.status).toBe("unverified"); expect(stored.result).toEqual(value);
    expect(stored.ackPayload).toEqual(ack); expect(await ingest(value)).toEqual(ack);
  });
  it("catalog queue progresses past ten deleted scopes while retrying current expired certificate", async () => {
    const catalog = await profiles.buildCurrentCatalog(siteId, gatewayId);
    const valid = await prisma.bioSensorCatalogDelivery.findUniqueOrThrow({ where: { deliveryId: catalog.eventId } });
    await prisma.bioSensorCatalogDelivery.update({ where: { deliveryId: valid.deliveryId }, data: { nextAttemptAt: new Date("2002-01-01") } });
    const obsoleteIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      const payload = { ...catalog, eventId: randomUUID(), gatewayId: randomUUID() };
      obsoleteIds.push(payload.eventId);
      await prisma.bioSensorCatalogDelivery.create({ data: { deliveryId: payload.eventId, siteId, gatewayId: payload.gatewayId,
        assignmentVersion: 1, catalogRevision: BigInt(payload.catalogRevision), payload, payloadHash: canonicalPayloadHash(payload), nextAttemptAt: new Date("2000-01-01") } });
    }
    const leasedIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      const payload = { ...catalog, eventId: randomUUID(), gatewayId: randomUUID() }; leasedIds.push(payload.eventId);
      await prisma.bioSensorCatalogDelivery.create({ data: { deliveryId: payload.eventId, siteId, gatewayId: payload.gatewayId,
        assignmentVersion: 1, catalogRevision: BigInt(payload.catalogRevision), payload, payloadHash: canonicalPayloadHash(payload),
        nextAttemptAt: new Date("1999-01-01"), lockedBy: "another-worker", leaseExpiresAt: new Date(Date.now() + 300_000) } });
    }
    const serial = randomUUID(); const retryGateway = await prisma.gateway.create({ data: { siteId, name: serial, serialNumber: serial, firmwareVersion: "synthetic", assignmentVersion: 1, claimedAt: new Date() } });
    const inventory = await prisma.gatewayInventory.create({ data: { serialNumber: serial, claimedGatewayId: retryGateway.id, claimedAt: new Date() } });
    const certificate = await prisma.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId: retryGateway.id, purpose: "mqtt", status: "active", certificateSerial: serial,
      fingerprint: serial, issuer: "synthetic", notBefore: new Date(Date.now() - 10_000), notAfter: new Date(Date.now() + 300_000) } });
    const retryCatalog = await profiles.buildCurrentCatalog(siteId, retryGateway.id);
    await prisma.bioSensorCatalogDelivery.update({ where: { deliveryId: retryCatalog.eventId }, data: { nextAttemptAt: new Date("2001-01-01") } });
    await prisma.gatewayCertificate.update({ where: { id: certificate.id }, data: { notAfter: new Date(Date.now() - 1_000) } });
    // Authority mutation now invalidates the global catalog. Process a bounded
    // backlog of old revisions as well as the ten synthetic obsolete scopes.
    for (let attempt=0; attempt<5; attempt++) await worker.processBatch();
    expect(delivered.some(value => value.topic === bioSensorCatalogTopics.command(siteId, gatewayId))).toBe(true);
    expect(delivered.some(value => value.topic === bioSensorCatalogTopics.command(siteId, retryGateway.id))).toBe(false);
    expect(await prisma.bioSensorCatalogDelivery.count({ where: { deliveryId: { in: obsoleteIds }, supersededAt: { not: null } } })).toBe(10);
    expect(await prisma.bioSensorCatalogDelivery.count({ where: { deliveryId: { in: leasedIds }, lockedBy: "another-worker", supersededAt: null } })).toBe(10);
    const deferred = await prisma.bioSensorCatalogDelivery.findUniqueOrThrow({ where: { deliveryId: retryCatalog.eventId } });
    expect(deferred.status).toBe("pending"); expect(deferred.supersededAt).not.toBeNull();
    const currentRevision = (await prisma.bioSensorCatalogState.findUniqueOrThrow({ where: { id: 1 } })).revision;
    const retryWork = await prisma.bioSensorConvergenceWork.findUniqueOrThrow({ where: { siteId_gatewayId_assignmentVersion_catalogRevision: {
      siteId, gatewayId: retryGateway.id, assignmentVersion: 1, catalogRevision: currentRevision } } });
    expect(retryWork.completedAt).toBeNull(); expect(retryWork.retiredAt).toBeNull();
    await prisma.gatewayCertificate.update({ where: { id: certificate.id }, data: { notAfter: new Date(Date.now() + 300_000) } });
    await prisma.bioSensorCatalogDelivery.update({ where: { deliveryId: retryCatalog.eventId }, data: { nextAttemptAt: new Date("2001-01-01") } });
    for (let attempt=0; attempt<5; attempt++) await worker.processBatch();
    expect(delivered.some(value => value.topic===bioSensorCatalogTopics.command(siteId,retryGateway.id)
      && value.payload.catalogRevision>retryCatalog.catalogRevision)).toBe(true);
  });
  it("ACK queue progresses past ten old-assignment results and preserves their immutable receipt", async () => {
    await profiles.createRevision(operator, profileInput());
    const old = await preparation.create(actor, request()); await ingest(await report(old.commandId));
    const source = await prisma.bioSensorPreparationOperation.findUniqueOrThrow({ where: { commandId: old.commandId } });
    const obsoleteIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      const commandId = randomUUID(); const eventId = randomUUID(); const payload = { ...(source.payload as any), commandId };
      const result = { ...(source.result as any), commandId, eventId, commandPayloadHash: canonicalPayloadHash(payload) };
      const ackPayload = { ...(source.ackPayload as any), commandId, eventId, reportPayloadHash: canonicalPayloadHash(result) };
      obsoleteIds.push(commandId);
      await prisma.bioSensorPreparationOperation.create({ data: { ...source, commandId, clientRequestId: randomUUID(), payload, payloadHash: canonicalPayloadHash(payload),
        result, resultHash: canonicalPayloadHash(result), resultEventId: eventId, ackPayload, ackHash: canonicalPayloadHash(ackPayload), ackNextAttemptAt: new Date("2000-01-01") } });
    }
    await prisma.gateway.update({ where: { id: gatewayId }, data: { assignmentVersion: 2 } });
    const current = await preparation.create(actor, request()); await ingest(await report(current.commandId));
    await prisma.bioSensorPreparationOperation.update({ where: { commandId: current.commandId }, data: { ackNextAttemptAt: new Date("2001-01-01") } });
    const currentSource = await prisma.bioSensorPreparationOperation.findUniqueOrThrow({ where: { commandId: current.commandId } });
    const leasedIds: string[] = [];
    for (let index = 0; index < 10; index++) {
      const commandId = randomUUID(); const eventId = randomUUID(); const payload = { ...(currentSource.payload as any), commandId };
      const result = { ...(currentSource.result as any), commandId, eventId, commandPayloadHash: canonicalPayloadHash(payload) };
      const ackPayload = { ...(currentSource.ackPayload as any), commandId, eventId, reportPayloadHash: canonicalPayloadHash(result) };
      leasedIds.push(commandId);
      await prisma.bioSensorPreparationOperation.create({ data: { ...currentSource, commandId, clientRequestId: randomUUID(), payload, payloadHash: canonicalPayloadHash(payload),
        result, resultHash: canonicalPayloadHash(result), resultEventId: eventId, ackPayload, ackHash: canonicalPayloadHash(ackPayload),
        ackNextAttemptAt: new Date("1999-01-01"), ackLockedBy: "another-worker", ackLeaseExpiresAt: new Date(Date.now() + 300_000) } });
    }
    // Checkpoint supersession is not transport retirement: this current-scope
    // original receipt still needs delivery after another request is created.
    await preparation.create(actor, request());
    await worker.processBatch(); await worker.processBatch();
    expect(delivered.some(value => value.topic === bioSensorPreparationTopics.ack(siteId, gatewayId) && value.payload.commandId === current.commandId)).toBe(true);
    expect(delivered.some(value => obsoleteIds.includes(value.payload.commandId))).toBe(false);
    expect(delivered.some(value => leasedIds.includes(value.payload.commandId))).toBe(false);
    expect(await prisma.bioSensorPreparationOperation.count({ where: { commandId: { in: leasedIds }, ackLockedBy: "another-worker", ackRetiredAt: null, ackPublishedAt: null } })).toBe(10);
    const obsolete = await prisma.bioSensorPreparationOperation.findMany({ where: { commandId: { in: obsoleteIds } } });
    expect(obsolete.every((row: any) => row.ackRetiredAt instanceof Date && row.ackPublishedAt === null)).toBe(true);
    for (const row of obsolete) expect(row.ackHash).toBe(canonicalPayloadHash(row.ackPayload));
    const receipt = await prisma.bioSensorPreparationOperation.findUniqueOrThrow({ where: { commandId: current.commandId } });
    expect(receipt.supersededAt).toBeInstanceOf(Date); expect(receipt.ackRetiredAt).toBeNull();
    delivered = [];
    await prisma.bioSensorPreparationOperation.update({ where: { commandId: current.commandId }, data: { ackPublishedAt: null, ackNextAttemptAt: new Date("2000-01-01") } });
    await prisma.gatewayCertificate.updateMany({ where: { gatewayId }, data: { notAfter: new Date(Date.now() - 1_000) } });
    await worker.processBatch();
    expect(delivered.some(value => value.payload.commandId === current.commandId)).toBe(false);
    const retry = await prisma.bioSensorPreparationOperation.findUniqueOrThrow({ where: { commandId: current.commandId } });
    expect(retry.ackNextAttemptAt.getTime()).toBeGreaterThan(Date.parse("2000-01-01")); expect(retry.ackRetiredAt).toBeNull(); expect(retry.ackPublishedAt).toBeNull();
    expect(retry.ackPayload).toEqual(receipt.ackPayload); expect(retry.resultHash).toBe(receipt.resultHash);
    await prisma.gatewayCertificate.updateMany({ where: { gatewayId }, data: { notAfter: new Date(Date.now() + 300_000) } });
    await prisma.bioSensorPreparationOperation.update({ where: { commandId: current.commandId }, data: { ackNextAttemptAt: new Date("2000-01-01") } });
    await worker.processBatch();
    expect(delivered.some(value => value.payload.commandId === current.commandId && value.topic === bioSensorPreparationTopics.ack(siteId, gatewayId))).toBe(true);
  });
  it("separates provider profile permissions and assigned admin policy/preparation, rechecking persisted disabled roles", async () => {
    await expect(profiles.createRevision(actor, profileInput())).rejects.toThrow();
    await expect(profiles.setSitePolicy(operator, siteId, { enabled: false })).rejects.toThrow();
    await prisma.user.update({ where: { id: operator.id }, data: { status: "disabled" } });
    await expect(profiles.createRevision(operator, profileInput())).rejects.toThrow();
    // The existing DB guard forbids disabling an assigned administrator. Model
    // the real removal flow before exercising a stale authenticated principal.
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
    await prisma.user.update({ where: { id: actor.id }, data: { status: "disabled" } });
    await expect(preparation.create(actor, request())).rejects.toThrow();
  });
  it("accepts an explicit owner policy only for the current site administrator and appends a catalog version", async () => {
    await expect(profiles.setSitePolicy(actor, siteId, { enabled: true })).rejects.toThrow();
    await expect(profiles.setSitePolicy(actor, siteId, { enabled: true, ownerUserId: operator.id, maximumResponseSeconds: 30, escalationAction: "contact-owner" })).rejects.toThrow();
    const policy = await profiles.setSitePolicy(actor, siteId, { enabled: true, ownerUserId: actor.id, maximumResponseSeconds: 30, escalationAction: "contact-owner" });
    expect(policy).toMatchObject({ enabled: true, ownerUserId: actor.id, maximumResponseSeconds: 30 });
    expect(await profiles.getSitePolicy(actor, siteId)).toEqual(policy);
    expect((await profiles.buildCurrentCatalog(siteId, gatewayId)).executionPolicy.enabled).toBe(true);
  });
  it("DB policy coherence rejects enabled state with NULL response/action metadata", async () => {
    await expect((prisma as any).bioSensorSitePolicy.create({ data: { siteId, enabled: true, ownerUserId: actor.id, revision: 1n } })).rejects.toThrow();
  });
  it("will not dispatch a pending preparation after the assigned administrator is removed", async () => {
    const created = await preparation.create(actor, request());
    const row = await (prisma as any).bioSensorCatalogDelivery.findFirstOrThrow({ where: { siteId, gatewayId, supersededAt: null } });
    await profiles.ingestCatalogAck({ schemaVersion: 1, siteId, gatewayId, assignmentVersion: 1, eventId: row.deliveryId,
      catalogRevision: Number(row.catalogRevision), deliveryPayloadHash: row.payloadHash, status: "applied", occurredAt: new Date().toISOString() }, { siteId, gatewayId });
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
    await worker.processBatch();
    expect(delivered.some(value => value.payload.commandId === created.commandId)).toBe(false);
  });
  it("keeps immutable sequential profile revisions and exact catalog ACK attribution on its dedicated delivery", async () => {
    const profile = profileInput(); await profiles.createRevision(operator, profile);
    await expect(profiles.createRevision(operator, { ...profile, bodyHexes: ["ffffffffffffffff"] })).rejects.toThrow();
    await worker.processBatch();
    const row = await (prisma as any).bioSensorCatalogDelivery.findFirstOrThrow({ where: { siteId, gatewayId, supersededAt: null } });
    const ack = { schemaVersion: 1, siteId, gatewayId, assignmentVersion: 1, eventId: row.deliveryId, catalogRevision: Number(row.catalogRevision),
      deliveryPayloadHash: row.payloadHash, status: "applied", occurredAt: new Date().toISOString() };
    await expect(profiles.ingestCatalogAck({ ...ack, deliveryPayloadHash: `sha256:${"f".repeat(64)}` }, { siteId, gatewayId })).rejects.toThrow();
    await profiles.ingestCatalogAck(ack, { siteId, gatewayId });
    expect(await (prisma as any).bioSensorCatalogDelivery.findUnique({ where: { deliveryId: row.deliveryId } })).toMatchObject({ status: "applied", appliedAt: expect.any(Date) });
    expect(await prisma.mqttOutbox.count({ where: { topic: bioSensorCatalogTopics.command(siteId, gatewayId) } })).toBe(0);
  });
  it("stores immutable ready plus durable exact result ACK; replay is idempotent, conflict and scope/hash mismatch rejected", async () => {
    await profiles.createRevision(operator, profileInput()); const created = await preparation.create(actor, request("ensure_sensor"));
    const value = await report(created.commandId); const ack = await ingest(value);
    expect(ack.status).toBe("applied"); expect(await ingest(value)).toEqual(ack);
    await expect(ingest({ ...value, eventId: randomUUID(), status: "failed", errorCode: "FAILED" })).rejects.toThrow();
    await expect(ingest({ ...value, commandPayloadHash: `sha256:${"f".repeat(64)}` })).rejects.toThrow();
    await expect(preparation.ingestAuthenticated(value, { siteId: randomUUID(), gatewayId, requireActiveClaim: true })).rejects.toThrow();
    const row = await (prisma as any).bioSensorPreparationOperation.findUniqueOrThrow({ where: { commandId: created.commandId } });
    expect(row.result).toEqual(value); expect(row.ackPayload).toEqual(ack);
    await expect((prisma as any).bioSensorPreparationOperation.update({ where: { commandId: created.commandId }, data: { result: { ...value, status: "failed" } } })).rejects.toThrow();
    await worker.processBatch(); expect(delivered.some(value => value.topic === bioSensorPreparationTopics.ack(siteId, gatewayId))).toBe(true);
    expect(await preparation.get(actor, created.commandId)).toMatchObject({ status: "ready", modeVerified: true, linkVerified: true });
    const next = await preparation.create(actor, request()); await ingest(await report(next.commandId, { status: "failed", modeVerified: false, linkVerified: false, profileKey: null, fingerprint: null, errorCode: "FAILED" }));
    expect(await preparation.get(actor, created.commandId)).toMatchObject({ status: "unverified", modeVerified: false });
    expect(await preparation.get(actor, next.commandId)).toMatchObject({ status: "failed" });
  });
  it.each(["catalog", "expired", "reassigned", "revoked", "certificate", "binding", "mode-only", "empty"])("cannot promote stale or incomplete %s evidence", async change => {
    const profile = profileInput(); if (change !== "empty") await profiles.createRevision(operator, profile);
    const created = await preparation.create(actor, request()); const value = await report(created.commandId);
    if (change === "catalog") await profiles.createRevision(operator, profileInput());
    if (change === "expired") await (prisma as any).bioSensorPreparationOperation.update({ where: { commandId: created.commandId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    if (change === "reassigned") await prisma.gateway.update({ where: { id: gatewayId }, data: { assignmentVersion: 2 } });
    if (change === "revoked") await profiles.revoke(operator, profile.profileId);
    if (change === "certificate") await prisma.gatewayCertificate.updateMany({ where: { gatewayId }, data: { notAfter: new Date(Date.now() - 1000) } });
    if (change === "binding") await prisma.meshNode.updateMany({ where: { gatewayId }, data: { meshAddress: "0x0002" } });
    if (change === "mode-only") value.linkVerified = false;
    if (change === "empty") value.profileKey = `${profile.profileId}@1`;
    if (["reassigned", "certificate", "mode-only"].includes(change)) await expect(ingest(value)).rejects.toThrow();
    else expect((await ingest(value)).status).not.toBe("applied");
    expect((await preparation.get(actor, created.commandId)).status).not.toBe("ready");
  });
  it("upgrades pre-existing registered identity, brightness and command/energy history without inventing approved profiles", async () => {
    const url = cluster.database(); const before = cluster.deploy(url, "20261008025999");
    expect(before.status).toBe(0);
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      const id = randomUUID(); const org = await client.organization.create({ data: { name: id, type: "customer" } });
      const site = await client.site.create({ data: { organizationId: org.id, name: id } });
      const floor = await client.floor.create({ data: { siteId: site.id, name: "B1", level: -1 } });
      const gateway = await client.gateway.create({ data: { siteId: site.id, name: id, serialNumber: id, firmwareVersion: "old" } });
      const node = await client.meshNode.create({ data: { gatewayId: gateway.id, meshAddress: "0x0001", firmwareVersion: "old", deviceUuid: "bio:112233445566", vehicleSensorProtocol: "bio_usb_pulse" },
        select: { id: true, gatewayId: true, meshAddress: true, firmwareVersion: true, deviceUuid: true, vehicleSensorProtocol: true } });
      const fixture = await client.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "legacy", ratedWatt: 20, x: 0, y: 0, brightness: 42 } });
      const command = await client.command.create({ data: { siteId: site.id, clientRequestId: randomUUID(),
        requestFingerprint: `sha256:${"a".repeat(64)}`, targetType: "fixture", targetId: fixture.id, targetFixtureIds: [fixture.id], brightness: 42, status: "acknowledged" } });
      const energy = await client.energyUsage.create({ data: { fixtureId: fixture.id, source: "synthetic-upgrade", period: "2026-10", kwh: 1, cost: 2 } });
      const upgraded = cluster.deploy(url); expect(upgraded.status).toBe(0);
      expect(await client.meshNode.findUnique({ where: { id: node.id } })).toMatchObject({ ...node, bioPulseSensorModeVerifiedAt: null });
      expect(await client.fixture.findUnique({ where: { id: fixture.id } })).toEqual(fixture);
      expect(await client.command.findUnique({ where: { id: command.id } })).toEqual(command);
      expect(await client.energyUsage.findUnique({ where: { id: energy.id } })).toEqual(energy);
      expect(await (client as any).bioSensorProfileRevision.count()).toBe(0);
      expect(await (client as any).bioSensorSitePolicy.count()).toBe(0);
    } finally { await client.$disconnect(); }
  }, 60_000);
});
