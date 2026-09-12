import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

const siteSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().max(500).nullable().optional(),
  timeZone: z.string().trim().min(1).max(100).refine(isIanaTimeZone).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  tariffKwhRate: z.number().finite().min(0).max(99_999_999.99).multipleOf(0.01).nullable().optional()
}).strict().refine(hasFields);

const createFloorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  level: z.number().int(),
  displayOrder: z.number().int().min(0).default(0)
}).strict();

const updateFloorSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  level: z.number().int().optional(),
  displayOrder: z.number().int().min(0).optional()
}).strict().refine(hasFields);

const siteSettingsSelect = {
  id: true,
  name: true,
  address: true,
  timeZone: true,
  currency: true,
  tariffKwhRate: true
} satisfies Prisma.SiteSelect;

const floorSelect = {
  id: true,
  siteId: true,
  name: true,
  level: true,
  status: true,
  displayOrder: true
} satisfies Prisma.FloorSelect;

type LockedFloor = {
  id: string;
  siteId: string;
  name: string;
  level: number;
  status: "active" | "archived";
  displayOrder: number;
};

@Injectable()
export class SiteSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async updateSite(user: AuthenticatedUser, siteId: string, rawInput: unknown) {
    await this.siteAccess.assert(user, siteId, "manage");
    const input = parse(siteSettingsSchema, rawInput, "invalid site settings request");

    const site = await this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      return tx.site.update({
        where: { id: siteId },
        data: {
          ...input,
          ...(input.tariffKwhRate === undefined || input.tariffKwhRate === null
            ? {}
            : { tariffKwhRate: new Prisma.Decimal(input.tariffKwhRate) })
        },
        select: siteSettingsSelect
      });
    });

    return {
      ...site,
      tariffKwhRate: site.tariffKwhRate === null ? null : Number(site.tariffKwhRate)
    };
  }

  async createFloor(user: AuthenticatedUser, siteId: string, rawInput: unknown) {
    await this.siteAccess.assert(user, siteId, "manage");
    const input = parse(createFloorSchema, rawInput, "invalid floor request");

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      return tx.floor.create({
        data: { siteId, ...input, status: "active" },
        select: floorSelect
      });
    });
  }

  async updateFloor(
    user: AuthenticatedUser,
    siteId: string,
    floorId: string,
    rawInput: unknown
  ) {
    await this.siteAccess.assert(user, siteId, "manage");
    const input = parse(updateFloorSchema, rawInput, "invalid floor request");

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      await this.lockFloor(tx, siteId, floorId);
      return tx.floor.update({ where: { id: floorId }, data: input, select: floorSelect });
    });
  }

  async archiveFloor(user: AuthenticatedUser, siteId: string, floorId: string) {
    await this.siteAccess.assert(user, siteId, "manage");

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      await this.lockFloor(tx, siteId, floorId);

      const [fixtureCount, activeGroupCount] = await Promise.all([
        tx.fixture.count({ where: { siteId, floorId } }),
        tx.fixtureGroup.count({ where: { siteId, floorId, lifecycleStatus: "active" } })
      ]);
      if (fixtureCount > 0 || activeGroupCount > 0) {
        throw new ConflictException("floor contains fixtures or active fixture groups");
      }

      return tx.floor.update({
        where: { id: floorId },
        data: { status: "archived" },
        select: floorSelect
      });
    });
  }

  private async lockFloor(tx: Prisma.TransactionClient, siteId: string, floorId: string) {
    const rows = await tx.$queryRaw<LockedFloor[]>(Prisma.sql`
      SELECT "id", "siteId", "name", "level", "status", "displayOrder"
      FROM "Floor"
      WHERE "id" = ${floorId} AND "siteId" = ${siteId}
      FOR UPDATE
    `);
    if (!rows[0]) throw new NotFoundException("floor not found");
    return rows[0];
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(message);
  return parsed.data;
}

function hasFields(input: object) {
  return Object.keys(input).length > 0;
}

function isIanaTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
