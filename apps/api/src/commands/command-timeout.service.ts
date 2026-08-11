import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS } from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";

const DEVICE_STATUS_TIMEOUT_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 15 * 60_000;

@Injectable()
export class CommandTimeoutService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    void this.closeExpired();
    this.timer = setInterval(() => void this.closeExpired(), 1000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async closeExpired(now = new Date()) {
    const dispatches = await this.prisma.commandDispatch.findMany({
      where: {
        OR: [
          { status: "pending", createdAt: { lt: new Date(now.getTime() - DELIVERY_TIMEOUT_MS) } },
          { status: "published", publishedAt: { lt: new Date(now.getTime() - GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS) } },
          { status: "accepted", acceptedAt: { lt: new Date(now.getTime() - DEVICE_STATUS_TIMEOUT_MS) } }
        ]
      },
      select: { id: true, commandId: true, status: true }
    });

    let timedOut = 0;
    for (const dispatch of dispatches) {
      const closed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.commandDispatch.updateMany({
          where: { id: dispatch.id, status: dispatch.status },
          data: {
            status: "timed_out",
            completedAt: now,
            errorCode: "COMMAND_TIMEOUT",
            errorMessage: "gateway command deadline exceeded"
          }
        });
        if (result.count !== 1) return false;
        await tx.commandFixtureResult.updateMany({
          where: { dispatchId: dispatch.id, status: "pending" },
          data: { status: "timed_out", occurredAt: now, errorMessage: "gateway command deadline exceeded" }
        });
        await tx.mqttOutbox.updateMany({
          where: { dispatchId: dispatch.id, publishedAt: null, deadLetteredAt: null },
          data: {
            deadLetteredAt: now,
            lastError: "command timed out before delivery",
            lockedBy: null,
            lockedAt: null,
            leaseExpiresAt: null
          }
        });
        await tx.command.updateMany({
          where: { id: dispatch.commandId, status: "pending" },
          data: { status: "failed", errorMessage: "one or more gateway dispatches timed out" }
        });
        return true;
      });
      if (closed) timedOut += 1;
    }
    return { timedOut };
  }
}
