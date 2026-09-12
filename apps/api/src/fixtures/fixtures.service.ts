import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { isGatewayHeartbeatFresh } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { FixtureEnergyCheckpointService } from "../energy/fixture-state-ingestion.service";
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
  floorName: string;
  name: string;
  ratedWatt: Prisma.Decimal;
  energyTrackingStartedAt: Date;
};

@Injectable()
export class FixturesService {
  constructor(prisma: PrismaService, siteAccess: SiteAccessService);
  constructor(
    prisma: PrismaService,
    siteAccess: SiteAccessService,
    energyCheckpoint: FixtureEnergyCheckpointService,
    energyDimensions: EnergyDimensionHistoryService
  );
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly energyCheckpoint?: FixtureEnergyCheckpointService,
    private readonly energyDimensions?: EnergyDimensionHistoryService
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
      select: { id: true, siteId: true, status: true }
    });
    if (!floor || floor.siteId !== siteId || floor.status !== "active") {
      throw new NotFoundException("floor not found");
    }
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

  async getFloorFixtureSettings(user: AuthenticatedUser, siteId: string, floorId: string) {
    await this.siteAccess.assert(user, siteId, "manage");
    const floor = await this.prisma.floor.findUnique({
      where: { id: floorId },
      select: { id: true, siteId: true }
    });
    if (!floor || floor.siteId !== siteId) throw new NotFoundException("floor not found");

    const fixtures = await this.prisma.fixture.findMany({
      where: { siteId, floorId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        ratedWatt: true,
        meshNode: {
          select: {
            serialNumber: true,
            deviceUuid: true,
            meshAddress: true,
            firmwareVersion: true
          }
        }
      }
    });

    return {
      items: fixtures.map((fixture) => ({
        id: fixture.id,
        name: fixture.name,
        ratedWatt: Number(fixture.ratedWatt),
        serialNumber: fixture.meshNode?.serialNumber ?? null,
        deviceUuid: fixture.meshNode?.deviceUuid ?? null,
        meshAddress: fixture.meshNode?.meshAddress ?? null,
        firmwareVersion: fixture.meshNode?.firmwareVersion ?? null
      }))
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
        SELECT
          "id",
          "siteId",
          "floorId",
          (SELECT "name" FROM "Floor" WHERE "Floor"."id" = "Fixture"."floorId") AS "floorName",
          "name",
          "ratedWatt",
          "energyTrackingStartedAt"
        FROM "Fixture"
        WHERE "id" = ${fixtureId} AND "floorId" = ${floorId} AND "siteId" = ${siteId}
        FOR UPDATE
      `);
      const current = rows[0];
      if (!current) throw new NotFoundException("fixture not found");
      if (!this.energyCheckpoint || !this.energyDimensions) {
        throw new InternalServerErrorException("fixture energy providers unavailable");
      }

      const changedAt = new Date();
      const nextRatedWatt = parsed.data.ratedWatt === undefined
        ? new Prisma.Decimal(current.ratedWatt)
        : new Prisma.Decimal(parsed.data.ratedWatt);
      if (!nextRatedWatt.equals(current.ratedWatt)) {
        await this.energyCheckpoint.closeRatedWattInterval(tx, fixtureId, nextRatedWatt, changedAt);
      }
      await this.energyDimensions.recordFixtureDimensions(tx, {
        fixtureId,
        siteId,
        name: parsed.data.name ?? current.name,
        floorId,
        floorName: current.floorName,
        ratedWatt: nextRatedWatt,
        trackingStartedAt: current.energyTrackingStartedAt,
        effectiveAt: changedAt
      });

      return tx.fixture.update({
        where: { id: fixtureId },
        data: {
          ...parsed.data,
          ...(parsed.data.ratedWatt === undefined
            ? {}
            : { ratedWatt: nextRatedWatt })
        },
        select: { id: true, floorId: true, name: true, ratedWatt: true }
      });
    });

    return { ...fixture, ratedWatt: Number(fixture.ratedWatt) };
  }
}
