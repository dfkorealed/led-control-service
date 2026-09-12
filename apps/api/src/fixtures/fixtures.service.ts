import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { isGatewayHeartbeatFresh } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { fixtureStatusWithHealth, toFixtureHealthSnapshot } from "./fixture-health";

const fixtureMetadataSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  ratedWatt: z.number().finite().positive().max(999_999.99).multipleOf(0.01).optional()
}).strict().refine((input) => Object.keys(input).length > 0);

type LockedFixtureMetadata = {
  id: string;
  siteId: string;
  floorId: string;
  name: string;
  ratedWatt: Prisma.Decimal;
};

@Injectable()
export class FixturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async getFloorFixtures(
    user: AuthenticatedUser,
    siteId: string,
    floorId: string,
    options: { cursor?: string; limit?: number }
  ) {
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new BadRequestException("limit must be an integer from 1 to 200");
    }
    const floor = await this.prisma.floor.findUnique({
      where: { id: floorId },
      select: { id: true, siteId: true }
    });
    if (!floor || floor.siteId !== siteId) throw new NotFoundException("floor not found");
    try {
      await this.siteAccess.assert(user, siteId, "read");
    } catch (error) {
      if (error instanceof NotFoundException) throw new NotFoundException("floor not found");
      throw error;
    }

    const rows = await this.prisma.fixture.findMany({
      where: { floorId },
      orderBy: { id: "asc" },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: { meshNode: { include: { gateway: true } } }
    });
    const hasNextPage = rows.length > limit;
    const page = rows.slice(0, limit);
    const now = new Date();

    return {
      items: page.map((fixture) => {
        const gatewayOnline = isGatewayHeartbeatFresh(fixture.meshNode?.gateway.lastHeartbeatAt, now);
        const health = toFixtureHealthSnapshot(fixture.healthFaultCodes, fixture.healthLastSeenAt);
        const status = fixtureStatusWithHealth(fixture.status, health);
        const controlBlockReason = !fixture.meshNode
          ? "fixture_unmapped"
          : !gatewayOnline
            ? "gateway_offline"
            : status === "fault"
              ? "fixture_fault"
              : status === "offline"
                ? "fixture_offline"
                : null;
        return {
          id: fixture.id,
          name: fixture.name,
          x: fixture.x,
          y: fixture.y,
          size: fixture.size,
          placementStatus: fixture.placementStatus,
          positionVerifiedAt: fixture.positionVerifiedAt?.toISOString() ?? null,
          ratedWatt: Number(fixture.ratedWatt),
          brightness: fixture.brightness,
          status,
          statusReason: fixture.statusReason,
          health,
          rssi: fixture.rssi,
          hopCount: fixture.hopCount,
          commandSuccessRate: fixture.commandSuccessRate,
          lastSeenAt: fixture.lastSeenAt?.toISOString() ?? null,
          gateway: fixture.meshNode
            ? {
                id: fixture.meshNode.gateway.id,
                name: fixture.meshNode.gateway.name,
                connectionStatus: gatewayOnline ? "online" : "offline"
              }
            : null,
          controllable: controlBlockReason === null,
          controlBlockReason
        };
      }),
      nextCursor: hasNextPage ? page.at(-1)?.id ?? null : null
    };
  }

  async updateMetadata(
    user: AuthenticatedUser,
    siteId: string,
    floorId: string,
    fixtureId: string,
    rawInput: unknown
  ) {
    await this.siteAccess.assert(user, siteId, "manage");
    const parsed = fixtureMetadataSchema.safeParse(rawInput);
    if (!parsed.success) throw new BadRequestException("invalid fixture metadata request");

    const fixture = await this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      const rows = await tx.$queryRaw<LockedFixtureMetadata[]>(Prisma.sql`
        SELECT "id", "siteId", "floorId", "name", "ratedWatt"
        FROM "Fixture"
        WHERE "id" = ${fixtureId} AND "floorId" = ${floorId} AND "siteId" = ${siteId}
        FOR UPDATE
      `);
      if (!rows[0]) throw new NotFoundException("fixture not found");

      return tx.fixture.update({
        where: { id: fixtureId },
        data: {
          ...parsed.data,
          ...(parsed.data.ratedWatt === undefined
            ? {}
            : { ratedWatt: new Prisma.Decimal(parsed.data.ratedWatt) })
        },
        select: { id: true, floorId: true, name: true, ratedWatt: true }
      });
    });

    return { ...fixture, ratedWatt: Number(fixture.ratedWatt) };
  }
}
