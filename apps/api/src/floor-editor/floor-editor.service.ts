import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  FloorEditorSnapshot,
  SaveEditorStateInput,
  editorRevisionListQuerySchema,
  floorMapObjectGeometrySchema,
  parseFloorEditorSnapshot,
  positivePostgresIntSchema,
  restoreFloorEditorRevisionSchema,
  saveEditorStateSchema
} from "@led-control/shared";
import { FloorPlanSourceType, Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { buildFloorEditorSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";
import { FixtureEnergyCheckpointService } from "../energy/fixture-state-ingestion.service";

interface UpdateFloorPlanInput {
  imageUrl?: string;
  sourceType?: FloorPlanSourceType;
  originalFileUrl?: string | null;
  renderedImageUrl?: string | null;
  width?: number;
  height?: number;
}

interface UpdateFixtureInput {
  name?: string;
  ratedWatt?: number | string;
  x?: number;
  y?: number;
  size?: number;
}

interface CreateObjectInput {
  floorId: string;
  type: string;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  rotation?: number;
  points?: unknown;
  text?: string | null;
  strokeColor?: string;
  fillColor?: string | null;
  strokeWidth?: number;
  fontSize?: number | null;
  zIndex?: number;
  locked?: boolean;
  visible?: boolean;
}

interface UpdateObjectInput {
  type?: string;
  x?: number;
  y?: number;
  width?: number | null;
  height?: number | null;
  rotation?: number;
  points?: unknown;
  text?: string | null;
  strokeColor?: string;
  fillColor?: string | null;
  strokeWidth?: number;
  fontSize?: number | null;
  zIndex?: number;
  locked?: boolean;
  visible?: boolean;
}

type FloorPlanData = {
  imageUrl?: string;
  sourceType?: FloorPlanSourceType;
  originalFileUrl?: string | null;
  renderedImageUrl?: string | null;
  width?: number;
  height?: number;
};

type CompleteFloorPlanData = {
  imageUrl: string;
  sourceType: "image" | "pdf";
  originalFileUrl: string;
  renderedImageUrl: string;
  width: number;
  height: number;
};

interface PreparedSaveEditorState {
  expectedRevision: number;
  leaseToken: string;
  leaseFence: number;
  floorPlan?: CompleteFloorPlanData | null;
  fixtureUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  objectCreates: Prisma.FloorMapObjectUncheckedCreateInput[];
  objectUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  objectDeletes: string[];
}

interface LockedFloorLeaseAuthority {
  mapRevision: number;
  editorLeaseFence: number;
  editorLeaseTokenHash: string | null;
  editorLeaseExpiresAt: Date | null;
  dbNow: Date;
}

@Injectable()
export class FloorEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly auditService: AuditService,
    private readonly energyCheckpoint: FixtureEnergyCheckpointService = new FixtureEnergyCheckpointService()
  ) {}

  async getEditorState(floorId: string, user: AuthenticatedUser) {
    const floor = await this.prisma.floor.findUnique({
      where: { id: floorId },
      include: {
        floorPlan: true,
        fixtures: { orderBy: { name: "asc" } },
        mapObjects: { orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }] }
      }
    });
    if (!floor) throw new NotFoundException("floor not found");
    await this.siteAccess.assert(user, floor.siteId, "read");

    return this.toEditorState(floor);
  }

  async saveEditorState(user: AuthenticatedUser, floorId: string, rawInput: unknown) {
    const access = await this.assertExistingFloor(floorId, user, "manage");
    const input = this.parseInput(saveEditorStateSchema, rawInput, "invalid floor editor save payload");
    this.assertUniqueMutationIds(input);
    const prepared = this.prepareSaveInput(floorId, input);
    await this.preflightObjectUpdates(floorId, prepared.objectUpdates);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const authorizedSite = await this.siteAccess.assertManageInTransaction(tx, user, access.siteId);
        await this.assertAtomicSaveTargets(tx, floorId, prepared);
        const changedAt = await this.incrementRevision(tx, floorId, prepared.expectedRevision, prepared.leaseToken, prepared.leaseFence);
        await this.applySaveChanges(tx, floorId, prepared, changedAt);

        const floor = await this.loadSnapshotFloor(tx, floorId);
        const snapshot = this.buildSnapshot(floor);
        const changeSummary = this.saveChangeSummary(prepared);
        await this.createRevision(tx, {
          floorId,
          revision: prepared.expectedRevision + 1,
          snapshot,
          changeSummary,
          changedBy: user.id
        });
        await this.auditService.record({
          organizationId: authorizedSite.organizationId,
          siteId: authorizedSite.id,
          actorId: user.id,
          action: "floor_editor.saved",
          targetType: "floor",
          targetId: floorId,
          outcome: "success",
          metadata: {
            revision: prepared.expectedRevision + 1,
            snapshotSha256: hashFloorEditorSnapshot(snapshot),
            changeSummary
          },
          transaction: tx
        });

        return this.toEditorState(floor);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwMappedTransactionError(error);
      throw error;
    }
  }

  async listEditorRevisions(user: AuthenticatedUser, floorId: string, rawQuery: unknown = {}) {
    const access = await this.assertExistingFloor(floorId, user, "read");
    const query = this.parseInput(editorRevisionListQuerySchema, rawQuery, "invalid revision list query");
    const rows = await this.prisma.floorMapRevision.findMany({
      where: { floorId, ...(query.cursor === undefined ? {} : { revision: { lt: query.cursor } }) },
      orderBy: { revision: "desc" },
      take: query.limit + 1,
      select: {
        revision: true,
        snapshotSha256: true,
        changeSummary: true,
        restoredFromRevision: true,
        createdAt: true,
        user: { select: { name: true, organizationId: true } }
      }
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) => ({
      revision: row.revision,
      snapshotSha256: row.snapshotSha256,
      changeSummary: row.changeSummary,
      restoredFromRevision: row.restoredFromRevision,
      createdAt: row.createdAt,
      actor: {
        displayName: row.user.organizationId === access.organizationId ? row.user.name : "서비스 운영자"
      }
    }));
    return {
      items,
      nextCursor: hasMore && items.length > 0 ? items[items.length - 1].revision : null
    };
  }

  async restoreEditorRevision(
    user: AuthenticatedUser,
    floorId: string,
    revision: unknown,
    rawInput: unknown
  ) {
    const access = await this.assertExistingFloor(floorId, user, "manage");
    const parsedRevision = this.parseInput(
      positivePostgresIntSchema,
      revision,
      "revision must be a positive PostgreSQL integer"
    );
    const input = this.parseInput(
      restoreFloorEditorRevisionSchema,
      rawInput,
      "invalid floor editor restore payload"
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const authorizedSite = await this.siteAccess.assertManageInTransaction(tx, user, access.siteId);
        const source = await tx.floorMapRevision.findUnique({
          where: { floorId_revision: { floorId, revision: parsedRevision } },
          select: { revision: true, snapshot: true }
        });
        if (!source) throw new NotFoundException("floor revision not found");

        const snapshot = this.parseSnapshot(source.snapshot);
        await this.assertSnapshotAssetsReady(tx, floorId, snapshot);
        const existingFixtureIds = await this.existingFixtureIds(tx, floorId, snapshot.fixtures.map((fixture) => fixture.id));
        const skippedFixtureIds = snapshot.fixtures
          .map((fixture) => fixture.id)
          .filter((fixtureId) => !existingFixtureIds.has(fixtureId))
          .sort();

        const changedAt = await this.incrementRevision(tx, floorId, input.expectedRevision, input.leaseToken, input.leaseFence);
        await this.applySnapshot(tx, floorId, snapshot, existingFixtureIds, changedAt);

        const floor = await this.loadSnapshotFloor(tx, floorId);
        const restoredSnapshot = this.buildSnapshot(floor);
        const nextRevision = input.expectedRevision + 1;
        const changeSummary = {
          restoredFromRevision: parsedRevision,
          skippedFixtureIds,
          fixtureUpdates: existingFixtureIds.size,
          objectCreates: snapshot.objects.length
        };
        await this.createRevision(tx, {
          floorId,
          revision: nextRevision,
          snapshot: restoredSnapshot,
          changeSummary,
          changedBy: user.id,
          restoredFromRevision: parsedRevision
        });
        await this.auditService.record({
          organizationId: authorizedSite.organizationId,
          siteId: authorizedSite.id,
          actorId: user.id,
          action: "floor_editor.restored",
          targetType: "floor",
          targetId: floorId,
          outcome: "success",
          metadata: {
            revision: nextRevision,
            restoredFromRevision: parsedRevision,
            skippedFixtureIds,
            snapshotSha256: hashFloorEditorSnapshot(restoredSnapshot)
          },
          transaction: tx
        });

        return { ...this.toEditorState(floor), skippedFixtureIds };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwMappedTransactionError(error);
      throw error;
    }
  }

  private toEditorState(floor: {
    id: string;
    siteId: string;
    name: string;
    level: number;
    mapRevision?: number;
    floorPlan: any;
    fixtures: any[];
    mapObjects: any[];
  }) {
    return {
      floor: {
        id: floor.id,
        siteId: floor.siteId,
        name: floor.name,
        level: floor.level,
        mapRevision: floor.mapRevision ?? 0,
        floorPlan: floor.floorPlan
          ? {
              id: floor.floorPlan.id,
              imageUrl: floor.floorPlan.imageUrl,
              sourceType: floor.floorPlan.sourceType,
              originalFileUrl: floor.floorPlan.originalFileUrl,
              renderedImageUrl: floor.floorPlan.renderedImageUrl,
              width: floor.floorPlan.width,
              height: floor.floorPlan.height,
              version: floor.floorPlan.version
            }
          : null
      },
      fixtures: floor.fixtures.map((fixture) => ({
        id: fixture.id,
        name: fixture.name,
        x: fixture.x,
        y: fixture.y,
        size: fixture.size,
        ratedWatt: Number(fixture.ratedWatt),
        brightness: fixture.brightness,
        status: fixture.status
      })),
      objects: [...floor.mapObjects].sort((left, right) => this.compareEditorObjects(left, right)).map((object) => ({
        id: object.id,
        floorId: object.floorId,
        type: object.type,
        x: object.x,
        y: object.y,
        width: object.width ?? 0,
        height: object.height ?? 0,
        points: object.points,
        rotation: object.rotation,
        strokeColor: object.strokeColor,
        fillColor: object.fillColor,
        strokeWidth: object.strokeWidth,
        text: object.text ?? "",
        fontSize: object.fontSize,
        zIndex: object.zIndex,
        locked: object.locked,
        visible: object.visible
      }))
    };
  }

  private parseInput<T>(schema: { parse(value: unknown): T }, value: unknown, message: string): T {
    try {
      return schema.parse(value);
    } catch {
      throw new BadRequestException(message);
    }
  }

  private parseSnapshot(value: unknown): FloorEditorSnapshot {
    try {
      return parseFloorEditorSnapshot(value);
    } catch {
      throw new BadRequestException("floor revision snapshot is invalid");
    }
  }

  private buildSnapshot(floor: Parameters<typeof buildFloorEditorSnapshot>[0]): FloorEditorSnapshot {
    try {
      return buildFloorEditorSnapshot(floor);
    } catch {
      throw new BadRequestException("persisted floor editor state is invalid");
    }
  }

  private assertUniqueMutationIds(input: SaveEditorStateInput) {
    this.assertUniqueIds(input.fixtureUpdates.map((update) => update.id), "fixture update IDs must be unique");
    this.assertUniqueIds(input.objectUpdates.map((update) => update.id), "object update IDs must be unique");
    this.assertUniqueIds(input.objectDeletes, "object delete IDs must be unique");

    const updateIds = new Set(input.objectUpdates.map((update) => update.id));
    if (input.objectDeletes.some((objectId) => updateIds.has(objectId))) {
      throw new BadRequestException("an object cannot be updated and deleted in the same save");
    }
  }

  private assertUniqueIds(ids: string[], message: string) {
    if (new Set(ids).size !== ids.length) throw new BadRequestException(message);
  }

  private prepareSaveInput(floorId: string, input: SaveEditorStateInput): PreparedSaveEditorState {
    const floorPlan = input.floorPlan === undefined
      ? undefined
      : input.floorPlan === null
        ? null
        : this.buildFloorPlanData(input.floorPlan) as CompleteFloorPlanData;

    return {
      expectedRevision: input.expectedRevision,
      leaseToken: input.leaseToken,
      leaseFence: input.leaseFence,
      floorPlan,
      fixtureUpdates: input.fixtureUpdates.map(({ id, ...patch }) => ({
        id,
        data: this.buildFixtureData(patch)
      })),
      objectCreates: input.objectCreates.map((object) =>
        this.buildCreateObjectData({ ...object, floorId }) as Prisma.FloorMapObjectUncheckedCreateInput
      ),
      objectUpdates: input.objectUpdates.map(({ id, patch }) => ({
        id,
        data: this.buildUpdateObjectData(patch)
      })),
      objectDeletes: input.objectDeletes
    };
  }

  private async assertAtomicSaveTargets(
    tx: Prisma.TransactionClient,
    floorId: string,
    input: PreparedSaveEditorState
  ) {
    const fixtureIds = input.fixtureUpdates.map((update) => update.id);
    const fixtures = fixtureIds.length === 0
      ? []
      : await tx.fixture.findMany({ where: { floorId, id: { in: fixtureIds } }, select: { id: true } });
    if (fixtures.length !== fixtureIds.length) {
      throw new BadRequestException("fixture updates must belong to the requested floor");
    }

    const objectIds = [
      ...input.objectUpdates.map((update) => update.id),
      ...input.objectDeletes
    ];
    const objects = objectIds.length === 0
      ? []
      : await tx.floorMapObject.findMany({
          where: { floorId, id: { in: objectIds } },
          select: { id: true, type: true, width: true, height: true, points: true }
        });
    if (objects.length !== objectIds.length) {
      throw new BadRequestException("object updates and deletes must belong to the requested floor");
    }
    const objectStates = new Map(objects.map((object) => [object.id, object]));
    for (const update of input.objectUpdates) {
      this.normalizeObjectGeometryPatch(update.data, objectStates.get(update.id));
    }

    if (input.floorPlan) {
      await this.assertReadyAssetUrls(floorId, input.floorPlan, tx);
    }
  }

  private async preflightObjectUpdates(
    floorId: string,
    updates: PreparedSaveEditorState["objectUpdates"]
  ) {
    if (updates.length === 0) return;
    const objects = await this.prisma.floorMapObject.findMany({
      where: { floorId, id: { in: updates.map((update) => update.id) } },
      select: { id: true, type: true, width: true, height: true, points: true }
    });
    if (objects.length !== updates.length) {
      throw new BadRequestException("object updates must belong to the requested floor");
    }
    const objectStates = new Map(objects.map((object) => [object.id, object]));
    for (const update of updates) {
      this.normalizeObjectGeometryPatch(update.data, objectStates.get(update.id));
    }
  }

  private normalizeObjectGeometryPatch(
    data: Record<string, unknown>,
    current: { type: string; width: number | null; height: number | null; points: unknown } | undefined
  ) {
    if (!current) throw new BadRequestException("floor map object not found");
    const effectiveType = typeof data.type === "string" ? data.type : current.type;
    if (data.type !== undefined && effectiveType !== "triangle" && current.type === "triangle" && data.points === undefined) {
      data.points = null;
    }

    const geometry = this.parseInput(floorMapObjectGeometrySchema, {
      type: effectiveType,
      width: data.width === undefined ? current.width : data.width,
      height: data.height === undefined ? current.height : data.height,
      points: data.points === undefined ? current.points : data.points
    }, "invalid map object geometry");

    if (data.type !== undefined) data.type = geometry.type;
    if (data.width !== undefined) data.width = geometry.width;
    if (data.height !== undefined) data.height = geometry.height;
    if (data.points !== undefined) data.points = geometry.points;
  }

  private async incrementRevision(
    tx: Prisma.TransactionClient,
    floorId: string,
    expectedRevision: number,
    leaseToken: string,
    leaseFence: number
  ) {
    const floor = await this.lockFloorLeaseAuthority(tx, floorId);
    if (!floor) throw new NotFoundException("floor not found");
    const leaseActive = Boolean(
      floor.editorLeaseTokenHash &&
      floor.editorLeaseFence === leaseFence &&
      floor.editorLeaseTokenHash === hashEditorLeaseToken(leaseToken) &&
      floor.editorLeaseExpiresAt &&
      floor.editorLeaseExpiresAt.getTime() > floor.dbNow.getTime()
    );
    if (!leaseActive) {
      throw new ConflictException("floor editor lease is no longer active");
    }
    if (floor.mapRevision !== expectedRevision) {
      throw new ConflictException("floor editor revision conflict");
    }
    await tx.floor.update({
      where: { id: floorId },
      data: { mapRevision: { increment: 1 } }
    });
    return floor.dbNow;
  }

  private async lockFloorLeaseAuthority(tx: Prisma.TransactionClient, floorId: string) {
    const rows = await tx.$queryRaw<Omit<LockedFloorLeaseAuthority, "dbNow">[]>(Prisma.sql`
      SELECT
        "mapRevision",
        "editorLeaseFence",
        "editorLeaseTokenHash",
        "editorLeaseExpiresAt"
      FROM "Floor"
      WHERE "id" = ${floorId}
      FOR UPDATE
    `);
    const row = rows[0];
    if (!row) return null;
    const nowRows = await tx.$queryRaw<Array<{ dbNow: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "dbNow"`);
    return { ...row, dbNow: nowRows[0]!.dbNow };
  }

  private async applySaveChanges(
    tx: Prisma.TransactionClient,
    floorId: string,
    input: PreparedSaveEditorState,
    changedAt: Date
  ) {
    if (input.floorPlan === null) {
      await tx.floorPlan.deleteMany({ where: { floorId } });
    } else if (input.floorPlan !== undefined) {
      const data = input.floorPlan;
      await tx.floorPlan.upsert({
        where: { floorId },
        create: { floorId, ...data },
        update: { ...data, version: { increment: 1 } }
      });
    }

    for (const { id, data } of input.fixtureUpdates) {
      if (data.ratedWatt !== undefined) {
        await this.energyCheckpoint.closeRatedWattInterval(
          tx,
          id,
          new Prisma.Decimal(data.ratedWatt as string | number),
          changedAt
        );
      }
      await tx.fixture.update({ where: { id }, data });
    }

    if (input.objectDeletes.length > 0) {
      await tx.floorMapObject.deleteMany({ where: { floorId, id: { in: input.objectDeletes } } });
    }
    for (const data of input.objectCreates) {
      await tx.floorMapObject.create({ data });
    }
    for (const { id, data } of input.objectUpdates) {
      await tx.floorMapObject.update({
        where: { id },
        data: data as Prisma.FloorMapObjectUncheckedUpdateInput
      });
    }
  }

  private async loadSnapshotFloor(tx: Prisma.TransactionClient, floorId: string) {
    const floor = await tx.floor.findUnique({
      where: { id: floorId },
      include: {
        floorPlan: true,
        fixtures: { orderBy: { id: "asc" } },
        mapObjects: { orderBy: { id: "asc" } }
      }
    });
    if (!floor) throw new NotFoundException("floor not found");
    return floor;
  }

  private saveChangeSummary(input: PreparedSaveEditorState) {
    return {
      floorPlanChanged: input.floorPlan !== undefined,
      fixtureUpdates: input.fixtureUpdates.length,
      objectCreates: input.objectCreates.length,
      objectUpdates: input.objectUpdates.length,
      objectDeletes: input.objectDeletes.length
    };
  }

  private compareEditorObjects(
    left: { id: string; zIndex: number; createdAt?: Date | string },
    right: { id: string; zIndex: number; createdAt?: Date | string }
  ) {
    if (left.zIndex !== right.zIndex) return left.zIndex - right.zIndex;
    const leftCreatedAt = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightCreatedAt = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }

  private async createRevision(
    tx: Prisma.TransactionClient,
    input: {
      floorId: string;
      revision: number;
      snapshot: FloorEditorSnapshot;
      changeSummary: Record<string, unknown>;
      changedBy: string;
      restoredFromRevision?: number;
    }
  ) {
    const snapshotSha256 = hashFloorEditorSnapshot(input.snapshot);
    return tx.floorMapRevision.create({
      data: {
        floorId: input.floorId,
        revision: input.revision,
        snapshot: input.snapshot as Prisma.InputJsonValue,
        snapshotSha256,
        changeSummary: input.changeSummary as Prisma.InputJsonValue,
        changedBy: input.changedBy,
        restoredFromRevision: input.restoredFromRevision
      }
    });
  }

  private async assertSnapshotAssetsReady(
    tx: Prisma.TransactionClient,
    floorId: string,
    snapshot: FloorEditorSnapshot
  ) {
    if (!snapshot.floorPlan || snapshot.floorPlan.sourceType === "none") return;
    await this.assertReadyAssetUrls(floorId, snapshot.floorPlan, tx);
  }

  private async existingFixtureIds(tx: Prisma.TransactionClient, floorId: string, fixtureIds: string[]) {
    if (fixtureIds.length === 0) return new Set<string>();
    const fixtures = await tx.fixture.findMany({
      where: { floorId, id: { in: fixtureIds } },
      select: { id: true }
    });
    return new Set(fixtures.map((fixture) => fixture.id));
  }

  private async applySnapshot(
    tx: Prisma.TransactionClient,
    floorId: string,
    snapshot: FloorEditorSnapshot,
    existingFixtureIds: Set<string>,
    changedAt: Date
  ) {
    if (snapshot.floorPlan) {
      await tx.floorPlan.upsert({
        where: { floorId },
        create: { floorId, ...snapshot.floorPlan },
        update: { ...snapshot.floorPlan, version: { increment: 1 } }
      });
    } else {
      await tx.floorPlan.deleteMany({ where: { floorId } });
    }

    for (const fixture of snapshot.fixtures) {
      if (!existingFixtureIds.has(fixture.id)) continue;
      const { id, ...data } = fixture;
      await this.energyCheckpoint.closeRatedWattInterval(
        tx,
        id,
        new Prisma.Decimal(data.ratedWatt),
        changedAt
      );
      await tx.fixture.update({ where: { id }, data });
    }

    await tx.floorMapObject.deleteMany({ where: { floorId } });
    if (snapshot.objects.length > 0) {
      await tx.floorMapObject.createMany({
        data: snapshot.objects.map((object) => ({
          ...object,
          floorId,
          points: object.points as Prisma.InputJsonValue
        }))
      });
    }
  }

  private throwMappedTransactionError(error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2034") {
      throw new ConflictException("floor editor transaction conflicted, please retry");
    }
  }

  private async assertExistingFloor(floorId: string, user: AuthenticatedUser, capability: "read" | "manage") {
    const floor = await this.prisma.floor.findUnique({
      where: { id: floorId },
      select: { siteId: true }
    });
    if (!floor) throw new NotFoundException("floor not found");
    const site = await this.siteAccess.assert(user, floor.siteId, capability);
    return { siteId: floor.siteId, organizationId: site.organizationId };
  }

  private buildFloorPlanData(input: UpdateFloorPlanInput) {
    const data: FloorPlanData = {};
    if (input.sourceType !== undefined) {
      if (!["none", "image", "pdf"].includes(input.sourceType)) throw new BadRequestException("invalid sourceType");
      data.sourceType = input.sourceType;
    }
    if (input.imageUrl !== undefined) {
      data.imageUrl = input.imageUrl.trim() === "" ? "" : this.objectStorageUrl(input.imageUrl, "imageUrl");
    }
    if (input.originalFileUrl !== undefined) {
      data.originalFileUrl =
        input.originalFileUrl === null || input.originalFileUrl.trim() === ""
          ? input.originalFileUrl
          : this.objectStorageUrl(input.originalFileUrl, "originalFileUrl");
    }
    if (input.renderedImageUrl !== undefined) {
      data.renderedImageUrl =
        input.renderedImageUrl === null || input.renderedImageUrl.trim() === ""
          ? input.renderedImageUrl
          : this.objectStorageUrl(input.renderedImageUrl, "renderedImageUrl");
    }
    if (input.width !== undefined) data.width = this.positiveInteger(input.width, "width");
    if (input.height !== undefined) data.height = this.positiveInteger(input.height, "height");

    return data;
  }

  private async assertReadyAssetUrls(
    floorId: string,
    data: FloorPlanData,
    client: Pick<Prisma.TransactionClient, "floorAsset"> | PrismaService = this.prisma
  ) {
    const urls = Array.from(
      new Set([data.imageUrl, data.originalFileUrl, data.renderedImageUrl].filter((url): url is string => Boolean(url)))
    );
    if (urls.length === 0) return;
    const readyCount = await client.floorAsset.count({
      where: { floorId, status: "ready", publicUrl: { in: urls } }
    });
    if (readyCount !== urls.length) throw new BadRequestException("floor plan URLs must reference ready floor assets");
  }

  private buildFixtureData(input: UpdateFixtureInput) {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = this.trimRequiredString(input.name, "fixture name is required");
    if (input.ratedWatt !== undefined) data.ratedWatt = this.decimalString(input.ratedWatt, "ratedWatt");
    if (input.x !== undefined) data.x = this.finiteNumber(input.x, "x");
    if (input.y !== undefined) data.y = this.finiteNumber(input.y, "y");
    if (input.size !== undefined) data.size = this.finiteNumber(input.size, "size");

    return data;
  }

  private buildCreateObjectData(input: CreateObjectInput) {
    return {
      floorId: this.trimRequiredString(input.floorId, "floorId is required"),
      type: this.trimRequiredString(input.type, "object type is required"),
      x: this.finiteNumber(input.x, "x"),
      y: this.finiteNumber(input.y, "y"),
      width: input.width === undefined ? null : this.nullableFiniteNumber(input.width, "width"),
      height: input.height === undefined ? null : this.nullableFiniteNumber(input.height, "height"),
      rotation: input.rotation === undefined ? 0 : this.finiteNumber(input.rotation, "rotation"),
      points: input.points === undefined ? null : (input.points as Prisma.InputJsonValue),
      text: input.text === undefined ? null : this.nullableTrimmedString(input.text, "text"),
      strokeColor: input.strokeColor === undefined ? "#0b63e5" : this.trimRequiredString(input.strokeColor, "strokeColor is required"),
      fillColor: input.fillColor === undefined ? null : this.nullableTrimmedString(input.fillColor, "fillColor"),
      strokeWidth: input.strokeWidth === undefined ? 2 : this.finiteNumber(input.strokeWidth, "strokeWidth"),
      fontSize: input.fontSize === undefined ? null : this.nullableFiniteNumber(input.fontSize, "fontSize"),
      zIndex: input.zIndex === undefined ? 0 : this.integer(input.zIndex, "zIndex"),
      locked: input.locked === undefined ? false : this.boolean(input.locked, "locked"),
      visible: input.visible === undefined ? true : this.boolean(input.visible, "visible")
    };
  }

  private buildUpdateObjectData(input: UpdateObjectInput) {
    const data: Record<string, unknown> = {};
    if (input.type !== undefined) data.type = this.trimRequiredString(input.type, "object type is required");
    if (input.x !== undefined) data.x = this.finiteNumber(input.x, "x");
    if (input.y !== undefined) data.y = this.finiteNumber(input.y, "y");
    if (input.width !== undefined) data.width = this.nullableFiniteNumber(input.width, "width");
    if (input.height !== undefined) data.height = this.nullableFiniteNumber(input.height, "height");
    if (input.rotation !== undefined) data.rotation = this.finiteNumber(input.rotation, "rotation");
    if (input.points !== undefined) data.points = input.points as Prisma.InputJsonValue;
    if (input.text !== undefined) data.text = this.nullableTrimmedString(input.text, "text");
    if (input.strokeColor !== undefined) data.strokeColor = this.trimRequiredString(input.strokeColor, "strokeColor is required");
    if (input.fillColor !== undefined) data.fillColor = this.nullableTrimmedString(input.fillColor, "fillColor");
    if (input.strokeWidth !== undefined) data.strokeWidth = this.finiteNumber(input.strokeWidth, "strokeWidth");
    if (input.fontSize !== undefined) data.fontSize = this.nullableFiniteNumber(input.fontSize, "fontSize");
    if (input.zIndex !== undefined) data.zIndex = this.integer(input.zIndex, "zIndex");
    if (input.locked !== undefined) data.locked = this.boolean(input.locked, "locked");
    if (input.visible !== undefined) data.visible = this.boolean(input.visible, "visible");

    return data;
  }

  private trimRequiredString(value: unknown, message: string) {
    if (typeof value !== "string" || value.trim().length === 0) throw new BadRequestException(message);
    return value.trim();
  }

  private trimOptionalString(value: unknown, field: string) {
    if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
    return value.trim();
  }

  private objectStorageUrl(value: unknown, field: string) {
    const result = this.trimOptionalString(value, field);
    if (result === "") throw new BadRequestException(`${field} must not be empty`);
    try {
      const url = new URL(result);
      if (url.protocol === "http:" || url.protocol === "https:") return result;
    } catch {}
    throw new BadRequestException(`${field} must be an object storage URL`);
  }

  private nullableTrimmedString(value: unknown, field: string) {
    if (value === null) return null;
    if (typeof value !== "string") throw new BadRequestException(`${field} must be a string or null`);
    return value.trim();
  }

  private finiteNumber(value: unknown, field: string) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new BadRequestException(`${field} must be a finite number`);
    return value;
  }

  private nullableFiniteNumber(value: unknown, field: string) {
    if (value === null) return null;
    return this.finiteNumber(value, field);
  }

  private positiveInteger(value: unknown, field: string) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }
    return value;
  }

  private integer(value: unknown, field: string) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new BadRequestException(`${field} must be an integer`);
    }
    return value;
  }

  private boolean(value: unknown, field: string) {
    if (typeof value !== "boolean") throw new BadRequestException(`${field} must be a boolean`);
    return value;
  }

  private decimalString(value: unknown, field: string) {
    const numericValue = typeof value === "string" ? Number(value) : value;
    if (typeof numericValue !== "number" || !Number.isFinite(numericValue) || numericValue < 0) {
      throw new BadRequestException(`${field} must be a non-negative number`);
    }
    return numericValue.toFixed(2);
  }
}
