import { Injectable, NotFoundException } from "@nestjs/common";
import { floorMapSnapshotSchema } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

const DEFAULT_CANVAS_WIDTH = 1200;
const DEFAULT_CANVAS_HEIGHT = 800;

@Injectable()
export class FloorMapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async getSnapshot(user: AuthenticatedUser, siteId: string, floorId: string) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: floorId, siteId },
      include: {
        floorPlan: true,
        mapObjects: {
          where: { visible: true },
          orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }]
        },
        lightSlots: {
          where: { assignedFixtureId: { not: null } },
          orderBy: { id: "asc" },
          select: {
            x: true,
            y: true,
            assignedFixture: {
              select: { id: true, name: true, size: true, placementStatus: true }
            }
          }
        }
      }
    });
    if (!floor) throw this.floorNotFound();

    try {
      await this.siteAccess.assert(user, siteId, "read");
    } catch (error) {
      if (error instanceof NotFoundException) throw this.floorNotFound();
      throw error;
    }

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
      fixtures: floor.lightSlots.flatMap((slot) => {
        const fixture = slot.assignedFixture;
        if (!fixture || fixture.placementStatus !== "placed") return [];
        return [{
          id: fixture.id,
          name: fixture.name,
          x: slot.x,
          y: slot.y,
          size: fixture.size
        }];
      })
    });
  }

  private floorNotFound() {
    return new NotFoundException("floor not found");
  }
}
