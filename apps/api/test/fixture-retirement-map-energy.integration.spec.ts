import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { disposablePostgres } from "./support/disposable-postgres";
import { SiteAccessService } from "../src/access/site-access.service";
import { AuditService } from "../src/audit/audit.service";
import type { AuthenticatedUser } from "../src/auth/auth.types";
import { canonicalPayloadHash as hash } from "../src/automation/automation-payload-hash";
import { FixtureRegistrationRetirementService } from "../src/fixtures/fixture-registration-retirement.service";
import { EnergyDimensionHistoryService } from "../src/energy/energy-dimension-history.service";
import { FixtureEnergyCheckpointService, FixtureStateIngestionService } from "../src/energy/fixture-state-ingestion.service";
import { EnergyAnalyticsQueryService } from "../src/energy/energy-analytics-query.service";
import { MapDocumentStore } from "../src/floor-editor/map-document-store";
import { MapDocumentResetService } from "../src/floor-editor/map-document-reset.service";
import { hashEditorLeaseToken } from "../src/floor-editor/editor-lease-token";
import { buildMapDocumentSnapshot, hashFloorEditorSnapshot } from "../src/floor-editor/floor-editor-snapshot";
import { FloorImportService } from "../src/floor-import/floor-import.service";

// Opt-in creates its own cluster and database, never an ambient DATABASE_URL.
const enabled = process.env.FIXTURE_RETIREMENT_MAP_ENERGY_DISPOSABLE_POSTGRES === "1";
(enabled ? describe : describe.skip)("retired registration map/energy consumers on own PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  let db: PrismaClient;
  let access: SiteAccessService;
  let audit: AuditService;
  let store: MapDocumentStore;
  let reset: MapDocumentResetService;
  const objects = new Map<string, Buffer>();
  // Only the external object transport is replaced. Generation validation,
  // publication, revision pinning, authorization and DB guards remain real.
  const storage = {
    putCadSceneObjectFile: async (key: string, path: string) => { objects.set(key, await readFile(path)); },
    verifyCadSceneObject: async (key: string) => { if (!objects.has(key)) throw new Error("missing object"); },
    downloadFloorAssetToFile: async (key: string, path: string) => {
      const bytes = objects.get(key); if (!bytes) throw new Error("missing object");
      await writeFile(path, bytes, { flag: "wx" });
    },
    readFloorRenderedMetadata: async () => ({ width: 640, height: 480 })
  };

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(`${deployed.stdout}\n${deployed.stderr}`);
    console.info("OWN_PG", new URL(url).port, "migrations", cluster.sql(url,
      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'));
    db = new PrismaClient({ datasourceUrl: url });
    access = new SiteAccessService(db as never);
    audit = new AuditService(db as never);
    store = new MapDocumentStore(db as never, storage as never);
    reset = new MapDocumentResetService(db as never, access, audit, store);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    cluster?.stop();
    console.info("OWN_PG_STOPPED_AND_REMOVED");
  });

  async function seed() {
    const org = await db.organization.create({ data: { name: "retirement consumers", type: "customer" } });
    const actor = await db.user.create({ data: { organizationId: org.id, loginId: randomUUID(),
      name: "admin", passwordHash: "unused", role: "admin" } });
    const user: AuthenticatedUser = { ...actor, role: "admin", status: "active", organizationType: "customer" };
    const site = await db.site.create({ data: { organizationId: org.id, adminUserId: actor.id,
      name: "retirement consumers", timeZone: "UTC", tariffKwhRate: 100 } });
    const floor = await db.floor.create({ data: { siteId: site.id, name: "F1", level: 1 } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, name: "BIO", serialNumber: randomUUID(),
      firmwareVersion: "test", assignmentVersion: 1, fixtureRegistrationRemovalVersion: 1,
      claimedAt: new Date(), lastHeartbeatAt: new Date() } });
    const deviceUuid = `bio:${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const node = await db.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid, meshAddress: "0x0100",
      firmwareVersion: "test", vehicleSensorProtocol: "bio_usb_pulse" } });
    const now = new Date();
    const old = await db.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "old registration",
      ratedWatt: 20, x: 12, y: 20, placementStatus: "placed", positionVerifiedAt: now,
      energyTrackingStartedAt: new Date(now.getTime() - 120_000) } });
    await db.$transaction(tx => new EnergyDimensionHistoryService().ensureFixtureDimensions(tx, [{
      fixtureId: old.id, siteId: site.id, floorId: floor.id, floorName: floor.name,
      name: old.name, ratedWatt: old.ratedWatt, trackingStartedAt: old.energyTrackingStartedAt
    }], now));
    await new FixtureStateIngestionService(db as never).ingest(gateway.id, {
      siteId: site.id, gatewayId: gateway.id, fixtureId: old.id, eventId: randomUUID(), sequence: 1,
      occurredAt: new Date(now.getTime() - 30_000).toISOString(), brightness: 100, powerOn: true,
      status: "online", statusReason: "reported", rssi: -55, hopCount: 1
    });
    const observed = await db.fixture.findUniqueOrThrow({ where: { id: old.id } });
    const operationId = randomUUID();
    const bindingSnapshot = { version: 1, siteId: site.id, fixtureId: old.id, gatewayId: gateway.id,
      gatewaySerial: gateway.serialNumber, assignmentVersion: 1, nodeId: old.id, deviceUuid,
      meshAddress: node.meshAddress!, originalProvisionCommandId: randomUUID() };
    const payload = { ...bindingSnapshot, operationId, bindingHash: hash(bindingSnapshot),
      requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30_000).toISOString() };
    const { version: _version, ...columns } = bindingSnapshot;
    const operation = await db.fixtureRegistrationRemovalOperation.create({ data: { ...columns, operationId,
      floorId: floor.id, meshNodeId: node.id, fixtureName: old.name, requestedById: actor.id,
      clientRequestId: randomUUID(), expectedUpdatedAt: observed.updatedAt, requestHash: hash({ fixtureId: old.id }),
      bindingSnapshot, bindingHash: payload.bindingHash, payload, commandHash: hash(payload), requestedAt: now,
      expiresAt: new Date(payload.expiresAt) } });
    const retiredAt = new Date();
    const terminal = { ...payload, commandHash: operation.commandHash, eventId: randomUUID(),
      occurredAt: retiredAt.toISOString(), status: "removed", errorCode: null };
    const { requestedAt: _requestedAt, expiresAt: _expiresAt, ...identity } = payload;
    const ack = { ...identity, commandHash: operation.commandHash, eventId: terminal.eventId,
      resultHash: hash(terminal), ingestedAt: retiredAt.toISOString(), status: "ingested" };
    await db.$transaction(async tx => {
      await tx.fixtureRegistrationRemovalResultEvidence.create({ data: { operationId, siteId: site.id,
        eventId: terminal.eventId, terminal, terminalHash: hash(terminal), applicationAck: ack,
        applicationAckHash: hash(ack), receivedAt: retiredAt } });
      await tx.fixtureRegistrationRemovalOperation.update({ where: { operationId }, data: {
        status: "gateway_confirmed", result: terminal, resultHash: hash(terminal), resultEventId: terminal.eventId,
        gatewayConfirmedAt: retiredAt, applicationAck: ack, applicationAckHash: hash(ack)
      } });
      await new FixtureRegistrationRetirementService(new FixtureEnergyCheckpointService(), new EnergyDimensionHistoryService())
        .retire(tx, operation, retiredAt);
      await tx.fixtureRegistrationRemovalOperation.update({ where: { operationId }, data: { status: "completed", completedAt: retiredAt } });
    });
    const retired = await db.fixture.findUniqueOrThrow({ where: { id: old.id } });
    // Editor authority is acquired only after removal has settled.
    await db.floor.update({ where: { id: floor.id }, data: { editorLeaseFence: 1,
      editorLeaseHolderId: actor.id, editorLeaseTokenHash: hashEditorLeaseToken("owned-lease"),
      editorLeaseExpiresAt: new Date(Date.now() + 600_000) } });
    const active = await db.fixture.create({ data: { floorId: floor.id, name: "active", ratedWatt: 40,
      x: 200, y: 300, placementStatus: "placed", positionVerifiedAt: now } });
    return { user, site, floor, gateway, deviceUuid, retired, retiredAt, active };
  }

  const authority = () => ({ requestId: randomUUID(), baseRevision: 0, leaseToken: "owned-lease", leaseFence: 1 });
  async function commonHead(context: Awaited<ReturnType<typeof seed>>) {
    async function* empty() { /* Persist an independent common head, not through the reset under test. */ }
    const ref = await store.prepareGeneration(context.floor.id, empty(), { width: 640, height: 600,
      gridSize: 10, groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }] });
    const snapshot = buildMapDocumentSnapshot({ document: ref, fixtures: [], lightSlots: [] });
    await db.$transaction(async tx => {
      await tx.floorPlan.create({ data: { floorId: context.floor.id, imageUrl: "", sourceType: "none", width: 640, height: 600, gridSize: 10 } });
      const revision = await tx.floorMapRevision.create({ data: { floorId: context.floor.id, revision: 1,
        snapshot: snapshot as Prisma.InputJsonValue, snapshotSha256: hashFloorEditorSnapshot(snapshot), changeSummary: {}, changedBy: context.user.id } });
      await store.pinRevision(tx, context.floor.id, revision.id, ref);
      await tx.floorMapDocument.create({ data: { floorId: context.floor.id, activeGenerationId: ref.generationId, revision: 1 } });
      await tx.floorMapGeneration.update({ where: { id: ref.generationId }, data: { status: "active" } });
      await tx.floor.update({ where: { id: context.floor.id }, data: { mapRevision: 1 } });
    });
  }
  async function assertProjection(context: Awaited<ReturnType<typeof seed>>, revision: number) {
    const { floor, retired, active } = context;
    expect(await db.fixture.findUniqueOrThrow({ where: { id: retired.id } })).toEqual(retired);
    const row = await db.floorMapRevision.findUniqueOrThrow({ where: { floorId_revision: { floorId: floor.id, revision } } });
    expect((row.snapshot as { fixtures: Array<{ id: string }> }).fixtures.map(fixture => fixture.id)).toEqual([active.id]);
  }

  it.each([false, true])("resets without changing retired history or retaining its overlay (common=%s)", async common => {
    const context = await seed();
    if (common) await commonHead(context);
    await reset.reset(context.floor.id, context.user, { ...authority(), baseRevision: common ? 1 : 0 });
    await assertProjection(context, common ? 2 : 1);
    expect(await db.fixture.findUniqueOrThrow({ where: { id: context.active.id } }))
      .toMatchObject({ x: 0, y: 0, placementStatus: "unplaced", positionVerifiedAt: null });
  });

  it.each(["elements_only", "elements_and_placement"] as const)("clears common maps in %s mode", async mode => {
    const context = await seed();
    await commonHead(context);
    await db.fixture.update({ where: { id: context.active.id }, data: { x: 42, y: 55, placementStatus: "placed" } });
    await reset.clear(context.floor.id, context.user, { ...authority(), baseRevision: 1, mode });
    await assertProjection(context, 2);
    expect(await db.fixture.findUniqueOrThrow({ where: { id: context.active.id } }))
      .toMatchObject(mode === "elements_only" ? { x: 42, y: 55, placementStatus: "placed" } : { x: 0, y: 0, placementStatus: "unplaced" });
  });

  it.each([false, true])("applies CAD using only active overlays (common=%s)", async common => {
    const context = await seed();
    const { floor, user } = context;
    const source = await db.floorAsset.create({ data: { floorId: floor.id, kind: "original", status: "ready",
      objectKey: `test/${randomUUID()}.dxf`, mimeType: "application/dxf", sizeBytes: 256n, sha256: "a".repeat(64), readyAt: new Date() } });
    const rendered = await db.floorAsset.create({ data: { floorId: floor.id, kind: "rendered", status: "ready",
      objectKey: `test/${randomUUID()}.svg`, mimeType: "image/svg+xml", contentEncoding: null,
      sizeBytes: 256n, sha256: "b".repeat(64), readyAt: new Date() } });
    async function* empty() { /* Geometry content is irrelevant to fixture projection. */ }
    const ref = common ? await store.prepareGeneration(floor.id, empty(), {
      width: 640, height: 600, gridSize: 10, groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }]
    }) : undefined;
    const job = await db.floorImportJob.create({ data: { floorId: floor.id, sourceAssetId: source.id,
      renderedAssetId: rendered.id, sourceFormat: "dxf", status: "review_required", stage: "review_required",
      attemptCount: 1, startedAt: new Date(), reviewRequiredAt: new Date(), progressPercent: 100,
      excludedRegionPrimitiveCount: 0, preparedMapGenerationId: ref?.generationId,
      detectorProfileId: "generic-lighting-v1", detectorProfileVersion: "legacy-unknown", detectorProfileDigest: "0".repeat(64) } });
    // The CAD display metadata adapter is external to the map/fixture boundary;
    // the prepared canonical generation itself is persisted and pinned for real.
    const preparation = ref ? { readPrepared: async () => ref, readDisplayManifest: async () => ({}) } : undefined;
    const imports = new FloorImportService(db as never, access, audit, storage as never,
      undefined, undefined, preparation as never, common ? store : undefined);
    const result = await imports.apply(user, floor.id, job.id, { expectedRevision: 0,
      leaseToken: "owned-lease", leaseFence: 1, confirmMapReset: true, candidateIds: [] });
    expect(result).toMatchObject({ status: "completed", revision: 1, unplacedFixtureCount: 1 });
    await assertProjection(context, 1);
  });

  it("freezes retired live energy/cost/durations and separates same-UUID new registration history", async () => {
    const context = await seed();
    const { site, floor, gateway, user, retired, retiredAt, deviceUuid } = context;
    const analytics = new EnergyAnalyticsQueryService(db as never, access);
    const day = { year: retiredAt.getUTCFullYear(), month: retiredAt.getUTCMonth() + 1, day: retiredAt.getUTCDate() };
    const nextDay = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
    const end = { year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1, day: nextDay.getUTCDate() };
    const fixtures = await (analytics as any).loadFixtures(site.id, day, end);
    const project = (at: Date) => (analytics as any).buildFixtureValues(fixtures, day, at, "UTC", new Prisma.Decimal(100))
      .get(retired.id);
    const history = {
      aggregates: await db.fixtureEnergyDailyAggregate.findMany({ where: { fixtureId: retired.id } }),
      cursor: await db.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: retired.id } })
    };
    const atRetirement = project(retiredAt);
    expect(atRetirement.size).toBeGreaterThan(0);
    expect(project(new Date(retiredAt.getTime() + 60_000))).toEqual(atRetirement);
    expect(project(new Date(retiredAt.getTime() + 600_000))).toEqual(atRetirement);
    const summary = await analytics.getSiteSummary(user, site.id);
    expect(summary.baseline24Hours.fixtureCount).toBe(1);
    const node = await db.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid,
      meshAddress: "0x0101", firmwareVersion: "new" } });
    const fresh = await db.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "new registration", ratedWatt: 20, x: 0, y: 0 } });
    const reloaded = await (analytics as any).loadFixtures(site.id, day, end);
    expect(reloaded.map((fixture: { id: string }) => fixture.id)).toEqual(expect.arrayContaining([retired.id, fresh.id]));
    expect(reloaded.find((fixture: { id: string }) => fixture.id === fresh.id))
      .toMatchObject({ firstStateOccurredAt: null, energyStateCursor: null, energyDailyAggregates: [] });
    expect(await db.fixtureEnergyDailyAggregate.findMany({ where: { fixtureId: retired.id } })).toEqual(history.aggregates);
    expect(await db.fixtureEnergyStateCursor.findUnique({ where: { fixtureId: retired.id } })).toEqual(history.cursor);
  });
});
