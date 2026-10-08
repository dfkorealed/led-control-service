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
    const profile = catalog.profiles.find((value: any) => value.status === "approved");
    return { ...identity, eventId: randomUUID(), commandPayloadHash: row.payloadHash, fingerprint,
      profileKey: profile ? `${profile.profileId}@${profile.revision}` : null, connectionGeneration: 1,
      observedAt: new Date().toISOString(), status: "ready", modeVerified: true, linkVerified: true, errorCode: null, ...changes };
  }
  const ingest = (value: any) => preparation.ingestAuthenticated(value, { siteId, gatewayId, requireActiveClaim: true });
  it("starts empty and OFF; query is allowed on registered BIO without prior readiness and preserves brightness/history", async () => {
    const catalog = await profiles.buildCurrentCatalog(siteId, gatewayId);
    expect(catalog.profiles).toEqual([]); expect(catalog.executionPolicy.enabled).toBe(false);
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
      const node = await client.meshNode.create({ data: { gatewayId: gateway.id, meshAddress: "0x0001", firmwareVersion: "old", deviceUuid: "bio:112233445566", vehicleSensorProtocol: "bio_usb_pulse" } });
      const fixture = await client.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "legacy", ratedWatt: 20, x: 0, y: 0, brightness: 42 } });
      const command = await client.command.create({ data: { siteId: site.id, clientRequestId: randomUUID(),
        requestFingerprint: `sha256:${"a".repeat(64)}`, targetType: "fixture", targetId: fixture.id, targetFixtureIds: [fixture.id], brightness: 42, status: "acknowledged" } });
      const energy = await client.energyUsage.create({ data: { fixtureId: fixture.id, source: "synthetic-upgrade", period: "2026-10", kwh: 1, cost: 2 } });
      const upgraded = cluster.deploy(url); expect(upgraded.status).toBe(0);
      expect(await client.meshNode.findUnique({ where: { id: node.id } })).toEqual(node);
      expect(await client.fixture.findUnique({ where: { id: fixture.id } })).toEqual(fixture);
      expect(await client.command.findUnique({ where: { id: command.id } })).toEqual(command);
      expect(await client.energyUsage.findUnique({ where: { id: energy.id } })).toEqual(energy);
      expect(await (client as any).bioSensorProfileRevision.count()).toBe(0);
      expect(await (client as any).bioSensorSitePolicy.count()).toBe(0);
    } finally { await client.$disconnect(); }
  }, 60_000);
});
