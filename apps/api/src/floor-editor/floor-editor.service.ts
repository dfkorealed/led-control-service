import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  FloorEditorSnapshot,
  SaveEditorStateInput,
  floorEditorSnapshotSchema,
  restoreFloorEditorRevisionSchema,
  saveEditorStateSchema
} from "@led-control/shared";
import { FloorPlanSourceType, Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { buildFloorEditorSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";

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

@Injectable()
export class FloorEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly auditService: AuditService
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

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertAtomicSaveTargets(tx, floorId, input);
        await this.incrementRevision(tx, floorId, input.expectedRevision);
        await this.applySaveChanges(tx, floorId, input);

        const floor = await this.loadSnapshotFloor(tx, floorId);
        const snapshot = buildFloorEditorSnapshot(floor);
        const changeSummary = this.saveChangeSummary(input);
        await this.createRevision(tx, {
          floorId,
          revision: input.expectedRevision + 1,
          snapshot,
          changeSummary,
          changedBy: user.id
        });
        await this.auditService.record({
          organizationId: access.organizationId,
          siteId: access.siteId,
          actorId: user.id,
          action: "floor_editor.saved",
          targetType: "floor",
          targetId: floorId,
          outcome: "success",
          metadata: {
            revision: input.expectedRevision + 1,
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

  async listEditorRevisions(user: AuthenticatedUser, floorId: string) {
    await this.assertExistingFloor(floorId, user, "read");
    return this.prisma.floorMapRevision.findMany({
      where: { floorId },
      orderBy: { revision: "desc" },
      select: {
        id: true,
        revision: true,
        snapshotSha256: true,
        changeSummary: true,
        changedBy: true,
        restoredFromRevision: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } }
      }
    });
  }

  async restoreEditorRevision(
    user: AuthenticatedUser,
    floorId: string,
    revision: number,
    rawInput: unknown
  ) {
    const access = await this.assertExistingFloor(floorId, user, "manage");
    if (!Number.isInteger(revision) || revision < 1) throw new BadRequestException("revision must be a positive integer");
    const input = this.parseInput(
      restoreFloorEditorRevisionSchema,
      rawInput,
      "invalid floor editor restore payload"
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const source = await tx.floorMapRevision.findUnique({
          where: { floorId_revision: { floorId, revision } },
          select: { revision: true, snapshot: true }
        });
        if (!source) throw new NotFoundException("floor revision not found");

        const snapshot = this.parseInput(
          floorEditorSnapshotSchema,
          source.snapshot,
          "floor revision snapshot is invalid"
        );
        await this.assertSnapshotAssetsReady(tx, floorId, snapshot);
        const existingFixtureIds = await this.existingFixtureIds(tx, floorId, snapshot.fixtures.map((fixture) => fixture.id));
        const skippedFixtureIds = snapshot.fixtures
          .map((fixture) => fixture.id)
          .filter((fixtureId) => !existingFixtureIds.has(fixtureId))
          .sort();

        await this.incrementRevision(tx, floorId, input.expectedRevision);
        await this.applySnapshot(tx, floorId, snapshot, existingFixtureIds);

        const floor = await this.loadSnapshotFloor(tx, floorId);
        const restoredSnapshot = buildFloorEditorSnapshot(floor);
        const nextRevision = input.expectedRevision + 1;
        const changeSummary = {
          restoredFromRevision: revision,
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
          restoredFromRevision: revision
        });
        await this.auditService.record({
          organizationId: access.organizationId,
          siteId: access.siteId,
          actorId: user.id,
          action: "floor_editor.restored",
          targetType: "floor",
          targetId: floorId,
          outcome: "success",
          metadata: {
            revision: nextRevision,
            restoredFromRevision: revision,
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
      objects: floor.mapObjects.map((object) => ({
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

  async updateFloorPlan(floorId: string, input: UpdateFloorPlanInput, user: AuthenticatedUser) {
    await this.assertExistingFloor(floorId, user, "manage");
    const data = this.buildFloorPlanData(input);

    if (Object.keys(data).length === 0) throw new BadRequestException("floor plan update payload is empty");
    await this.assertReadyAssetUrls(floorId, data);

    return this.prisma.floorPlan.upsert({
      where: { floorId },
      create: {
        floorId,
        imageUrl: data.imageUrl ?? "",
        sourceType: data.sourceType ?? "none",
        originalFileUrl: data.originalFileUrl ?? null,
        renderedImageUrl: data.renderedImageUrl ?? null,
        width: data.width ?? 1,
        height: data.height ?? 1
      },
      update: {
        ...data,
        version: { increment: 1 }
      }
    });
  }

  async updateFixture(fixtureId: string, input: UpdateFixtureInput, user: AuthenticatedUser) {
    const fixture = await this.prisma.fixture.findUnique({
      where: { id: fixtureId },
      include: { floor: { select: { siteId: true } } }
    });
    if (!fixture) throw new NotFoundException("fixture not found");
    await this.siteAccess.assert(user, fixture.floor.siteId, "manage");

    const data = this.buildFixtureData(input);
    if (Object.keys(data).length === 0) throw new BadRequestException("fixture update payload is empty");

    return this.prisma.fixture.update({
      where: { id: fixtureId },
      data
    });
  }

  async createObject(input: CreateObjectInput, user: AuthenticatedUser) {
    await this.assertExistingFloor(input.floorId, user, "manage");
    const data = this.buildCreateObjectData(input);

    return this.prisma.floorMapObject.create({ data: data as Prisma.FloorMapObjectUncheckedCreateInput });
  }

  async updateObject(objectId: string, input: UpdateObjectInput, user: AuthenticatedUser) {
    await this.assertExistingObject(objectId, user, "manage");
    const data = this.buildUpdateObjectData(input);
    if (Object.keys(data).length === 0) throw new BadRequestException("map object update payload is empty");

    return this.prisma.floorMapObject.update({
      where: { id: objectId },
      data: data as Prisma.FloorMapObjectUncheckedUpdateInput
    });
  }

  async deleteObject(objectId: string, user: AuthenticatedUser) {
    await this.assertExistingObject(objectId, user, "manage");
    await this.prisma.floorMapObject.delete({ where: { id: objectId } });

    return { deleted: true };
  }

  private parseInput<T>(schema: { parse(value: unknown): T }, value: unknown, message: string): T {
    try {
      return schema.parse(value);
    } catch {
      throw new BadRequestException(message);
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

  private async assertAtomicSaveTargets(
    tx: Prisma.TransactionClient,
    floorId: string,
    input: SaveEditorStateInput
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
      : await tx.floorMapObject.findMany({ where: { floorId, id: { in: objectIds } }, select: { id: true } });
    if (objects.length !== objectIds.length) {
      throw new BadRequestException("object updates and deletes must belong to the requested floor");
    }

    if (input.floorPlan && input.floorPlan !== null) {
      await this.assertReadyAssetUrls(floorId, this.buildFloorPlanData(input.floorPlan), tx);
    }
  }

  private async incrementRevision(tx: Prisma.TransactionClient, floorId: string, expectedRevision: number) {
    const updated = await tx.floor.updateMany({
      where: { id: floorId, mapRevision: expectedRevision },
      data: { mapRevision: { increment: 1 } }
    });
    if (updated.count !== 1) throw new ConflictException("floor editor revision conflict");
  }

  private async applySaveChanges(tx: Prisma.TransactionClient, floorId: string, input: SaveEditorStateInput) {
    if (input.floorPlan === null) {
      await tx.floorPlan.deleteMany({ where: { floorId } });
    } else if (input.floorPlan !== undefined) {
      const data = this.buildFloorPlanData(input.floorPlan);
      await tx.floorPlan.upsert({
        where: { floorId },
        create: {
          floorId,
          imageUrl: data.imageUrl ?? "",
          sourceType: data.sourceType ?? "none",
          originalFileUrl: data.originalFileUrl ?? null,
          renderedImageUrl: data.renderedImageUrl ?? null,
          width: data.width ?? 1,
          height: data.height ?? 1
        },
        update: { ...data, version: { increment: 1 } }
      });
    }

    for (const { id, ...patch } of input.fixtureUpdates) {
      await tx.fixture.update({ where: { id }, data: this.buildFixtureData(patch) });
    }

    if (input.objectDeletes.length > 0) {
      await tx.floorMapObject.deleteMany({ where: { floorId, id: { in: input.objectDeletes } } });
    }
    for (const object of input.objectCreates) {
      const data = this.buildCreateObjectData({ ...object, floorId });
      await tx.floorMapObject.create({ data: data as Prisma.FloorMapObjectUncheckedCreateInput });
    }
    for (const { id, patch } of input.objectUpdates) {
      const data = this.buildUpdateObjectData(patch);
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

  private saveChangeSummary(input: SaveEditorStateInput) {
    return {
      floorPlanChanged: input.floorPlan !== undefined,
      fixtureUpdates: input.fixtureUpdates.length,
      objectCreates: input.objectCreates.length,
      objectUpdates: input.objectUpdates.length,
      objectDeletes: input.objectDeletes.length
    };
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
    if (!snapshot.floorPlan) return;
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
    existingFixtureIds: Set<string>
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

  private async assertExistingObject(objectId: string, user: AuthenticatedUser, capability: "read" | "manage") {
    const object = await this.prisma.floorMapObject.findUnique({
      where: { id: objectId },
      include: { floor: { select: { siteId: true } } }
    });
    if (!object) throw new NotFoundException("floor map object not found");
    await this.siteAccess.assert(user, object.floor.siteId, capability);
    return object;
  }

  private buildFloorPlanData(input: UpdateFloorPlanInput) {
    const data: FloorPlanData = {};
    if (input.sourceType !== undefined) {
      if (!["none", "image", "pdf"].includes(input.sourceType)) throw new BadRequestException("invalid sourceType");
      data.sourceType = input.sourceType;
    }
    if (input.imageUrl !== undefined) data.imageUrl = this.objectStorageUrl(input.imageUrl, "imageUrl");
    if (input.originalFileUrl !== undefined) {
      data.originalFileUrl =
        input.originalFileUrl === null ? null : this.objectStorageUrl(input.originalFileUrl, "originalFileUrl");
    }
    if (input.renderedImageUrl !== undefined) {
      data.renderedImageUrl =
        input.renderedImageUrl === null ? null : this.objectStorageUrl(input.renderedImageUrl, "renderedImageUrl");
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
    if (result === "") return result;
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
