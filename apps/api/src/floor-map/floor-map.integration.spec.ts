import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { buildCadScene } from "../floor-import/cad-scene-builder";
import { decodeCadSceneTile } from "../floor-import/cad-scene-codec";
import { cadScenePersistenceIdentity } from "../floor-import/cad-scene-persistence";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { FloorMapService } from "./floor-map.service";

const enabled = process.env.FLOOR_MAP_INTEGRATION === "1";
(enabled ? describe : describe.skip)("floor map CAD edit PostgreSQL lifecycle", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let prisma: PrismaClient;
  let service: FloorMapService;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const viewerId = randomUUID();
  const siteId = randomUUID();
  const floorId = randomUUID();
  const leaseToken = "task-6-editor-lease";
  const leaseFence = 3;
  const user = {
    id: userId,
    organizationId,
    organizationType: "customer" as const,
    loginId: "cad-admin",
    name: "CAD Admin",
    role: "admin" as const,
    mustChangePassword: false,
    status: "active" as const
  };
  const viewer = {
    ...user,
    id: viewerId,
    loginId: "cad-viewer",
    name: "CAD Viewer",
    role: "viewer" as const
  };
  const tilePayloads = new Map<string, ReturnType<typeof decodeCadSceneTile>>();
  let evidenceReadTile: jest.Mock;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const databaseUrl = cluster.database();
    const deployed = cluster.deploy(databaseUrl);
    if (deployed.status !== 0) throw new Error(deployed.stderr || deployed.stdout);
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await prisma.organization.create({ data: { id: organizationId, name: "CAD map", type: "customer" } });
    await prisma.user.create({ data: {
      id: userId, organizationId, loginId: user.loginId, name: user.name,
      passwordHash: "unused", role: "admin"
    } });
    await prisma.user.create({ data: {
      id: viewerId, organizationId, loginId: viewer.loginId, name: viewer.name,
      passwordHash: "unused", role: "viewer"
    } });
    await prisma.site.create({ data: {
      id: siteId, organizationId, adminUserId: userId, name: "CAD site", timeZone: "UTC"
    } });
    await prisma.siteMembership.create({ data: { siteId, userId: viewerId, accessLevel: "read" } });
    await prisma.floor.create({ data: { id: floorId, siteId, name: "B2", level: -2 } });
  }, 90_000);

  beforeEach(async () => {
    await prisma.floorImportJob.deleteMany({ where: { floorId } });
    await prisma.floorPlan.deleteMany({ where: { floorId } });
    await prisma.floorAsset.deleteMany({ where: { floorId } });
    await prisma.auditLog.deleteMany({ where: { siteId } });
    await prisma.floor.update({ where: { id: floorId }, data: {
      mapRevision: 0,
      editorLeaseFence: leaseFence,
      editorLeaseTokenHash: hashEditorLeaseToken(leaseToken),
      editorLeaseHolderId: userId,
      editorLeaseHolderName: user.name,
      editorLeaseAcquiredAt: new Date(),
      editorLeaseExpiresAt: new Date(Date.now() + 60_000)
    } });
    tilePayloads.clear();
    await seedScene();
    evidenceReadTile = jest.fn(async ({ objectKey }: { objectKey: string }) => {
      const primitives = tilePayloads.get(objectKey);
      if (!primitives) throw new Error("missing test tile");
      return primitives;
    });
    service = new FloorMapService(
      prisma as never,
      new SiteAccessService(prisma as never),
      { readTile: evidenceReadTile } as never,
      new AuditService(prisma as never)
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    cluster?.stop();
  });

  it("persists a bounded override/layer batch and increments one revision atomically", async () => {
    const scene = await prisma.floorCadScene.findUniqueOrThrow({
      where: { floorId }, include: { tiles: { orderBy: [{ lod: "asc" }, { tileX: "asc" }, { tileY: "asc" }, { part: "asc" }] } }
    });
    const tile = scene.tiles[0];
    const tilePrimitives = [...tilePayloads.values()][0];
    const element = tilePrimitives[0];

    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 0,
      leaseToken,
      leaseFence,
      overrideMutations: [{
        operation: "upsert",
        locator: { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part },
        value: {
          elementId: element.elementId,
          transform: { translateX: 10, translateY: 20, scaleX: 1.2, scaleY: 0.8, rotation: 15 },
          strokeColor: "#112233"
        }
      }],
      layerMutations: [{
        locator: { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part },
        layerName: element.layerName,
        visible: false,
        locked: true
      }]
    })).resolves.toMatchObject({ revision: 1, scene: { id: scene.id } });

    await expect(prisma.floor.findUniqueOrThrow({ where: { id: floorId } }))
      .resolves.toMatchObject({ mapRevision: 1 });
    await expect(prisma.floorCadElementOverride.findUniqueOrThrow({
      where: { sceneId_elementId: { sceneId: scene.id, elementId: element.elementId } }
    })).resolves.toMatchObject({ translateX: 10, translateY: 20, scaleX: 1.2, scaleY: 0.8, rotation: 15 });
    await expect(prisma.floorCadLayerState.findUniqueOrThrow({
      where: { sceneId_layerName: { sceneId: scene.id, layerName: element.layerName } }
    })).resolves.toMatchObject({ visible: false, locked: true });

    await expect(service.getCadSceneState(user, siteId, floorId)).resolves.toMatchObject({
      revision: 1,
      overrides: [{ elementId: element.elementId, strokeColor: "#112233" }],
      layers: [{ layerName: element.layerName, visible: false, locked: true }]
    });

    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 1,
      leaseToken,
      leaseFence,
      overrideMutations: [{
        operation: "delete",
        locator: { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part },
        elementId: element.elementId
      }],
      layerMutations: [{
        locator: { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part },
        layerName: element.layerName,
        visible: true,
        locked: false
      }]
    })).resolves.toMatchObject({ revision: 2, overrides: [], layers: [] });
    await expect(prisma.floor.findUniqueOrThrow({ where: { id: floorId } }))
      .resolves.toMatchObject({ mapRevision: 2 });
  });

  it("rejects stale authority and nonexistent elements without partial writes", async () => {
    const scene = await prisma.floorCadScene.findUniqueOrThrow({ where: { floorId }, include: { tiles: true } });
    const tile = scene.tiles[0];
    const locator = { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part };
    const mutation = {
      operation: "upsert" as const,
      locator,
      value: { elementId: "cad-element-ffffffffffffffffffffffffffffffff", hidden: true }
    };

    const existingElement = [...tilePayloads.values()][0][0].elementId;
    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 0,
      leaseToken: "wrong-lease-token",
      leaseFence,
      overrideMutations: [{ ...mutation, value: { elementId: existingElement, hidden: true } }]
    })).rejects.toBeInstanceOf(ConflictException);
    expect(evidenceReadTile).not.toHaveBeenCalled();

    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 0,
      leaseToken,
      leaseFence: leaseFence + 1,
      overrideMutations: [{ ...mutation, value: { elementId: existingElement, hidden: true } }]
    })).rejects.toBeInstanceOf(ConflictException);
    expect(evidenceReadTile).not.toHaveBeenCalled();

    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 1,
      leaseToken,
      leaseFence,
      overrideMutations: [{ ...mutation, value: { elementId: existingElement, hidden: true } }]
    })).rejects.toBeInstanceOf(ConflictException);
    expect(evidenceReadTile).not.toHaveBeenCalled();

    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 0, leaseToken, leaseFence, overrideMutations: [mutation]
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(evidenceReadTile).toHaveBeenCalledTimes(1);
    await expect(prisma.floor.findUniqueOrThrow({ where: { id: floorId } }))
      .resolves.toMatchObject({ mapRevision: 0 });
    await expect(prisma.floorCadElementOverride.count({ where: { sceneId: scene.id } })).resolves.toBe(0);
  });

  it("rechecks authority in the transaction after evidence validation", async () => {
    const scene = await prisma.floorCadScene.findUniqueOrThrow({ where: { floorId }, include: { tiles: true } });
    const tile = scene.tiles[0];
    const element = [...tilePayloads.values()][0][0];
    evidenceReadTile.mockImplementationOnce(async ({ objectKey }: { objectKey: string }) => {
      const primitives = tilePayloads.get(objectKey);
      if (!primitives) throw new Error("missing test tile");
      await prisma.floor.update({ where: { id: floorId }, data: { mapRevision: 1 } });
      return primitives;
    });

    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 0,
      leaseToken,
      leaseFence,
      overrideMutations: [{
        operation: "upsert",
        locator: { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part },
        value: { elementId: element.elementId, hidden: true }
      }]
    })).rejects.toBeInstanceOf(ConflictException);

    expect(evidenceReadTile).toHaveBeenCalledTimes(1);
    await expect(prisma.floorCadElementOverride.count({ where: { sceneId: scene.id } })).resolves.toBe(0);
  });

  it("does not persist default-only overrides and removes a reverted hidden override", async () => {
    const scene = await prisma.floorCadScene.findUniqueOrThrow({ where: { floorId }, include: { tiles: true } });
    const tile = scene.tiles[0];
    const element = [...tilePayloads.values()][0][0];
    const locator = { tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part };
    const defaults = {
      elementId: element.elementId,
      hidden: false,
      transform: null,
      strokeColor: null,
      fillColor: null,
      strokeWidth: null,
      text: null
    };

    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 0, leaseToken, leaseFence,
      overrideMutations: [{ operation: "upsert", locator, value: defaults }]
    })).resolves.toMatchObject({ revision: 1, overrides: [] });
    await expect(prisma.floorCadElementOverride.count({ where: { sceneId: scene.id } })).resolves.toBe(0);

    await service.editCadScene(user, siteId, floorId, {
      expectedRevision: 1, leaseToken, leaseFence,
      overrideMutations: [{ operation: "upsert", locator, value: { elementId: element.elementId, hidden: true } }]
    });
    await expect(prisma.floorCadElementOverride.findUniqueOrThrow({
      where: { sceneId_elementId: { sceneId: scene.id, elementId: element.elementId } }
    })).resolves.toMatchObject({ hidden: true });

    await expect(service.editCadScene(user, siteId, floorId, {
      expectedRevision: 2, leaseToken, leaseFence,
      overrideMutations: [{
        operation: "upsert",
        locator,
        value: { elementId: element.elementId, hidden: false }
      }]
    })).resolves.toMatchObject({ revision: 3, overrides: [] });
    await expect(prisma.floorCadElementOverride.count({ where: { sceneId: scene.id } })).resolves.toBe(0);
  });

  it("rejects invalid tenant and role before reading evidence", async () => {
    const otherOrganizationId = randomUUID();
    const otherUserId = randomUUID();
    await prisma.organization.create({ data: { id: otherOrganizationId, name: "Other", type: "customer" } });
    await prisma.user.create({ data: {
      id: otherUserId, organizationId: otherOrganizationId, loginId: `other-${otherUserId}`,
      name: "Other Admin", passwordHash: "unused", role: "admin"
    } });
    const otherUser = { ...user, id: otherUserId, organizationId: otherOrganizationId, loginId: `other-${otherUserId}` };

    await expect(service.getCadSceneState(otherUser, siteId, floorId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.editCadScene(otherUser, siteId, floorId, {
      expectedRevision: 0, leaseToken, leaseFence,
      layerMutations: [{ locator: { tileX: 0, tileY: 0, lod: 0, part: 0 }, layerName: "WALL", visible: true, locked: false }]
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(evidenceReadTile).not.toHaveBeenCalled();

    await expect(service.editCadScene(viewer, siteId, floorId, {
      expectedRevision: 0, leaseToken, leaseFence,
      layerMutations: [{ locator: { tileX: 0, tileY: 0, lod: 0, part: 0 }, layerName: "WALL", visible: true, locked: false }]
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(evidenceReadTile).not.toHaveBeenCalled();
  });

  async function seedScene() {
    const sourceAssetId = randomUUID();
    await prisma.floorAsset.create({ data: {
      id: sourceAssetId,
      floorId,
      kind: "original",
      status: "ready",
      objectKey: `floors/${floorId}/${sourceAssetId}.dxf`,
      mimeType: "application/dxf",
      sizeBytes: 128n,
      sha256: "a".repeat(64),
      readyAt: new Date()
    } });
    const job = await prisma.floorImportJob.create({ data: {
      floorId, sourceAssetId, sourceFormat: "dxf", status: "queued", stage: "queued"
    } });
    const regionId = "region-task-6-000000000000000000";
    const region = await prisma.floorImportRegion.create({ data: {
      jobId: job.id,
      regionId,
      minX: 0,
      minY: 0,
      maxX: 1_000,
      maxY: 500,
      primitiveCount: 2,
      selectedAt: new Date()
    } });
    const identity = cadScenePersistenceIdentity(job.id, regionId);
    const built = buildCadScene({
      version: 1,
      bounds: { minX: 0, minY: 0, maxX: 1_000, maxY: 500 },
      blocks: [],
      entities: [
        { type: "line", sourceEntityId: "wall-1", layer: "WALL", start: { x: 10, y: 10, z: 0 }, end: { x: 490, y: 10, z: 0 } },
        { type: "line", sourceEntityId: "wall-2", layer: "WALL", start: { x: 10, y: 40, z: 0 }, end: { x: 490, y: 40, z: 0 } }
      ]
    }, {
      regionId,
      bounds: { minX: 0, minY: 0, maxX: 1_000, maxY: 500 },
      primitiveCount: 2,
      textCount: 0,
      lightCandidateCount: 0,
      area: 500_000
    }, {
      sceneId: identity.sceneId,
      manifestAssetId: identity.manifestAssetId,
      tileAssetId: identity.tileAssetId
    });
    await prisma.floorAsset.createMany({ data: [
      {
        id: built.manifest.manifestAssetId,
        floorId,
        kind: "cad_manifest",
        status: "ready",
        objectKey: identity.manifestObjectKey(floorId),
        mimeType: "application/json",
        sizeBytes: BigInt(built.manifest.byteSize),
        sha256: built.manifest.sha256,
        readyAt: new Date()
      },
      ...built.tiles.map(({ descriptor }) => ({
        id: descriptor.assetId,
        floorId,
        kind: "cad_tile" as const,
        status: "ready" as const,
        objectKey: identity.tileObjectKey(floorId, descriptor),
        mimeType: "application/vnd.led-control.cad-tile",
        sizeBytes: BigInt(descriptor.byteSize),
        sha256: descriptor.sha256,
        readyAt: new Date()
      }))
    ] });
    for (const tile of built.tiles) {
      tilePayloads.set(identity.tileObjectKey(floorId, tile.descriptor), decodeCadSceneTile(tile.payload));
    }
    await prisma.floorPlan.create({ data: {
      floorId,
      imageUrl: "",
      sourceType: "cad",
      originalFileUrl: null,
      renderedImageUrl: null,
      width: built.manifest.width,
      height: built.manifest.height,
      gridSize: built.manifest.gridSize
    } });
    await prisma.floorCadScene.create({ data: {
      id: built.manifest.sceneId,
      floorId,
      sourceImportJobId: job.id,
      sourceRegionId: region.id,
      version: 1,
      status: "active",
      width: built.manifest.width,
      height: built.manifest.height,
      tileSize: built.manifest.tileSize,
      primitiveCount: built.manifest.primitiveCount,
      tileCount: built.manifest.tileCount,
      manifestAssetId: built.manifest.manifestAssetId,
      sourceMinX: built.manifest.sourceBounds.minX,
      sourceMinY: built.manifest.sourceBounds.minY,
      sourceMaxX: built.manifest.sourceBounds.maxX,
      sourceMaxY: built.manifest.sourceBounds.maxY,
      transformScaleX: built.manifest.transform.scaleX,
      transformScaleY: built.manifest.transform.scaleY,
      transformTranslateX: built.manifest.transform.translateX,
      transformTranslateY: built.manifest.transform.translateY,
      tiles: { create: built.tiles.map(({ descriptor }) => ({
        tileX: descriptor.tileX,
        tileY: descriptor.tileY,
        lod: descriptor.lod,
        part: descriptor.part,
        assetId: descriptor.assetId,
        primitiveCount: descriptor.primitiveCount,
        byteSize: BigInt(descriptor.byteSize),
        minX: descriptor.bounds.minX,
        minY: descriptor.bounds.minY,
        maxX: descriptor.bounds.maxX,
        maxY: descriptor.bounds.maxY
      })) }
    } });
  }
});
