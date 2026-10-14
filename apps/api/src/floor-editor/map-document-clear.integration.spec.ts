import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MapDocumentRef, MapElement } from "@led-control/shared";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { AuthenticatedUser } from "../auth/auth.types";
import { AuthService } from "../auth/auth.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { FloorImportWorkerService } from "../floor-import/floor-import-worker.service";
import { FixedLightingDetectorRegistry } from "../floor-import/lighting-detector-registry";
import { FloorEditorController } from "./floor-editor.controller";
import { FloorEditorService } from "./floor-editor.service";
import { EditorLeaseService } from "./editor-lease.service";
import { MapDocumentResetService } from "./map-document-reset.service";
import { MapDocumentStore } from "./map-document-store";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { MapDocumentMutationService } from "./map-document-mutation.service";
import { MapDocumentCheckpointService } from "./map-document-checkpoint.service";
import { MapDocumentStagingService } from "./map-document-staging.service";
import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";
import { MapDocumentAssetReferences } from "./map-document-asset-references";
import { buildMapDocumentSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";
import { hashEditorLeaseToken } from "./editor-lease-token";

// Opt-in owns a new Unix cluster; no ambient DATABASE_URL or running app is used.
(process.env.RUN_MAP_CLEAR_POSTGRES_TESTS === "1" ? describe : describe.skip)("map clear disposable PostgreSQL", () => {
  jest.setTimeout(120_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  let prisma: PrismaClient, store: MapDocumentStore, data: MapDocumentRevisionData;
  let access: SiteAccessService, audit: AuditService, service: MapDocumentResetService, editor: FloorEditorService;
  let staging: MapDocumentStagingService;
  let user: AuthenticatedUser, floorId: string, otherFloorId: string, siteId: string, fixtureId: string, ref: MapDocumentRef;
  const objects = new Map<string, Buffer>();
  const storage = {
    putCadSceneObjectFile: jest.fn(async (key: string, path: string) => { objects.set(key, await readFile(path)); }),
    verifyCadSceneObject: jest.fn(async () => undefined),
    downloadFloorAssetToFile: jest.fn(async (key: string, path: string) => {
      const bytes = objects.get(key); if (!bytes) throw new Error("missing fixture object");
      await writeFile(path, bytes, { flag: "wx" });
    }),
    deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
  };
  const lease = { leaseToken: "clear-lease", leaseFence: 2 };
  const input = (mode = "elements_only") => ({ requestId: randomUUID(), baseRevision: ref.revision, ...lease, mode });
  const clear = (body = input(), id = floorId, actor = user) => service.clear(id, actor, body);
  const element = (id: string, provenance: MapElement["provenance"] = null): MapElement => ({ id, type: "rectangle",
    geometry: { origin: { x: 20, y: 30 }, width: 100, height: 60 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, groupId: null, layerId: "map", zIndex: 0,
    visible: true, locked: false, style: { strokeWidth: 1, strokeColor: "#000000", fillColor: null, opacity: 1 }, provenance });

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(`fixture migration failed: ${deployed.stderr}\n${deployed.stdout}`);
    prisma = new PrismaClient({ datasourceUrl: url });
    const [identity] = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    expect(`/${identity.database}`).toBe(new URL(url).pathname);
    store = new MapDocumentStore(prisma as never, storage as never);
    data = new MapDocumentRevisionData(prisma as never, storage as never, store);
    access = new SiteAccessService(prisma as never); audit = new AuditService(prisma as never);
    service = new MapDocumentResetService(prisma as never, access, audit, store);
    const mutations = new MapDocumentMutationService(prisma as never, access, audit, storage as never, store, data);
    editor = new FloorEditorService(prisma as never, access, audit, undefined, undefined, mutations, data);
    staging = new MapDocumentStagingService(prisma as never, access, audit, storage as never, store, data,
      new MapDocumentCheckpointService(prisma as never, storage as never, store, data), editor);
    console.log("Verified self-owned map-clear PostgreSQL cluster and deployed migrations");
  });
  afterAll(async () => {
    try { if (prisma) await prisma.$disconnect(); } finally { cluster?.stop(); }
    console.log("Stopped and removed self-owned map-clear PostgreSQL cluster");
  });
  beforeEach(async () => {
    jest.restoreAllMocks(); jest.clearAllMocks(); objects.clear();
    const org = await prisma.organization.create({ data: { name: "clear", type: "customer" } });
    const row = await prisma.user.create({ data: { organizationId: org.id, loginId: randomUUID(), name: "admin", passwordHash: "unused", role: "admin" } });
    user = { ...row, role: "admin", status: "active", organizationType: "customer" };
    siteId = (await prisma.site.create({ data: { organizationId: org.id, adminUserId: row.id, name: "clear" } })).id;
    floorId = (await prisma.floor.create({ data: { siteId, name: "clear", level: 1, ...{
      editorLeaseFence: 2, editorLeaseHolderId: row.id, editorLeaseTokenHash: hashEditorLeaseToken(lease.leaseToken),
      editorLeaseExpiresAt: new Date(Date.now() + 600_000) } } })).id;
    otherFloorId = (await prisma.floor.create({ data: { siteId, name: "untouched", level: 2 } })).id;
    fixtureId = (await prisma.fixture.create({ data: { floorId, name: "Registered lamp", ratedWatt: 40, x: 200, y: 300,
      size: 32, placementStatus: "placed", positionVerifiedAt: new Date("2026-10-01T03:00:00.000Z"), brightness: 60, powerOn: true } })).id;
    const elements = [element("manual"), element("cad", { importJobId: "historical-cad", sourceId: "symbol" })];
    ref = await store.prepareGeneration(floorId, (async function* () { yield* elements; })(), {
      width: 2000, height: 1000, gridSize: 20, groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }] });
    await prisma.floorPlan.create({ data: { floorId, sourceType: "none", imageUrl: "", width: 2000, height: 1000, gridSize: 20 } });
    await prisma.$transaction(async tx => {
      const fixture = await tx.fixture.findUniqueOrThrow({ where: { id: fixtureId }, select: {
        id: true, name: true, ratedWatt: true, x: true, y: true, size: true, placementStatus: true, positionVerifiedAt: true } });
      const snapshot = buildMapDocumentSnapshot({ document: ref, lightSlots: [], fixtures: [{ ...fixture, ratedWatt: "40",
        positionVerifiedAt: fixture.positionVerifiedAt!.toISOString() }] });
      const revision = await tx.floorMapRevision.create({ data: { floorId, revision: ref.revision,
        snapshot: snapshot as Prisma.InputJsonValue, snapshotSha256: hashFloorEditorSnapshot(snapshot), changeSummary: {}, changedBy: user.id } });
      await store.pinRevision(tx, floorId, revision.id, ref);
      await tx.floorMapDocument.create({ data: { floorId, revision: ref.revision, activeGenerationId: ref.generationId } });
      await tx.floorMapGeneration.update({ where: { id: ref.generationId }, data: { status: "active" } });
      await tx.floor.update({ where: { id: floorId }, data: { mapRevision: ref.revision } });
    });
    await prisma.floorMapObject.createMany({ data: [floorId, otherFloorId].map(id => ({ floorId: id, type: "rectangle", x: 20, y: 30 })) });
  });

  async function state() {
    return { floor: await prisma.floor.findUniqueOrThrow({ where: { id: floorId } }),
      fixtures: await prisma.fixture.findMany({ where: { floorId }, orderBy: { id: "asc" } }),
      plan: await prisma.floorPlan.findUnique({ where: { floorId } }),
      objects: await prisma.floorMapObject.findMany({ where: { floorId } }),
      revisions: await prisma.floorMapRevision.findMany({ where: { floorId }, orderBy: { revision: "asc" } }),
      pins: await prisma.floorMapRevisionAsset.findMany({ where: { floorId }, orderBy: [{ revisionId: "asc" }, { assetId: "asc" }] }),
      head: await prisma.floorMapDocument.findUnique({ where: { floorId } }),
      slots: await prisma.floorLightSlot.findMany({ where: { floorId } }),
      jobs: await prisma.floorImportJob.findMany({ where: { floorId } }),
      stages: await prisma.floorMapStage.findMany({ where: { floorId } }),
      scene: await prisma.floorCadScene.findUnique({ where: { floorId } }) };
  }
  async function seedSlot() {
    const source = await prisma.floorAsset.create({ data: { floorId, kind: "original", status: "ready", readyAt: new Date(),
      mimeType: "application/dxf", objectKey: `floors/${floorId}/${randomUUID()}.dxf`, sizeBytes: 128, sha256: "a".repeat(64) } });
    const rendered = await prisma.floorAsset.create({ data: { floorId, kind: "rendered", status: "ready", readyAt: new Date(),
      mimeType: "image/svg+xml", objectKey: `floors/${floorId}/${randomUUID()}.svg`, sizeBytes: 128, sha256: "b".repeat(64) } });
    const job = await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf",
      renderedAssetId: rendered.id, status: "completed", stage: "completed", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), completedAt: new Date(), appliedAt: new Date(),
      detectorProfileId: "generic-lighting-v1", detectorProfileVersion: "legacy-unknown", detectorProfileDigest: "0".repeat(64) } });
    const candidate = await prisma.floorImportCandidate.create({ data: { jobId: job.id, sourceEntityId: "legacy-slot", layerName: "LIGHT",
      x: 200, y: 300, confidence: 0.95, detectionMethod: "rule_based" } });
    const slot = await prisma.floorLightSlot.create({ data: { floorId, sourceImportJobId: job.id, sourceCandidateId: candidate.id,
      assignedFixtureId: fixtureId, x: 200, y: 300 } });
    // Real editor save captures a slot assignment and a geometry delta in history.
    const saved = await editor.saveEditorState(user, floorId, { expectedRevision: ref.revision, ...lease,
      fixtureUpdates: [], slotAssignments: [], objectCreates: [], objectUpdates: [], objectDeletes: [],
      documentChanges: { requestId: randomUUID(), generationId: ref.generationId, operations: [{ kind: "add", element: element("delta") }] } });
    ref = saved.floor.mapDocument!;
    return { job, slot, source };
  }

  it.each(["elements_only", "elements_and_placement"])("clears %s with dimensions/history/pins/device settings and other floors retained", async mode => {
    const { job } = await seedSlot();
    const before = await state();
    const other = await prisma.floorMapObject.findMany({ where: { floorId: otherFloorId } });
    const next = await clear(input(mode));
    expect(next).toMatchObject({ revision: 3, elementCount: 0, width: 2000, height: 1000, gridSize: 20 });
    expect(await data.currentRef(floorId)).toEqual(next);
    const after = await state();
    expect(after.objects).toEqual([]); expect(after.slots).toEqual([]);
    expect(after.revisions.slice(0, -1)).toEqual(before.revisions);
    expect(after.pins).toEqual(expect.arrayContaining(before.pins));
    expect(after.revisions.at(-1)).toMatchObject({ snapshot: { version: 3, document: next, lightSlots: [] } });
    expect(after.fixtures[0]).toEqual(mode === "elements_only" ? before.fixtures[0] : { ...before.fixtures[0],
      x: 0, y: 0, placementStatus: "unplaced", positionVerifiedAt: null, updatedAt: expect.any(Date) });
    expect(await prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
    expect(await prisma.floorMapObject.findMany({ where: { floorId: otherFloorId } })).toEqual(other);
    expect(after.plan).toMatchObject({ width: 2000, height: 1000, gridSize: 20, sourceType: "none", imageUrl: "" });
    expect(await (await data.readRevision(floorId, next)).getElements(["manual", "cad", "delta"])).toEqual([]);
    // A normal cleanup cannot remove a prior generation or its delta assets.
    await prisma.floorAsset.updateMany({ where: { floorId }, data: { createdAt: new Date(0), readyAt: new Date(0) } });
    await new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never)).processPending();
    expect(await (await data.readRevision(floorId, ref)).getElements(["manual", "cad", "delta"])).toHaveLength(3);
  });

  it.each(["elements_only", "elements_and_placement"])("restores geometry, historical slots and placement after %s via the existing restore contract", async mode => {
    const { slot } = await seedSlot();
    const original = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
    const next = await clear(input(mode));
    const restored = await editor.restoreEditorRevision(user, floorId, ref.revision, { expectedRevision: next.revision, ...lease });
    const document = restored.floor.mapDocument!;
    expect(document).toMatchObject({ revision: 4, elementCount: 3, width: 2000, height: 1000, gridSize: 20 });
    expect(await (await data.readRevision(floorId, document)).getElements(["manual", "cad", "delta"])).toHaveLength(3);
    expect(await prisma.floorLightSlot.findUniqueOrThrow({ where: { id: slot.id } })).toMatchObject({
      id: slot.id, sourceImportJobId: slot.sourceImportJobId, sourceCandidateId: slot.sourceCandidateId, assignedFixtureId: fixtureId, x: 200, y: 300 });
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).toEqual({ ...original, updatedAt: expect.any(Date) });
  });

  it("replays after lease expiration without assets/revisions, rejects different mode and reauthorizes", async () => {
    const request = input(); const next = await clear(request);
    await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseExpiresAt: new Date(0) } });
    const before = await state(); const assets = await prisma.floorAsset.count({ where: { floorId } });
    expect(await clear({ ...request })).toEqual(next);
    expect(await state()).toEqual(before);
    expect(await prisma.floorAsset.count({ where: { floorId } })).toBe(assets);
    await expect(clear({ ...request, mode: "elements_and_placement" })).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.auditLog.count({ where: { targetId: floorId, action: "floor_editor.clear" } })).toBe(1);
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
    await expect(clear(request)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("serializes identical concurrent clears but conflicts different modes of the same request", async () => {
    const request = input();
    const results = await Promise.all([clear(request), clear(request)]);
    expect(results[0]).toEqual(results[1]);
    expect((await state()).floor.mapRevision).toBe(2);
    expect(await prisma.floorMapGeneration.count({ where: { floorId, status: "active" } })).toBe(2);
    const next = input(); next.baseRevision = 2;
    const outcomes = await Promise.allSettled([clear(next), clear({ ...next, mode: "elements_and_placement" })]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it.each([{ leaseFence: 1 }, { leaseToken: "stale" }, { baseRevision: 0 }])("rejects stale authority %j without preparing", async patch => {
    const before = await state(), generations = await prisma.floorMapGeneration.count({ where: { floorId } });
    await expect(clear({ ...input(), ...patch })).rejects.toBeInstanceOf(ConflictException);
    expect(await state()).toEqual(before);
    expect(await prisma.floorMapGeneration.count({ where: { floorId } })).toBe(generations);
  });
  it.each(["expired", "archived", "different-holder"])("rejects %s without mutation", async kind => {
    await prisma.floor.update({ where: { id: floorId }, data: kind === "expired" ? { editorLeaseExpiresAt: new Date(0) }
      : kind === "archived" ? { status: "archived" } : { editorLeaseHolderId: "another" } });
    const before = await state(); await expect(clear()).rejects.toBeInstanceOf(ConflictException); expect(await state()).toEqual(before);
  });
  it("denies viewer, cross-tenant and missing-floor callers", async () => {
    const viewer = await prisma.user.create({ data: { organizationId: user.organizationId, loginId: randomUUID(), name: "viewer", passwordHash: "unused", role: "viewer" } });
    await prisma.siteMembership.create({ data: { siteId, userId: viewer.id, accessLevel: "read" } });
    const before = await state();
    await expect(clear(input(), floorId, { ...user, id: viewer.id, role: "viewer" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(clear(input(), floorId, { ...user, organizationId: "another" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(clear(input(), "missing")).rejects.toBeInstanceOf(NotFoundException);
    expect(await state()).toEqual(before);
  });
  it("protects legacy-only maps without invoking destructive bootstrap or losing history", async () => {
    await prisma.floorMapDocument.delete({ where: { floorId } });
    const before = await state();
    await expect(clear()).rejects.toMatchObject({ status: 409, response: { code: "map_document_required" } });
    expect(await state()).toEqual(before);
  });
  it("keeps the destructive reset compatibility contract separate from clear", async () => {
    await seedSlot();
    const next = await service.reset(floorId, user, { requestId: randomUUID(), baseRevision: ref.revision, ...lease });
    expect(next).toMatchObject({ revision: 3, elementCount: 0, width: 1200, height: 800, gridSize: 10 });
    const after = await state();
    expect(after.revisions).toHaveLength(1); expect(after.jobs).toEqual([]); expect(after.slots).toEqual([]);
    expect(after.fixtures[0]).toMatchObject({ name: "Registered lamp", size: 32, brightness: 60, powerOn: true,
      placementStatus: "unplaced", x: 0, y: 0, positionVerifiedAt: null });
    expect(await prisma.floorMapGeneration.count({ where: { floorId } })).toBe(1);
  });
  it("retains registration/control/energy records and fixtures on another floor", async () => {
    const gateway = await prisma.gateway.create({ data: { siteId, name: "Registered gateway", serialNumber: randomUUID(), firmwareVersion: "test" } });
    const node = await prisma.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid: randomUUID(), meshAddress: "0x0100", firmwareVersion: "test",
      vehicleSensorCapabilityStatus: "supported", vehicleSensorCapabilityVerifiedAt: new Date(), vehicleSensorCapabilityRevision: 1,
      vehicleSensorServerBound: true, vehicleVendorEventModelBound: true } });
    await prisma.fixture.update({ where: { id: fixtureId }, data: { gatewayId: gateway.id, meshNodeId: node.id } });
    await prisma.fixture.create({ data: { floorId: otherFloorId, name: "Other fixture", ratedWatt: 20, x: 12, y: 34, placementStatus: "placed" } });
    await prisma.fixtureGroup.create({ data: { floorId, siteId, gatewayId: gateway.id, name: "Keep group", groupFixtures: { create: { fixtureId } } } });
    await prisma.lightingSchedule.create({ data: { siteId, gatewayId: gateway.id, name: "Keep schedule",
      activeFrom: new Date("2026-10-01T00:00:00Z"), activeUntil: new Date("2026-11-01T00:00:00Z"),
      localStartTime: "08:00", localEndTime: "20:00", recurrenceKind: "daily", dimmingEnabled: true, brightnessPercent: 60,
      createdById: user.id, updatedById: user.id, fixtures: { create: { fixtureId } } } });
    await prisma.vehicleEventRule.create({ data: { siteId, gatewayId: gateway.id, name: "Keep rule", dimmingEnabled: true, brightnessPercent: 80,
      createdById: user.id, updatedById: user.id, sources: { create: { fixtureId } }, targets: { create: { fixtureId } } } });
    await prisma.energyUsage.create({ data: { fixtureId, source: "measured", period: "2026-10", kwh: "12.3", cost: "100" } });
    await prisma.command.create({ data: { siteId, requestedBy: user.id, clientRequestId: randomUUID(), requestFingerprint: "clear-test",
      targetType: "fixture", targetId: fixtureId, targetFixtureIds: [fixtureId], brightness: 60 } });
    const evidence = async () => ({
      gateway: await prisma.gateway.findUniqueOrThrow({ where: { id: gateway.id } }),
      node: await prisma.meshNode.findUniqueOrThrow({ where: { id: node.id } }),
      groups: await prisma.fixtureGroup.findMany({ where: { floorId }, include: { groupFixtures: true } }),
      schedules: await prisma.lightingSchedule.findMany({ where: { siteId }, include: { fixtures: true } }),
      rules: await prisma.vehicleEventRule.findMany({ where: { siteId }, include: { sources: true, targets: true } }),
      energy: await prisma.energyUsage.findMany({ where: { fixtureId } }), commands: await prisma.command.findMany({ where: { siteId } }),
      otherFixtures: await prisma.fixture.findMany({ where: { floorId: otherFloorId } })
    });
    const before = await evidence(), fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
    await clear(); expect(await evidence()).toEqual(before);
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).toEqual(fixture);
  });
  it.each(["lease", "revision", "admin", "preparation-expiry", "asset-claim"])("revalidates %s after preparation and keeps old pins", async change => {
    const before = await state(); const prepare = store.prepareGeneration.bind(store);
    jest.spyOn(store, "prepareGeneration").mockImplementationOnce(async (...args) => {
      const result = await prepare(...args);
      if (change === "lease") await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseFence: { increment: 1 } } });
      if (change === "revision") await prisma.floor.update({ where: { id: floorId }, data: { mapRevision: { increment: 1 } } });
      if (change === "admin") await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
      if (change === "preparation-expiry") await prisma.floorMapGeneration.update({ where: { id: result.generationId }, data: { expiresAt: new Date(0) } });
      if (change === "asset-claim") await prisma.floorAsset.update({ where: { id: result.manifest.assetId }, data: { cleanupStartedAt: new Date() } });
      return result;
    });
    await expect(clear()).rejects.toThrow();
    const after = await state();
    expect(after.revisions).toEqual(before.revisions); expect(after.pins).toEqual(before.pins);
    expect(after.fixtures).toEqual(before.fixtures); expect(after.head).toEqual(before.head); expect(after.objects).toEqual(before.objects);
  });
  it("rolls back clear, slot removal, history and pins on audit failure, then retries", async () => {
    await seedSlot(); const before = await state(); const request = input("elements_and_placement");
    jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("clear audit unavailable"));
    await expect(clear(request)).rejects.toThrow("clear audit unavailable");
    expect(await state()).toEqual(before);
    expect(await clear(request)).toMatchObject({ revision: 3, elementCount: 0 });
  });
  it("leaves the old document and fixtures intact when object upload fails", async () => {
    const before = await state(); storage.putCadSceneObjectFile.mockRejectedValueOnce(new Error("clear PUT unavailable"));
    await expect(clear()).rejects.toThrow("clear PUT unavailable"); expect(await state()).toEqual(before);
  });
  it("retains exactly the latest 30 history snapshots and their assets", async () => {
    for (let i = 0; i < 31; i++) ref = await clear(input(i % 2 ? "elements_only" : "elements_and_placement"));
    const rows = await prisma.floorMapRevision.findMany({ where: { floorId }, orderBy: { revision: "asc" } });
    expect(rows.map(row => row.revision)).toEqual(Array.from({ length: 30 }, (_, i) => i + 3));
    expect(await prisma.floorMapGeneration.count({ where: { floorId } })).toBe(32);
    expect(await prisma.floorMapRevisionAsset.count({ where: { floorId } })).toBe(30);
  });
  it("cancels pending stages/imports without deleting historical jobs or generations and fences a paused worker", async () => {
    const { job: completed, source } = await seedSlot();
    const stage = await staging.create(floorId, user, { expectedRevision: ref.revision, ...lease,
      fixtureUpdates: [], slotAssignments: [], objectCreates: [], objectUpdates: [], objectDeletes: [],
      documentChanges: { requestId: randomUUID(), generationId: ref.generationId, operations: [] } });
    const job = await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf" } });
    let enter!: () => void, release!: () => void;
    const downloading = new Promise<void>(resolve => { enter = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const worker = new FloorImportWorkerService(prisma as never, { downloadFloorAssetToFile: async () => { enter(); await resume; } } as never,
      {} as never, new FixedLightingDetectorRegistry(), {} as never, { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false });
    const running = worker.runOnce();
    try {
      await Promise.race([downloading, running.then(() => { throw new Error("worker missed download barrier"); })]);
      const next = await clear(); release(); await running;
      expect(await data.currentRef(floorId)).toEqual(next);
      expect(await prisma.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null });
      expect(await prisma.floorImportJob.findUniqueOrThrow({ where: { id: completed.id } })).toEqual(completed);
      expect(await prisma.floorMapStage.findUniqueOrThrow({ where: { id: stage.id } })).toMatchObject({ status: "cancelled", workerToken: null, workerExpiresAt: null });
      await expect(staging.prepare(floorId, stage.id, user, { ...lease, partCount: 1, decodedBytes: 2, sha256: "a".repeat(64) })).rejects.toBeInstanceOf(ConflictException);
      expect(await prisma.floorMapGeneration.findUnique({ where: { id: ref.generationId } })).not.toBeNull();
    } finally { release(); await running; await worker.onModuleDestroy(); }
  });
  it("exposes authenticated clear with exact MapDocumentRef/201/replay/400/401/403/409", async () => {
    const viewer = await prisma.user.create({ data: { organizationId: user.organizationId, loginId: randomUUID(), name: "viewer", passwordHash: "unused", role: "viewer" } });
    await prisma.siteMembership.create({ data: { siteId, userId: viewer.id, accessLevel: "read" } });
    const module = await Test.createTestingModule({ controllers: [FloorEditorController], providers: [
      { provide: FloorEditorService, useValue: editor }, { provide: EditorLeaseService, useValue: {} },
      { provide: MapDocumentResetService, useValue: service },
      { provide: AuthService, useValue: { getUserBySessionToken: async (token: string) => {
        if (token === "admin") return user;
        if (token === "viewer") return { ...user, id: viewer.id, role: "viewer" };
        throw new UnauthorizedException();
      } } }
    ] }).compile();
    const app = module.createNestApplication(); await app.listen(0, "127.0.0.1");
    const base = await app.getUrl(), request = input();
    const send = (body: unknown, role?: string) => fetch(`${base}/floors/${floorId}/editor-clear`, { method: "POST",
      headers: { "content-type": "application/json", ...(role ? { cookie: `${AuthService.sessionCookieName}=${role}` } : {}) }, body: JSON.stringify(body) });
    try {
      expect((await send(request)).status).toBe(401);
      expect((await send(request, "viewer")).status).toBe(403);
      expect((await send({ ...request, mode: "invalid" }, "admin")).status).toBe(400);
      const response = await send(request, "admin"); expect(response.status).toBe(201);
      const result = await response.json(); expect(result).toEqual(await data.currentRef(floorId));
      expect(await (await send(request, "admin")).json()).toEqual(result);
      expect((await send({ ...request, mode: "elements_and_placement" }, "admin")).status).toBe(409);
    } finally { await app.close(); }
  });
});
