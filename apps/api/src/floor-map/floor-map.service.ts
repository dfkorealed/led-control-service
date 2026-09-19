import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  CAD_SCENE_MAX_EVIDENCE_BYTES,
  CAD_SCENE_MAX_PERSISTED_LAYER_STATES,
  CAD_SCENE_MAX_PERSISTED_OVERRIDES,
  type CadElementOverridePatch,
  type CadSceneEditInput,
  type CadSceneElementLocator,
  buildCadSceneDescriptor,
  cadSceneEditInputSchema,
  cadSceneLocatorKey,
  cadSceneStateSchema,
  floorMapSnapshotSchema
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { EDITOR_TRANSACTION_OPTIONS } from "../floor-editor/floor-editor.service";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { assertActiveFloorStatus } from "../floor-editor/floor-lifecycle";
import { PrismaService } from "../prisma/prisma.service";
import { CadSceneEvidenceService, type CadSceneEvidenceTile } from "./cad-scene-evidence.service";

const DEFAULT_CANVAS_WIDTH = 1200;
const DEFAULT_CANVAS_HEIGHT = 800;

type SceneDescriptorRow = {
  id: string;
  version: number;
  sourceImportJobId: string;
  width: number;
  height: number;
  tileSize: number;
  primitiveCount: number;
  tileCount: number;
  manifestAssetId: string;
};

type EvidenceRow = CadSceneEvidenceTile & CadSceneElementLocator & { assetId: string };

type CadOverrideRow = {
  elementId: string;
  hidden: boolean | null;
  translateX: number | null;
  translateY: number | null;
  scaleX: number | null;
  scaleY: number | null;
  rotation: number | null;
  strokeColor: string | null;
  fillColor: string | null;
  strokeWidth: number | null;
  text: string | null;
  locatorTileX: number | null;
  locatorTileY: number | null;
  locatorLod: number | null;
  locatorPart: number | null;
};

type FloorEditAuthorityRow = {
  status: string;
  mapRevision: number;
  editorLeaseFence: number;
  editorLeaseTokenHash: string | null;
  editorLeaseExpiresAt: Date | null;
  dbNow: Date;
};

@Injectable()
export class FloorMapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    @Optional() private readonly evidence?: CadSceneEvidenceService,
    @Optional() private readonly audit?: AuditService
  ) {}

  async getSnapshot(user: AuthenticatedUser, siteId: string, floorId: string) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: floorId, siteId },
      include: {
        floorPlan: true,
        cadScene: true,
        mapObjects: {
          where: { visible: true },
          orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }]
        },
        fixtures: {
          where: { placementStatus: "placed" },
          orderBy: { id: "asc" },
          select: {
            id: true,
            name: true,
            x: true,
            y: true,
            size: true,
            lightSlot: { select: { id: true, x: true, y: true } }
          }
        }
      }
    });
    if (!floor) throw this.floorNotFound();
    await this.assertAccess(user, siteId, "read");

    return floorMapSnapshotSchema.parse({
      floorId: floor.id,
      revision: floor.mapRevision,
      width: floor.floorPlan?.width ?? DEFAULT_CANVAS_WIDTH,
      height: floor.floorPlan?.height ?? DEFAULT_CANVAS_HEIGHT,
      floorPlan: floor.floorPlan
        ? {
            imageUrl: floor.floorPlan.imageUrl,
            sourceType: floor.floorPlan.sourceType,
            originalFileUrl: floor.floorPlan.originalFileUrl,
            renderedImageUrl: floor.floorPlan.renderedImageUrl,
            width: floor.floorPlan.width,
            height: floor.floorPlan.height,
            gridSize: floor.floorPlan.gridSize ?? 10
          }
        : null,
      cadScene: floor.floorPlan?.sourceType === "cad" && floor.cadScene
        ? buildCadSceneDescriptor(siteId, floorId, floor.cadScene)
        : null,
      objects: floor.mapObjects.map((object) => ({
        id: object.id,
        type: object.type,
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
        rotation: object.rotation,
        points: object.points,
        text: object.text,
        strokeColor: object.strokeColor,
        fillColor: object.fillColor,
        strokeWidth: object.strokeWidth,
        fontSize: object.fontSize,
        zIndex: object.zIndex,
        locked: object.locked,
        visible: object.visible
      })),
      fixtures: floor.fixtures.map((fixture) => {
        const layout = fixture.lightSlot ?? fixture;
        return { id: fixture.id, name: fixture.name, x: layout.x, y: layout.y, size: fixture.size };
      })
    });
  }

  async getCadSceneState(user: AuthenticatedUser, siteId: string, floorId: string) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: floorId, siteId },
      select: {
        id: true,
        siteId: true,
        mapRevision: true,
        floorPlan: { select: { sourceType: true } },
        cadScene: {
          include: {
            elementOverrides: { orderBy: { elementId: "asc" } },
            layerStates: { orderBy: { layerName: "asc" } }
          }
        }
      }
    });
    if (!floor) throw this.floorNotFound();
    await this.assertAccess(user, siteId, "read");
    if (floor.floorPlan?.sourceType !== "cad" || !floor.cadScene || floor.cadScene.status !== "active") {
      throw new NotFoundException("CAD scene not found");
    }
    return this.toCadSceneState(siteId, floorId, floor.mapRevision, floor.cadScene);
  }

  async editCadScene(user: AuthenticatedUser, siteId: string, floorId: string, rawInput: unknown) {
    await this.assertAccess(user, siteId, "manage");
    const input = this.parseEditInput(rawInput);
    await this.preflightFloorAuthority(siteId, floorId, input);
    if (!this.audit) throw new ServiceUnavailableException("CAD scene audit is unavailable");
    const evidence = await this.validateEvidence(floorId, input);

    try {
      return await this.prisma.$transaction(async tx => {
        const authorizedSite = await this.siteAccess.assertManageInTransaction(tx, user, siteId);
        const lockedFloor = await this.lockFloorAuthority(tx, floorId);
        if (!lockedFloor) throw this.floorNotFound();
        this.assertFloorEditAuthority(lockedFloor, input);

        await this.assertLockedEvidence(tx, floorId, evidence.sceneId, evidence.rows);
        await this.applyOverrideMutations(tx, evidence.sceneId, input.overrideMutations);
        await this.applyLayerMutations(tx, evidence.sceneId, input.layerMutations);

        const overrideCount = await tx.floorCadElementOverride.count({ where: { sceneId: evidence.sceneId } });
        const layerCount = await tx.floorCadLayerState.count({ where: { sceneId: evidence.sceneId } });
        if (overrideCount > CAD_SCENE_MAX_PERSISTED_OVERRIDES ||
            layerCount > CAD_SCENE_MAX_PERSISTED_LAYER_STATES) {
          throw new BadRequestException("CAD scene persisted edit limit exceeded");
        }

        await tx.floor.update({ where: { id: floorId }, data: { mapRevision: { increment: 1 } } });
        const revision = input.expectedRevision + 1;
        await this.audit!.record({
          organizationId: authorizedSite.organizationId,
          siteId: authorizedSite.id,
          actorId: user.id,
          action: "floor_cad_scene.edited",
          targetType: "floor_cad_scene",
          targetId: evidence.sceneId,
          outcome: "success",
          metadata: {
            floorId,
            revision,
            overrideMutations: input.overrideMutations.length,
            layerMutations: input.layerMutations.length
          },
          transaction: tx
        });

        const scene = await tx.floorCadScene.findUniqueOrThrow({
          where: { id: evidence.sceneId },
          include: {
            elementOverrides: { orderBy: { elementId: "asc" } },
            layerStates: { orderBy: { layerName: "asc" } }
          }
        });
        return this.toCadSceneState(siteId, floorId, revision, scene);
      }, EDITOR_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        throw new ConflictException("CAD scene edit conflicted, reload and retry");
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028") {
        throw new ServiceUnavailableException("CAD scene edit transaction timed out");
      }
      throw error;
    }
  }

  private async validateEvidence(floorId: string, input: CadSceneEditInput) {
    if (!this.evidence) throw new ServiceUnavailableException("CAD scene evidence reader is unavailable");
    const locators = this.uniqueLocators(input);
    const scene = await this.prisma.floorCadScene.findUnique({
      where: { floorId },
      include: {
        tiles: {
          where: { OR: locators.map(locator => ({ ...locator })) },
          include: { asset: true }
        }
      }
    });
    if (!scene || scene.status !== "active") throw new NotFoundException("CAD scene not found");

    const rows: EvidenceRow[] = scene.tiles.map(tile => ({
      tileX: tile.tileX,
      tileY: tile.tileY,
      lod: tile.lod as 0 | 1 | 2,
      part: tile.part,
      assetId: tile.assetId,
      objectKey: tile.asset.objectKey,
      byteSize: Number(tile.byteSize),
      sha256: tile.asset.sha256,
      bounds: { minX: tile.minX, minY: tile.minY, maxX: tile.maxX, maxY: tile.maxY }
    }));
    if (rows.some(row => !row.objectKey.startsWith(`floors/${floorId}/`))) {
      throw new ConflictException("CAD scene evidence ledger is invalid");
    }
    const rowByKey = new Map(rows.map(row => [cadSceneLocatorKey(row), row]));
    if (rowByKey.size !== locators.length || locators.some(locator => !rowByKey.has(cadSceneLocatorKey(locator)))) {
      throw new BadRequestException("CAD scene evidence tile not found");
    }
    const totalBytes = rows.reduce((sum, row) => sum + row.byteSize, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > CAD_SCENE_MAX_EVIDENCE_BYTES) {
      throw new BadRequestException("CAD scene evidence byte limit exceeded");
    }

    const requiredElements = new Map<string, Set<string>>();
    const requiredLayers = new Map<string, Set<string>>();
    for (const mutation of input.overrideMutations) {
      const key = cadSceneLocatorKey(mutation.locator);
      const elementId = mutation.operation === "upsert" ? mutation.value.elementId : mutation.elementId;
      const ids = requiredElements.get(key) ?? new Set<string>();
      ids.add(elementId);
      requiredElements.set(key, ids);
    }
    for (const mutation of input.layerMutations) {
      const key = cadSceneLocatorKey(mutation.locator);
      const layers = requiredLayers.get(key) ?? new Set<string>();
      layers.add(mutation.layerName);
      requiredLayers.set(key, layers);
    }
    try {
      for (const locator of locators) {
        const key = cadSceneLocatorKey(locator);
        const primitives = await this.evidence.readTile(rowByKey.get(key)!);
        const elementIds = new Set(primitives.map(primitive => primitive.elementId));
        const layerNames = new Set(primitives.map(primitive => primitive.layerName));
        if ([...(requiredElements.get(key) ?? [])].some(elementId => !elementIds.has(elementId))) {
          throw new BadRequestException("CAD scene element does not exist in the evidence tile");
        }
        if ([...(requiredLayers.get(key) ?? [])].some(layerName => !layerNames.has(layerName))) {
          throw new BadRequestException("CAD scene layer does not exist in the evidence tile");
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException("CAD scene evidence is unavailable");
    }
    return { sceneId: scene.id, rows };
  }

  private uniqueLocators(input: CadSceneEditInput): CadSceneElementLocator[] {
    const byKey = new Map<string, CadSceneElementLocator>();
    for (const locator of [
      ...input.overrideMutations.map(mutation => mutation.locator),
      ...input.layerMutations.map(mutation => mutation.locator)
    ]) byKey.set(cadSceneLocatorKey(locator), locator);
    return [...byKey.values()];
  }

  private async preflightFloorAuthority(siteId: string, floorId: string, input: CadSceneEditInput) {
    const rows = await this.prisma.$queryRaw<FloorEditAuthorityRow[]>(Prisma.sql`
      SELECT "status"::text AS "status", "mapRevision", "editorLeaseFence",
        "editorLeaseTokenHash", "editorLeaseExpiresAt", clock_timestamp() AS "dbNow"
      FROM "Floor"
      WHERE "id" = ${floorId} AND "siteId" = ${siteId}
    `);
    const floor = rows[0];
    if (!floor) throw this.floorNotFound();
    this.assertFloorEditAuthority(floor, input);
  }

  private assertFloorEditAuthority(floor: FloorEditAuthorityRow, input: CadSceneEditInput) {
    assertActiveFloorStatus(floor.status);
    if (floor.editorLeaseFence !== input.leaseFence ||
        floor.editorLeaseTokenHash !== hashEditorLeaseToken(input.leaseToken) ||
        !floor.editorLeaseExpiresAt ||
        floor.editorLeaseExpiresAt.getTime() <= floor.dbNow.getTime()) {
      throw new ConflictException("floor editor lease is no longer active");
    }
    if (floor.mapRevision !== input.expectedRevision) {
      throw new ConflictException("floor editor revision conflict");
    }
  }

  private async lockFloorAuthority(tx: Prisma.TransactionClient, floorId: string) {
    const rows = await tx.$queryRaw<FloorEditAuthorityRow[]>(Prisma.sql`
      SELECT "status"::text AS "status", "mapRevision", "editorLeaseFence",
        "editorLeaseTokenHash", "editorLeaseExpiresAt", clock_timestamp() AS "dbNow"
      FROM "Floor"
      WHERE "id" = ${floorId}
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  private async assertLockedEvidence(
    tx: Prisma.TransactionClient,
    floorId: string,
    sceneId: string,
    expectedRows: EvidenceRow[]
  ) {
    const predicates = expectedRows.map(row => Prisma.sql`(
      tile."tileX" = ${row.tileX} AND tile."tileY" = ${row.tileY} AND
      tile."lod" = ${row.lod} AND tile."part" = ${row.part}
    )`);
    const rows = await tx.$queryRaw<Array<{
      sceneId: string;
      status: string;
      tileX: number;
      tileY: number;
      lod: number;
      part: number;
      assetId: string;
      objectKey: string;
      byteSize: bigint;
      assetSizeBytes: bigint;
      sha256: string;
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      assetKind: string;
      assetStatus: string;
      mimeType: string;
      cleanupStartedAt: Date | null;
    }>>(Prisma.sql`
      SELECT scene."id" AS "sceneId", scene."status", tile."tileX", tile."tileY", tile."lod", tile."part",
        tile."assetId", asset."objectKey", tile."byteSize", asset."sizeBytes" AS "assetSizeBytes",
        asset."sha256", tile."minX", tile."minY", tile."maxX", tile."maxY",
        asset."kind"::text AS "assetKind", asset."status"::text AS "assetStatus",
        asset."mimeType", asset."cleanupStartedAt"
      FROM "FloorCadScene" AS scene
      JOIN "FloorCadTile" AS tile ON tile."sceneId" = scene."id"
      JOIN "FloorAsset" AS asset ON asset."id" = tile."assetId"
      WHERE scene."id" = ${sceneId} AND scene."floorId" = ${floorId}
        AND (${Prisma.join(predicates, " OR ")})
      ORDER BY tile."lod", tile."tileX", tile."tileY", tile."part"
      FOR UPDATE OF scene
      FOR SHARE OF tile, asset
    `);
    const actualByKey = new Map(rows.map(row => [cadSceneLocatorKey({
      tileX: row.tileX, tileY: row.tileY, lod: row.lod as 0 | 1 | 2, part: row.part
    }), row]));
    if (rows.length !== expectedRows.length || rows.some(row => row.status !== "active") ||
        expectedRows.some(expected => {
          const actual = actualByKey.get(cadSceneLocatorKey(expected));
          return !actual || actual.sceneId !== sceneId || actual.assetId !== expected.assetId ||
            actual.objectKey !== expected.objectKey || actual.byteSize !== BigInt(expected.byteSize) ||
            actual.assetSizeBytes !== BigInt(expected.byteSize) || actual.sha256 !== expected.sha256 ||
            actual.minX !== expected.bounds.minX || actual.minY !== expected.bounds.minY ||
            actual.maxX !== expected.bounds.maxX || actual.maxY !== expected.bounds.maxY ||
            actual.assetKind !== "cad_tile" || actual.assetStatus !== "ready" ||
            actual.mimeType !== "application/vnd.led-control.cad-tile" || actual.cleanupStartedAt !== null;
        })) {
      throw new ConflictException("CAD scene evidence changed concurrently");
    }
  }

  private async applyOverrideMutations(
    tx: Prisma.TransactionClient,
    sceneId: string,
    mutations: CadSceneEditInput["overrideMutations"]
  ) {
    if (mutations.length === 0) return;
    const elementIds = mutations.map(mutation =>
      mutation.operation === "upsert" ? mutation.value.elementId : mutation.elementId);
    const existing = await tx.floorCadElementOverride.findMany({ where: { sceneId, elementId: { in: elementIds } } });
    const existingById = new Map(existing.map(row => [row.elementId, row]));

    for (const mutation of mutations) {
      if (mutation.operation === "delete") {
        await tx.floorCadElementOverride.deleteMany({ where: { sceneId, elementId: mutation.elementId } });
        continue;
      }
      const row = this.mergeOverride(existingById.get(mutation.value.elementId), mutation.value);
      if (!this.hasPersistedOverride(row)) {
        await tx.floorCadElementOverride.deleteMany({ where: { sceneId, elementId: mutation.value.elementId } });
        continue;
      }
      await tx.floorCadElementOverride.upsert({
        where: { sceneId_elementId: { sceneId, elementId: mutation.value.elementId } },
        create: {
          sceneId,
          elementId: mutation.value.elementId,
          ...row,
          ...this.locatorColumns(mutation.locator)
        },
        update: { ...row, ...this.locatorColumns(mutation.locator) }
      });
    }
  }

  private mergeOverride(existing: CadOverrideRow | undefined, patch: CadElementOverridePatch) {
    const currentTransform = this.readPersistedTransform(existing);
    const transform = patch.transform === undefined ? currentTransform : patch.transform;
    const hidden = patch.hidden === undefined ? existing?.hidden ?? null : patch.hidden;
    return {
      hidden: hidden === true ? true : null,
      translateX: transform?.translateX ?? null,
      translateY: transform?.translateY ?? null,
      scaleX: transform?.scaleX ?? null,
      scaleY: transform?.scaleY ?? null,
      rotation: transform?.rotation ?? null,
      strokeColor: patch.strokeColor === undefined ? existing?.strokeColor ?? null : patch.strokeColor,
      fillColor: patch.fillColor === undefined ? existing?.fillColor ?? null : patch.fillColor,
      strokeWidth: patch.strokeWidth === undefined ? existing?.strokeWidth ?? null : patch.strokeWidth,
      text: patch.text === undefined ? existing?.text ?? null : patch.text
    };
  }

  private readPersistedTransform(existing: CadOverrideRow | undefined) {
    if (!existing) return null;
    const values = [existing.translateX, existing.translateY, existing.scaleX, existing.scaleY, existing.rotation];
    if (values.every(value => value === null)) return null;
    if (values.some(value => value === null)) throw new ConflictException("persisted CAD element transform is invalid");
    return {
      translateX: existing.translateX!,
      translateY: existing.translateY!,
      scaleX: existing.scaleX!,
      scaleY: existing.scaleY!,
      rotation: existing.rotation!
    };
  }

  private hasPersistedOverride(row: ReturnType<FloorMapService["mergeOverride"]>) {
    return Object.values(row).some(value => value !== null);
  }

  private locatorColumns(locator: CadSceneElementLocator) {
    return {
      locatorTileX: locator.tileX,
      locatorTileY: locator.tileY,
      locatorLod: locator.lod,
      locatorPart: locator.part
    };
  }

  private readPersistedLocator(row: CadOverrideRow): CadSceneElementLocator | null {
    const values = [row.locatorTileX, row.locatorTileY, row.locatorLod, row.locatorPart];
    if (values.every(value => value === null)) return null;
    if (values.some(value => value === null)) throw new ConflictException("persisted CAD element locator is invalid");
    return {
      tileX: row.locatorTileX!,
      tileY: row.locatorTileY!,
      lod: row.locatorLod! as 0 | 1 | 2,
      part: row.locatorPart!
    };
  }

  private async applyLayerMutations(
    tx: Prisma.TransactionClient,
    sceneId: string,
    mutations: CadSceneEditInput["layerMutations"]
  ) {
    for (const mutation of mutations) {
      if (mutation.visible && !mutation.locked) {
        await tx.floorCadLayerState.deleteMany({ where: { sceneId, layerName: mutation.layerName } });
        continue;
      }
      await tx.floorCadLayerState.upsert({
        where: { sceneId_layerName: { sceneId, layerName: mutation.layerName } },
        create: { sceneId, layerName: mutation.layerName, visible: mutation.visible, locked: mutation.locked },
        update: { visible: mutation.visible, locked: mutation.locked }
      });
    }
  }

  private toCadSceneState(
    siteId: string,
    floorId: string,
    revision: number,
    scene: SceneDescriptorRow & {
      elementOverrides: CadOverrideRow[];
      layerStates: Array<{ layerName: string; visible: boolean; locked: boolean }>;
    }
  ) {
    return cadSceneStateSchema.parse({
      revision,
      scene: buildCadSceneDescriptor(siteId, floorId, scene),
      overrides: scene.elementOverrides.map(row => ({
        elementId: row.elementId,
        locator: this.readPersistedLocator(row),
        hidden: row.hidden ?? false,
        transform: this.readPersistedTransform(row),
        strokeColor: row.strokeColor,
        fillColor: row.fillColor,
        strokeWidth: row.strokeWidth,
        text: row.text
      })),
      layers: scene.layerStates.map(row => ({
        layerName: row.layerName,
        visible: row.visible,
        locked: row.locked
      }))
    });
  }

  private parseEditInput(rawInput: unknown): CadSceneEditInput {
    try {
      return cadSceneEditInputSchema.parse(rawInput);
    } catch {
      throw new BadRequestException("invalid CAD scene edit payload");
    }
  }

  private async assertAccess(user: AuthenticatedUser, siteId: string, capability: "read" | "manage") {
    try {
      return await this.siteAccess.assert(user, siteId, capability);
    } catch (error) {
      if (error instanceof NotFoundException) throw this.floorNotFound();
      throw error;
    }
  }

  private floorNotFound() {
    return new NotFoundException("floor not found");
  }
}
