import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { FloorPlanSourceType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

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
  constructor(private readonly prisma: PrismaService) {}

  async getEditorState(floorId: string, organizationId: string) {
    const floor = await this.prisma.floor.findUnique({
      where: { id: floorId },
      include: {
        site: { select: { organizationId: true } },
        floorPlan: true,
        fixtures: { orderBy: { name: "asc" } },
        mapObjects: { orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }] }
      }
    });
    this.assertFloorInOrganization(floor, organizationId);

    return {
      floor: {
        id: floor.id,
        siteId: floor.siteId,
        name: floor.name,
        level: floor.level,
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

  async updateFloorPlan(floorId: string, input: UpdateFloorPlanInput, organizationId: string) {
    await this.assertExistingFloor(floorId, organizationId);
    const data = this.buildFloorPlanData(input);

    if (Object.keys(data).length === 0) throw new BadRequestException("floor plan update payload is empty");

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

  async updateFixture(fixtureId: string, input: UpdateFixtureInput, organizationId: string) {
    const fixture = await this.prisma.fixture.findUnique({
      where: { id: fixtureId },
      include: { floor: { include: { site: { select: { organizationId: true } } } } }
    });
    if (!fixture || fixture.floor.site.organizationId !== organizationId) {
      throw new NotFoundException("fixture not found");
    }

    const data = this.buildFixtureData(input);
    if (Object.keys(data).length === 0) throw new BadRequestException("fixture update payload is empty");

    return this.prisma.fixture.update({
      where: { id: fixtureId },
      data
    });
  }

  async createObject(input: CreateObjectInput, organizationId: string) {
    await this.assertExistingFloor(input.floorId, organizationId);
    const data = this.buildCreateObjectData(input);

    return this.prisma.floorMapObject.create({ data: data as Prisma.FloorMapObjectUncheckedCreateInput });
  }

  async updateObject(objectId: string, input: UpdateObjectInput, organizationId: string) {
    await this.assertExistingObject(objectId, organizationId);
    const data = this.buildUpdateObjectData(input);
    if (Object.keys(data).length === 0) throw new BadRequestException("map object update payload is empty");

    return this.prisma.floorMapObject.update({
      where: { id: objectId },
      data: data as Prisma.FloorMapObjectUncheckedUpdateInput
    });
  }

  async deleteObject(objectId: string, organizationId: string) {
    await this.assertExistingObject(objectId, organizationId);
    await this.prisma.floorMapObject.delete({ where: { id: objectId } });

    return { deleted: true };
  }

  private async assertExistingFloor(floorId: string, organizationId: string) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: floorId, site: { organizationId } },
      include: { site: { select: { organizationId: true } } }
    });
    if (!floor) throw new NotFoundException("floor not found");
    return floor;
  }

  private async assertExistingObject(objectId: string, organizationId: string) {
    const object = await this.prisma.floorMapObject.findUnique({
      where: { id: objectId },
      include: { floor: { include: { site: { select: { organizationId: true } } } } }
    });
    if (!object || object.floor.site.organizationId !== organizationId) {
      throw new NotFoundException("floor map object not found");
    }
    return object;
  }

  private assertFloorInOrganization(
    floor: ({ site: { organizationId: string } } & Record<string, unknown>) | null,
    organizationId: string
  ): asserts floor is { site: { organizationId: string } } & Record<string, unknown> {
    if (!floor || floor.site.organizationId !== organizationId) {
      throw new NotFoundException("floor not found");
    }
  }

  private buildFloorPlanData(input: UpdateFloorPlanInput) {
    const data: FloorPlanData = {};
    if (input.sourceType !== undefined) {
      if (!["none", "image", "pdf"].includes(input.sourceType)) throw new BadRequestException("invalid sourceType");
      data.sourceType = input.sourceType;
    }
    if (input.imageUrl !== undefined) data.imageUrl = this.trimOptionalString(input.imageUrl, "imageUrl");
    if (input.originalFileUrl !== undefined) {
      data.originalFileUrl =
        input.originalFileUrl === null ? null : this.trimOptionalString(input.originalFileUrl, "originalFileUrl");
    }
    if (input.renderedImageUrl !== undefined) {
      data.renderedImageUrl =
        input.renderedImageUrl === null ? null : this.trimOptionalString(input.renderedImageUrl, "renderedImageUrl");
    }
    if (input.width !== undefined) data.width = this.positiveInteger(input.width, "width");
    if (input.height !== undefined) data.height = this.positiveInteger(input.height, "height");

    return data;
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
