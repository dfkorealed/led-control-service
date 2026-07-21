import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FixturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async getFloorFixtures(
    user: AuthenticatedUser,
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
    if (!floor) throw new NotFoundException("floor not found");
    await this.siteAccess.assert(user, floor.siteId, "read");

    const rows = await this.prisma.fixture.findMany({
      where: { floorId },
      orderBy: { id: "asc" },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: { meshNode: { include: { gateway: true } } }
    });
    const hasNextPage = rows.length > limit;
    const page = rows.slice(0, limit);
    const now = Date.now();

    return {
      items: page.map((fixture) => {
        const gatewayOnline = Boolean(
          fixture.meshNode?.gateway.lastHeartbeatAt && now - fixture.meshNode.gateway.lastHeartbeatAt.getTime() < 90_000
        );
        const controlBlockReason = !fixture.meshNode
          ? "fixture_unmapped"
          : !gatewayOnline
            ? "gateway_offline"
            : fixture.status === "fault"
              ? "fixture_fault"
              : fixture.status === "offline"
                ? "fixture_offline"
                : null;
        return {
          id: fixture.id,
          name: fixture.name,
          x: fixture.x,
          y: fixture.y,
          size: fixture.size,
          ratedWatt: Number(fixture.ratedWatt),
          brightness: fixture.brightness,
          status: fixture.status,
          statusReason: fixture.statusReason,
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
}
