import { Injectable } from "@nestjs/common";
import {
  commandClockRequestSchema,
  commandClockResponseSchema,
  type CommandClockRequest,
  type CommandClockResponse
} from "@led-control/shared";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CommandDbClockHealth } from "./command-db-clock-health.service";

@Injectable()
export class CommandClockResponderService {
  constructor(private readonly prisma: PrismaService, private readonly health: CommandDbClockHealth) {}

  async respond(
    topicScope: { siteId: string; gatewayId: string }, request: CommandClockRequest
  ): Promise<CommandClockResponse | null> {
    const parsed = commandClockRequestSchema.safeParse(request);
    if (!parsed.success || topicScope.siteId !== parsed.data.siteId || topicScope.gatewayId !== parsed.data.gatewayId) {
      return null;
    }
    try {
      return await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await this.health.assertHealthy(tx);
        const [clock] = await tx.$queryRaw<Array<{ dbNow: Date }>>`SELECT clock_timestamp() AS "dbNow"`;
        const epochs = await tx.$queryRaw<Array<{ generation: number }>>`
          SELECT "generation" FROM "CommandPublishEpoch" WHERE "status" = 'active' FOR SHARE`;
        if (!(clock?.dbNow instanceof Date) || !Number.isFinite(clock.dbNow.getTime()) || epochs.length !== 1) return null;
        const response = commandClockResponseSchema.safeParse({
          ...parsed.data,
          dbNow: clock.dbNow.toISOString(),
          publishEpoch: epochs[0].generation
        });
        return response.success ? response.data : null;
      });
    } catch {
      // DB outage, failed attestation, and primary transition all suppress the sample.
      return null;
    }
  }
}
