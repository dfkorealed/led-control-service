import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const RETENTION_MONTHS = 24;
const BATCH_SIZE = 10_000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class EnergyRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnergyRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (this.timer) return;
    const intervalMs = Number(process.env.ENERGY_RETENTION_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    this.timer = setInterval(() => {
      void this.prune().catch((error) => this.logger.error(
        `energy retention sweep failed (error=${errorCode(error)})`
      ));
    }, intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async prune(now = new Date()) {
    const cutoff = subtractUtcMonths(now, RETENTION_MONTHS);
    const deleted = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      DELETE FROM "FixtureEnergyHourlyAggregate"
      WHERE "id" IN (
        SELECT "id"
        FROM "FixtureEnergyHourlyAggregate"
        WHERE "bucketStartUtc" < ${cutoff}
        ORDER BY "bucketStartUtc", "id"
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"
    `);
    return deleted.length;
  }
}

function subtractUtcMonths(value: Date, months: number) {
  const targetMonthIndex = value.getUTCFullYear() * 12 + value.getUTCMonth() - months;
  const year = Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(value.getUTCDate(), lastDay),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds()
  ));
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : "UNEXPECTED_ERROR";
}
