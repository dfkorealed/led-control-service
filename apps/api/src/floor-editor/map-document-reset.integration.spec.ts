import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { AuthenticatedUser } from "../auth/auth.types";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { MapDocumentStore } from "./map-document-store";
import { MapDocumentResetService } from "./map-document-reset.service";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";
import { MapDocumentAssetReferences } from "./map-document-asset-references";
import { FloorEditorController } from "./floor-editor.controller";
import { FloorEditorService } from "./floor-editor.service";
import { EditorLeaseService } from "./editor-lease.service";
import { AuthService } from "../auth/auth.service";
import { FloorImportWorkerService } from "../floor-import/floor-import-worker.service";
import { FixedLightingDetectorRegistry } from "../floor-import/lighting-detector-registry";
import { TargetSnapshotService } from "../automation/target-snapshot.service";

const url = process.env.MAP_RESET_TEST_DATABASE_URL;
(url ? describe : describe.skip)("explicit map reset isolated PostgreSQL", () => {
  const prisma = new PrismaClient(url ? { datasourceUrl: url } : undefined);
  const objects = new Map<string, Buffer>();
  const storage = {
    putCadSceneObjectFile: jest.fn(async (key: string, path: string) => { objects.set(key, await readFile(path)); }),
    verifyCadSceneObject: jest.fn(async () => undefined),
    downloadFloorAssetToFile: jest.fn(async (key: string, path: string) => {
      const bytes = objects.get(key); if (!bytes) throw new Error("missing object");
      await writeFile(path, bytes, { flag: "wx" });
    }),
    deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
  };
  const store = new MapDocumentStore(prisma as never, storage as never);
  const access = new SiteAccessService(prisma as never);
  const audit = new AuditService(prisma as never);
  const service = new MapDocumentResetService(prisma as never, access, audit, store);
  let user: AuthenticatedUser;
  let floorId: string;
  let otherFloorId: string;
  let siteId: string;
  let fixtureId: string;
  const input = () => ({ requestId: randomUUID(), baseRevision: 7, leaseToken: "reset-lease", leaseFence: 2 });

  beforeAll(async () => {
    const target = new URL(url!);
    if (!/^\/led_u5_test_[a-z0-9_]+$/.test(target.pathname) || target.hostname !== "127.0.0.1" || target.search) {
      throw new Error("U5 requires its own disposable local database");
    }
    const [identity] = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (`/${identity.database}` !== target.pathname) throw new Error("U5 database identity mismatch");
  });
  beforeEach(async () => {
    jest.restoreAllMocks(); jest.clearAllMocks(); objects.clear();
    const org = await prisma.organization.create({ data: { name: "U5", type: "customer" } });
    const row = await prisma.user.create({ data: { organizationId: org.id, loginId: randomUUID(), name: "U5", passwordHash: "unused", role: "admin" } });
    user = { ...row, role: "admin", status: "active", organizationType: "customer" };
    const site = await prisma.site.create({ data: { organizationId: org.id, adminUserId: row.id, name: "U5" } }); siteId = site.id;
    const floor = await prisma.floor.create({ data: { siteId, name: "reset", level: 1, mapRevision: 7,
      editorLeaseFence: 2, editorLeaseTokenHash: hashEditorLeaseToken("reset-lease"), editorLeaseHolderId: user.id,
      editorLeaseExpiresAt: new Date(Date.now() + 600_000) } }); floorId = floor.id;
    otherFloorId = (await prisma.floor.create({ data: { siteId, name: "untouched", level: 2 } })).id;
    fixtureId = (await prisma.fixture.create({ data: { floorId, name: "Registered", ratedWatt: "40", x: 200, y: 300,
      placementStatus: "placed", positionVerifiedAt: new Date(), brightness: 60 } })).id;
    await prisma.floorMapObject.createMany({ data: [floorId, otherFloorId].map(id => ({ floorId: id, type: "rectangle", x: 20, y: 30 })) });
    await prisma.floorPlan.create({ data: { floorId, imageUrl: "", sourceType: "none", width: 2000, height: 1000, gridSize: 20 } });
    await prisma.floorMapRevision.create({ data: { floorId, revision: 7, snapshot: {}, snapshotSha256: "0".repeat(64), changeSummary: {}, changedBy: user.id } });
    await prisma.gateway.create({ data: { siteId, name: "retained", serialNumber: randomUUID(), firmwareVersion: "test" } });
    await prisma.energyUsage.create({ data: { fixtureId, source: "measured", period: "2026-09", kwh: "12.3", cost: "100" } });
    await prisma.command.create({ data: { siteId, requestedBy: user.id, clientRequestId: randomUUID(),
      requestFingerprint: "test", targetType: "fixture", targetId: fixtureId, targetFixtureIds: [fixtureId], brightness: 60 } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function state() {
    return {
      floor: await prisma.floor.findUniqueOrThrow({ where: { id: floorId } }),
      fixture: await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } }),
      plan: await prisma.floorPlan.findUnique({ where: { floorId } }),
      objects: await prisma.floorMapObject.findMany({ where: { floorId } }),
      revisions: await prisma.floorMapRevision.findMany({ where: { floorId } }),
      document: await prisma.floorMapDocument.findUnique({ where: { floorId } }),
      jobs: await prisma.floorImportJob.findMany({ where: { floorId } }),
      slots: await prisma.floorLightSlot.findMany({ where: { floorId } }),
      scene: await prisma.floorCadScene.findUnique({ where: { floorId }, include: { tiles: true, layerStates: true, elementOverrides: true } })
    };
  }

  it("discards old map history, publishes/pins one empty default map, and preserves hardware and other floors", async () => {
    const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
    const other = await prisma.floorMapObject.findMany({ where: { floorId: otherFloorId } });
    const gateways = await prisma.gateway.findMany({ where: { siteId } });
    const energy = await prisma.energyUsage.findMany({ where: { fixtureId } });
    const commands = await prisma.command.findMany({ where: { siteId } });
    const ref = await service.reset(floorId, user, input());
    expect(ref).toMatchObject({ revision: 8, elementCount: 0, width: 1200, height: 800, gridSize: 10 });
    const result = await state();
    expect(result.objects).toEqual([]);
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]).toMatchObject({ revision: 8, snapshot: { version: 3, document: ref, lightSlots: [] } });
    expect(result.fixture).toEqual({ ...fixture, x: 0, y: 0, placementStatus: "unplaced", positionVerifiedAt: null, updatedAt: expect.any(Date) });
    expect(result.document).toMatchObject({ activeGenerationId: ref.generationId, revision: 8 });
    expect(result.plan).toMatchObject({ sourceType: "none", imageUrl: "", originalFileUrl: null, renderedImageUrl: null, width: 1200, height: 800 });
    expect((await store.readManifest(floorId, ref)).layers).toEqual([{ id: "map", name: "Map", order: 0, visible: true, locked: false }]);
    expect(await prisma.floorMapRevisionAsset.count({ where: { floorId } })).toBe(1);
    expect(await prisma.floorMapObject.findMany({ where: { floorId: otherFloorId } })).toEqual(other);
    expect(await prisma.gateway.findMany({ where: { siteId } })).toEqual(gateways);
    expect(await prisma.energyUsage.findMany({ where: { fixtureId } })).toEqual(energy);
    expect(await prisma.command.findMany({ where: { siteId } })).toEqual(commands);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    expect(await prisma.site.findUnique({ where: { id: siteId } })).not.toBeNull();
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("replays exactly once, even after lease expiration, but rejects request ID/body mismatch", async () => {
    const request = input(); const first = await service.reset(floorId, user, request);
    await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseExpiresAt: new Date(0) } });
    const before = await state(); const assets = await prisma.floorAsset.count({ where: { floorId } });
    expect(await service.reset(floorId, user, { ...request })).toEqual(first);
    expect(await state()).toEqual(before);
    expect(await prisma.floorAsset.count({ where: { floorId } })).toBe(assets);
    await expect(service.reset(floorId, user, { ...request, baseRevision: 8 })).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.auditLog.count({ where: { targetId: floorId, action: "floor_editor.reset" } })).toBe(1);
  });

  it.each([{ leaseFence: 1 }, { leaseToken: "stale" }, { baseRevision: 6 }])("rejects stale write authority %j without preparing", async patch => {
    const before = await state();
    await expect(service.reset(floorId, user, { ...input(), ...patch })).rejects.toBeInstanceOf(ConflictException);
    expect(await state()).toEqual(before);
    expect(await prisma.floorMapGeneration.count({ where: { floorId } })).toBe(0);
  });

  it("denies read-only, cross-tenant, disabled and missing-floor callers", async () => {
    const viewer = await prisma.user.create({ data: { organizationId: user.organizationId, loginId: randomUUID(), name: "viewer", passwordHash: "unused", role: "viewer" } });
    await prisma.siteMembership.create({ data: { siteId, userId: viewer.id, accessLevel: "read" } });
    await expect(service.reset(floorId, { ...user, id: viewer.id, role: "viewer" }, input())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reset(floorId, { ...user, organizationId: "another" }, input())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reset("missing", user, input())).rejects.toBeInstanceOf(NotFoundException);
    await prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } });
    await prisma.user.update({ where: { id: user.id }, data: { status: "disabled" } });
    await expect(service.reset(floorId, user, input())).rejects.toBeInstanceOf(NotFoundException);
    expect((await state()).floor.mapRevision).toBe(7);
  });

  it("rolls back all destructive changes when audit persistence fails, then permits a retry", async () => {
    await seedCad();
    const source = await asset("original");
    async function* empty() {}
    const pinned = await store.prepareGeneration(floorId, empty(), { width: 1200, height: 800, gridSize: 10, groups: [], layers: [] });
    await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf", preparedMapGenerationId: pinned.generationId,
      status: "processing", stage: "parsing", progressPercent: 30, attemptCount: 1, leaseOwner: "worker", leaseExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date() } });
    const before = await state(); const request = input();
    jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(service.reset(floorId, user, request)).rejects.toThrow("audit unavailable");
    expect(await state()).toEqual(before);
    expect(await prisma.floorMapGeneration.findUnique({ where: { id: pinned.generationId } })).not.toBeNull();
    expect(await prisma.floorMapRevisionAsset.count({ where: { floorId } })).toBe(0);
    expect(await service.reset(floorId, user, request)).toMatchObject({ revision: 8 });
  });

  it("leaves the map intact on object upload failure", async () => {
    const before = await state();
    storage.putCadSceneObjectFile.mockRejectedValueOnce(new Error("PUT unavailable"));
    await expect(service.reset(floorId, user, input())).rejects.toThrow("PUT unavailable");
    expect(await state()).toEqual(before);
  });

  it("revalidates lease, revision and persisted authorization after preparation", async () => {
    const prepare = store.prepareGeneration.bind(store);
    for (const change of [
      () => prisma.floor.update({ where: { id: floorId }, data: { editorLeaseFence: { increment: 1 } } }),
      () => prisma.floor.update({ where: { id: floorId }, data: { mapRevision: { increment: 1 } } }),
      () => prisma.site.update({ where: { id: siteId }, data: { adminUserId: null } })
    ]) {
      await prisma.floor.update({ where: { id: floorId }, data: { mapRevision: 7, editorLeaseFence: 2 } });
      jest.spyOn(store, "prepareGeneration").mockImplementationOnce(async (...args) => {
        const ref = await prepare(...args); await change(); return ref;
      });
      await expect(service.reset(floorId, user, input())).rejects.toMatchObject({ status: expect.any(Number) });
      expect(await prisma.floorMapObject.count({ where: { floorId } })).toBe(1);
      expect(await prisma.floorMapDocument.findUnique({ where: { floorId } })).toBeNull();
    }
  });

  it("serializes concurrent identical requests without extra revisions", async () => {
    const request = input();
    const first = service.reset(floorId, user, request);
    const second = service.reset(floorId, user, request);
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect((await state()).floor.mapRevision).toBe(8);
    expect(await prisma.auditLog.count({ where: { targetId: floorId, action: "floor_editor.reset" } })).toBe(1);
  });

  it("removes superseded generation pins and allows normal cleanup while retaining the new manifest", async () => {
    const first = await service.reset(floorId, user, input());
    const next = await service.reset(floorId, user, { ...input(), baseRevision: 8 });
    expect(await prisma.floorMapGeneration.findUnique({ where: { id: first.generationId } })).toBeNull();
    expect(await prisma.floorMapRevisionAsset.count({ where: { generationId: first.generationId } })).toBe(0);
    await prisma.floorAsset.updateMany({ where: { floorId }, data: { readyAt: new Date(0), createdAt: new Date(0) } });
    const cleanup = new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never));
    await cleanup.processPending();
    expect(await prisma.floorAsset.findUnique({ where: { id: first.manifest.assetId } })).toBeNull();
    expect(await prisma.floorAsset.findUnique({ where: { id: next.manifest.assetId } })).not.toBeNull();
    expect((await store.readManifest(floorId, next)).layers[0].id).toBe("map");
  });

  it("rejects an expired preparation at publication, with all old state intact", async () => {
    const before = await state(); const prepare = store.prepareGeneration.bind(store);
    jest.spyOn(store, "prepareGeneration").mockImplementationOnce(async (...args) => {
      const ref = await prepare(...args);
      await prisma.floorMapGeneration.update({ where: { id: ref.generationId }, data: { expiresAt: new Date(0) } });
      return ref;
    });
    await expect(service.reset(floorId, user, input())).rejects.toBeInstanceOf(ConflictException);
    expect(await state()).toEqual(before);
  });

  it("rejects cleanup-claimed prepared assets before publishing, rolling back old geometry", async () => {
    const before = await state(); const prepare = store.prepareGeneration.bind(store);
    jest.spyOn(store, "prepareGeneration").mockImplementationOnce(async (...args) => {
      const ref = await prepare(...args);
      await prisma.floorAsset.update({ where: { id: ref.manifest.assetId }, data: { cleanupStartedAt: new Date() } });
      return ref;
    });
    await expect(service.reset(floorId, user, input())).rejects.toThrow("map asset ledger mismatch");
    expect(await state()).toEqual(before);
  });

  async function asset(kind: "original" | "rendered" | "cad_manifest" | "cad_tile") {
    const id = randomUUID();
    return prisma.floorAsset.create({ data: { id, floorId, kind, status: "ready", readyAt: new Date(),
      objectKey: `floors/${floorId}/${id}.${kind === "original" ? "dxf" : kind === "rendered" ? "svg" : "bin"}`,
      mimeType: { original: "application/dxf", rendered: "image/svg+xml", cad_manifest: "application/json", cad_tile: "application/vnd.led-control.cad-tile" }[kind],
      sizeBytes: 128, sha256: "a".repeat(64) } });
  }
  async function seedCad() {
    const source = await asset("original"); const rendered = await asset("rendered");
    const job = await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, renderedAssetId: rendered.id,
      sourceFormat: "dxf", status: "completed", stage: "completed", progressPercent: 100, attemptCount: 1,
      startedAt: new Date(), reviewRequiredAt: new Date(), completedAt: new Date(), appliedAt: new Date(),
      detectorProfileId: "generic-lighting-v1", detectorProfileVersion: "legacy-unknown", detectorProfileDigest: "0".repeat(64) } });
    const manifest = await asset("cad_manifest"); const tile = await asset("cad_tile");
    const region = await prisma.floorImportRegion.create({ data: { jobId: job.id, regionId: "region-aaaaaaaaaaaaaaaaaaaaaaaa",
      minX: 0, minY: 0, maxX: 100, maxY: 100, primitiveCount: 1, selectedAt: new Date() } });
    const scene = await prisma.floorCadScene.create({ data: { floorId, sourceImportJobId: job.id, sourceRegionId: region.id,
      version: 1, width: 512, height: 512, tileSize: 512, primitiveCount: 1, tileCount: 1, manifestAssetId: manifest.id,
      sourceMinX: 0, sourceMinY: 0, sourceMaxX: 100, sourceMaxY: 100, transformScaleX: 1, transformScaleY: -1,
      transformTranslateX: 0, transformTranslateY: 100,
      tiles: { create: { tileX: 0, tileY: 0, lod: 0, assetId: tile.id, primitiveCount: 1, byteSize: 128, minX: 0, minY: 0, maxX: 512, maxY: 512 } },
      elementOverrides: { create: { elementId: "legacy-line", hidden: true } },
      layerStates: { create: { layerName: "legacy-layer", visible: false, locked: true } } } });
    const candidate = await prisma.floorImportCandidate.create({ data: { jobId: job.id, sourceEntityId: "legacy-slot", layerName: "LIGHT",
      x: 200, y: 300, confidence: 0.95, detectionMethod: "rule_based", reviewStatus: "accepted", reviewedAt: new Date() } });
    const slot = await prisma.floorLightSlot.create({ data: { floorId, sourceImportJobId: job.id, sourceCandidateId: candidate.id,
      assignedFixtureId: fixtureId, x: 200, y: 300 } });
    return { job, scene, slot, manifest, tile, source, rendered };
  }

  it("drops CAD/overrides/layers/slots and U4b job pins in FK-safe order, without permanent old assets", async () => {
    const cad = await seedCad(); const source = await asset("original");
    async function* empty() {}
    const prepared = await store.prepareGeneration(floorId, empty(), { width: 1200, height: 800, gridSize: 10, groups: [], layers: [] });
    const job = await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf",
      preparedMapGenerationId: prepared.generationId, status: "processing", stage: "parsing", progressPercent: 30,
      attemptCount: 3, leaseOwner: "late-worker", leaseExpiresAt: new Date(Date.now() + 60_000), startedAt: new Date() } });
    const tombstone = await prisma.floorImportAttemptCleanup.create({ data: { floorId, jobId: job.id, attemptCount: 3,
      assetId: randomUUID(), objectKey: `floors/${floorId}/${job.id}-attempt-3.svg` } });
    const next = await service.reset(floorId, user, input());
    expect(await prisma.floorImportJob.count({ where: { floorId } })).toBe(0);
    expect(await prisma.floorMapGeneration.findUnique({ where: { id: prepared.generationId } })).toBeNull();
    expect(await prisma.floorCadScene.findUnique({ where: { floorId } })).toBeNull();
    expect(await prisma.floorCadTile.count({ where: { sceneId: cad.scene.id } })).toBe(0);
    expect(await prisma.floorCadElementOverride.count({ where: { sceneId: cad.scene.id } })).toBe(0);
    expect(await prisma.floorCadLayerState.count({ where: { sceneId: cad.scene.id } })).toBe(0);
    expect(await prisma.floorLightSlot.count({ where: { floorId } })).toBe(0);
    expect(await prisma.floorImportAttemptCleanup.findUnique({ where: { jobId_attemptCount: { jobId: job.id, attemptCount: 3 } } })).toEqual(tombstone);
    expect(await prisma.floorAsset.count({ where: { floorId } })).toBeGreaterThan(1);
    expect(storage.deleteObject).not.toHaveBeenCalled();
    await prisma.floorAsset.updateMany({ where: { floorId }, data: { createdAt: new Date(0), readyAt: new Date(0) } });
    await new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never)).processPending();
    expect(await prisma.floorAsset.findMany({ where: { floorId }, select: { id: true } })).toEqual([{ id: next.manifest.assetId }]);
  });

  it("fences a real worker paused during download so it cannot restore an old import after reset", async () => {
    const source = await asset("original");
    const job = await prisma.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, sourceFormat: "dxf" } });
    let entered!: () => void; let release!: () => void;
    const downloading = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const workerStorage = { downloadFloorAssetToFile: async () => { entered(); await resume; } };
    const worker = new FloorImportWorkerService(prisma as never, workerStorage as never, {} as never,
      new FixedLightingDetectorRegistry(), {} as never, { tempRoot: "/tmp", pollIntervalMs: 1000, enabled: false });
    const running = worker.runOnce();
    try {
      await Promise.race([downloading, running.then(() => { throw new Error("worker exited before download barrier"); })]);
      const next = await service.reset(floorId, user, input());
      release(); await running;
      expect(await prisma.floorImportJob.findUnique({ where: { id: job.id } })).toBeNull();
      expect((await state()).document).toMatchObject({ activeGenerationId: next.generationId, revision: 8 });
      expect(await prisma.floorCadScene.findUnique({ where: { floorId } })).toBeNull();
      expect(await prisma.floorImportCandidate.count({ where: { jobId: job.id } })).toBe(0);
    } finally { release(); await running; await worker.onModuleDestroy(); }
  });

  it("exposes an authenticated reset route with 201/replay/409 and read-only rejection", async () => {
    const viewer = await prisma.user.create({ data: { organizationId: user.organizationId, loginId: randomUUID(), name: "HTTP viewer", passwordHash: "unused", role: "viewer" } });
    await prisma.siteMembership.create({ data: { siteId, userId: viewer.id, accessLevel: "read" } });
    const module = await Test.createTestingModule({ controllers: [FloorEditorController], providers: [
      { provide: FloorEditorService, useValue: {} }, { provide: EditorLeaseService, useValue: {} },
      { provide: MapDocumentResetService, useValue: service },
      { provide: AuthService, useValue: { getUserBySessionToken: async (token: string) => {
        if (token === "admin") return user;
        if (token === "viewer") return { ...user, id: viewer.id, role: "viewer" };
        throw new UnauthorizedException();
      } } }
    ] }).compile();
    const app = module.createNestApplication(); await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    const request = input();
    const send = (body: unknown, role?: string) => fetch(`${baseUrl}/floors/${floorId}/editor-reset`, {
      method: "POST", headers: { "content-type": "application/json", ...(role ? { cookie: `${AuthService.sessionCookieName}=${role}` } : {}) }, body: JSON.stringify(body)
    });
    try {
      expect((await send(request)).status).toBe(401);
      const result = await send(request, "admin"); expect(result.status).toBe(201);
      expect(await result.json()).toMatchObject({ revision: 8, elementCount: 0 });
      expect((await send(request, "admin")).status).toBe(201);
      expect((await send({ ...request, baseRevision: 8 }, "admin")).status).toBe(409);
      expect((await send(request, "viewer")).status).toBe(403);
    } finally { await app.close(); }
  });

  it("preserves control groups, mesh identity/membership, schedules, event rules, energy and command rows exactly", async () => {
    const gateway = await prisma.gateway.findFirstOrThrow({ where: { siteId } });
    const node = await prisma.meshNode.create({ data: { gatewayId: gateway.id, meshAddress: "0x0100", serialNumber: randomUUID(), firmwareVersion: "test",
      vehicleSensorCapabilityStatus: "supported", vehicleSensorCapabilityVerifiedAt: new Date(), vehicleSensorCapabilityRevision: 1,
      vehicleSensorServerBound: true, vehicleVendorEventModelBound: true } });
    await prisma.fixture.update({ where: { id: fixtureId }, data: { meshNodeId: node.id, status: "online", brightness: 60, powerOn: true } });
    const group = await prisma.fixtureGroup.create({ data: { siteId, floorId, gatewayId: gateway.id, name: "Actual control group",
      groupFixtures: { create: { fixtureId } } } });
    const meshGroup = await prisma.meshControlGroup.create({ data: { gatewayId: gateway.id, targetType: "fixture_group", targetId: group.id,
      groupAddress: "0xC000", status: "ready", members: { create: { meshNodeId: node.id, subscriptionStatus: "applied" } },
      appliedMembers: { create: { meshNodeId: node.id, meshAddress: node.meshAddress } } } });
    await prisma.lightingSchedule.create({ data: { siteId, gatewayId: gateway.id, name: "Keep schedule", activeFrom: new Date("2026-09-01T00:00:00Z"),
      activeUntil: new Date("2026-10-01T00:00:00Z"), localStartTime: "08:00", localEndTime: "20:00", recurrenceKind: "daily",
      dimmingEnabled: true, brightnessPercent: 60, createdById: user.id, updatedById: user.id, fixtures: { create: { fixtureId } } } });
    await prisma.vehicleEventRule.create({ data: { siteId, gatewayId: gateway.id, name: "Keep event", dimmingEnabled: true, brightnessPercent: 80,
      createdById: user.id, updatedById: user.id, sources: { create: { fixtureId } }, targets: { create: { fixtureId } } } });
    await prisma.fixtureEnergyStateCursor.create({ data: { fixtureId, aggregatedThrough: new Date(), observedStateOccurredAt: new Date(),
      brightness: 60, powerOn: true, ratedWatt: 40, durationRemainders: [] } });
    const evidence = async () => ({
      gateway: await prisma.gateway.findUniqueOrThrow({ where: { id: gateway.id } }),
      node: await prisma.meshNode.findUniqueOrThrow({ where: { id: node.id } }),
      group: await prisma.fixtureGroup.findUniqueOrThrow({ where: { id: group.id }, include: { groupFixtures: true } }),
      meshGroup: await prisma.meshControlGroup.findUniqueOrThrow({ where: { id: meshGroup.id }, include: { members: true, appliedMembers: true } }),
      schedules: await prisma.lightingSchedule.findMany({ where: { siteId }, include: { fixtures: true } }),
      events: await prisma.vehicleEventRule.findMany({ where: { siteId }, include: { sources: true, targets: true } }),
      energy: await prisma.energyUsage.findMany({ where: { fixtureId } }),
      cursor: await prisma.fixtureEnergyStateCursor.findUniqueOrThrow({ where: { fixtureId } }),
      commands: await prisma.command.findMany({ where: { siteId } }),
      targets: await new TargetSnapshotService().resolve(prisma as never, siteId, { type: "group", groupId: group.id })
    });
    const before = await evidence();
    expect(before.schedules[0].fixtures).toHaveLength(1);
    expect(before.events[0].sources).toHaveLength(1); expect(before.events[0].targets).toHaveLength(1);
    expect(before.meshGroup.members).toHaveLength(1); expect(before.group.groupFixtures).toHaveLength(1);
    await service.reset(floorId, user, input());
    expect(await evidence()).toEqual(before);
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).toMatchObject({
      floorId, siteId, gatewayId: gateway.id, meshNodeId: node.id, brightness: 60, powerOn: true, placementStatus: "unplaced", x: 0, y: 0
    });
  });

  it("drops in-flight old preparation asset pins instead of relying on an unscheduled reaper", async () => {
    async function* empty() {}
    let entered!: () => void; let release!: () => void;
    const uploading = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    storage.putCadSceneObjectFile.mockImplementationOnce(async (key, path) => { objects.set(key, await readFile(path)); entered(); await resume; });
    const pending = store.prepareGeneration(floorId, empty(), { width: 1200, height: 800, gridSize: 10, groups: [], layers: [] });
    // Attach rejection immediately so the barrier's release cannot produce an unhandled rejection.
    const outcome = pending.then(ref => ({ ref }), error => ({ error }));
    try {
      await Promise.race([uploading, outcome.then(() => { throw new Error("preparation missed upload barrier"); })]);
      const old = await prisma.floorMapGeneration.findFirstOrThrow({ where: { floorId, status: "preparing" } });
      const next = await service.reset(floorId, user, input());
      expect(await prisma.floorMapGeneration.findUnique({ where: { id: old.id } })).toBeNull();
      release(); expect(await outcome).toHaveProperty("error");
      await prisma.floorAsset.updateMany({ where: { floorId }, data: { createdAt: new Date(0), readyAt: new Date(0), uploadExpiresAt: new Date(0) } });
      await new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never)).processPending();
      expect(await prisma.floorAsset.findMany({ where: { floorId }, select: { id: true } })).toEqual([{ id: next.manifest.assetId }]);
    } finally { release(); await outcome; }
  });

  it("returns the winning result when a concurrent identical reset fences its unfinished preparation", async () => {
    let entered!: () => void; let release!: () => void;
    const uploading = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    storage.putCadSceneObjectFile.mockImplementationOnce(async (key, path) => { objects.set(key, await readFile(path)); entered(); await resume; });
    const request = input(); const pending = service.reset(floorId, user, request);
    const outcome = pending.then(ref => ({ ref }), error => ({ error }));
    try {
      await Promise.race([uploading, outcome.then(() => { throw new Error("reset missed upload barrier"); })]);
      const winner = await service.reset(floorId, user, request);
      release(); expect(await outcome).toEqual({ ref: winner });
      expect(await prisma.floorMapGeneration.count({ where: { floorId } })).toBe(1);
      expect((await state()).floor.mapRevision).toBe(8);
    } finally { release(); await outcome; }
  });

  it("initializes a floor with no CAD, fixtures or history without requiring an import job", async () => {
    const fresh = await prisma.floor.create({ data: { siteId, name: "Empty", level: 3,
      editorLeaseHolderId: user.id, editorLeaseFence: 2, editorLeaseTokenHash: hashEditorLeaseToken("reset-lease"),
      editorLeaseExpiresAt: new Date(Date.now() + 60_000) } });
    const ref = await service.reset(fresh.id, user, { ...input(), baseRevision: 0 });
    expect(ref).toMatchObject({ revision: 1, elementCount: 0, width: 1200, height: 800 });
    expect(await prisma.floorImportJob.count({ where: { floorId: fresh.id } })).toBe(0);
    expect((await store.readManifest(fresh.id, ref)).layers[0].id).toBe("map");
  });

  it.each(["expired", "archived", "different-holder"])("rejects %s authority without mutating the map", async kind => {
    await prisma.floor.update({ where: { id: floorId }, data: kind === "expired" ? { editorLeaseExpiresAt: new Date(0) }
      : kind === "archived" ? { status: "archived" } : { editorLeaseHolderId: "another-user" } });
    const before = await state();
    await expect(service.reset(floorId, user, input())).rejects.toBeInstanceOf(ConflictException);
    expect(await state()).toEqual(before);
  });

  it("rolls back deletion of an active generation and its history pins on commit failure", async () => {
    const previous = await service.reset(floorId, user, input());
    const before = await state();
    const pins = await prisma.floorMapRevisionAsset.findMany({ where: { floorId } });
    const generation = await prisma.floorMapGeneration.findUniqueOrThrow({ where: { id: previous.generationId } });
    jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("commit failed"));
    await expect(service.reset(floorId, user, { ...input(), baseRevision: 8 })).rejects.toThrow("commit failed");
    expect(await state()).toEqual(before);
    expect(await prisma.floorMapRevisionAsset.findMany({ where: { floorId } })).toEqual(pins);
    expect(await prisma.floorMapGeneration.findUniqueOrThrow({ where: { id: previous.generationId } })).toEqual(generation);
    expect((await store.readManifest(floorId, previous)).elementCount).toBe(0);
  });
});
