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
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { FixtureEnergyCheckpointService } from "../energy/fixture-state-ingestion.service";
import { PrismaService } from "../prisma/prisma.service";

const expectedUpdatedAtSchema = z.string().datetime({ offset: true });

const siteSettingsSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  name: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  timeZone: z.string().trim().min(1).max(100).refine(isIanaTimeZone).optional(),
  currency: z.literal("KRW").optional(),
  tariffKwhRate: z.number().finite().min(0).max(99_999_999.99).multipleOf(0.01).optional()
}).strict().refine(hasMutableFields);

const createFloorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  level: z.number().int(),
  displayOrder: z.number().int().min(0).default(0)
}).strict();

const updateFloorSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  name: z.string().trim().min(1).max(120).optional(),
  level: z.number().int().optional(),
  displayOrder: z.number().int().min(0).optional(),
  status: z.literal("active").optional()
}).strict().refine(hasMutableFields);

const archiveFloorSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema
}).strict();

const siteSettingsSelect = {
  id: true,
  name: true,
  address: true,
  timeZone: true,
  currency: true,
  tariffKwhRate: true,
  updatedAt: true
} satisfies Prisma.SiteSelect;

const floorSelect = {
  id: true,
  siteId: true,
  name: true,
  level: true,
  status: true,
  displayOrder: true,
  updatedAt: true
} satisfies Prisma.FloorSelect;

type LockedFloor = {
  id: string;
  siteId: string;
  name: string;
  level: number;
  status: "active" | "archived";
  displayOrder: number;
  updatedAt: Date;
};

type LockedSite = {
  id: string;
  address: string | null;
  tariffKwhRate: Prisma.Decimal | null;
  timeZone: string;
  updatedAt: Date;
};

const SITE_SETTINGS_TRANSACTION_TIMEOUT_MS = 30_000;

@Injectable()
export class SiteSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly energyDimensions: EnergyDimensionHistoryService,
    private readonly energyCheckpoint: FixtureEnergyCheckpointService
  ) {}

  async getSettings(user: AuthenticatedUser, siteId: string) {
    await this.siteAccess.assert(user, siteId, "manage");
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        ...siteSettingsSelect,
        floors: {
          orderBy: [{ displayOrder: "asc" }, { level: "asc" }, { id: "asc" }],
          select: {
            id: true,
            name: true,
            level: true,
            status: true,
            displayOrder: true,
            updatedAt: true,
            _count: {
              select: {
                fixtures: true,
                fixtureGroups: { where: { lifecycleStatus: "active" } }
              }
            }
          }
        }
      }
    });
    if (!site) throw new NotFoundException("site not found");

    const { floors, ...settings } = site;
    return {
      site: {
        ...settings,
        updatedAt: settings.updatedAt.toISOString(),
        tariffKwhRate: settings.tariffKwhRate === null ? null : Number(settings.tariffKwhRate)
      },
      floors: floors.map(({ _count, ...floor }) => ({
        ...floor,
        updatedAt: floor.updatedAt.toISOString(),
        fixtureCount: _count.fixtures,
        activeGroupCount: _count.fixtureGroups
      }))
    };
  }

  async updateSite(user: AuthenticatedUser, siteId: string, rawInput: unknown) {
    await this.siteAccess.assert(user, siteId, "manage");
    const input = parse(siteSettingsSchema, rawInput, "invalid site settings request");
    const { expectedUpdatedAt, ...changes } = input;

    const site = await this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      const current = await this.lockSite(tx, siteId);
      this.assertCurrentVersion(current.updatedAt, expectedUpdatedAt);
      let changedAt = new Date();
      if (this.energySettingsChanged(current, changes) && current.tariffKwhRate !== null) {
        changedAt = await this.energyCheckpoint.closeSiteSettingsIntervals(tx, {
          siteId,
          timeZone: current.timeZone,
          tariffKwhRate: current.tariffKwhRate
        });
      }
      return tx.site.update({
        where: { id: siteId },
        data: {
          ...changes,
          ...(changes.tariffKwhRate === undefined
            ? {}
            : { tariffKwhRate: new Prisma.Decimal(changes.tariffKwhRate) }),
          updatedAt: changedAt
        },
        select: siteSettingsSelect
      });
    }, { timeout: SITE_SETTINGS_TRANSACTION_TIMEOUT_MS });

    return {
      ...site,
      updatedAt: site.updatedAt.toISOString(),
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
    const { expectedUpdatedAt, ...changes } = input;

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      const floor = await this.lockFloor(tx, siteId, floorId);
      this.assertCurrentVersion(floor.updatedAt, expectedUpdatedAt);
      if (changes.status === "active" && floor.status !== "archived") {
        throw new BadRequestException("only archived floors can be restored");
      }
      const changedAt = new Date();
      if (changes.name !== undefined && changes.name !== floor.name) {
        const fixtures = await tx.fixture.findMany({
          where: { siteId, floorId },
          select: {
            id: true,
            siteId: true,
            floorId: true,
            name: true,
            ratedWatt: true,
            energyTrackingStartedAt: true
          }
        });
        await this.energyDimensions.ensureFixtureDimensions(
          tx,
          fixtures.map((fixture) => ({
            fixtureId: fixture.id,
            siteId: fixture.siteId,
            name: fixture.name,
            floorId: fixture.floorId,
            floorName: changes.name!,
            ratedWatt: fixture.ratedWatt,
            trackingStartedAt: fixture.energyTrackingStartedAt
          })),
          changedAt
        );
      }
      return tx.floor.update({
        where: { id: floorId },
        data: { ...changes, updatedAt: changedAt },
        select: floorSelect
      });
    });
  }

  async archiveFloor(user: AuthenticatedUser, siteId: string, floorId: string, rawInput: unknown) {
    await this.siteAccess.assert(user, siteId, "manage");
    const input = parse(archiveFloorSchema, rawInput, "invalid floor archive request");

    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, siteId);
      const floor = await this.lockFloor(tx, siteId, floorId);
      this.assertCurrentVersion(floor.updatedAt, input.expectedUpdatedAt);

      const [fixtureCount, activeGroupCount, activeSessionCount] = await Promise.all([
        tx.fixture.count({ where: { siteId, floorId } }),
        tx.fixtureGroup.count({ where: { siteId, floorId, lifecycleStatus: "active" } }),
        tx.provisioningSession.count({ where: { siteId, floorId, status: "active" } })
      ]);
      if (activeSessionCount > 0) {
        throw new ConflictException({ code: "floor_has_active_registration" });
      }
      if (fixtureCount > 0 || activeGroupCount > 0) {
        throw new ConflictException("floor contains fixtures or active fixture groups");
      }

      return tx.floor.update({
        where: { id: floorId },
        data: { status: "archived", updatedAt: new Date() },
        select: floorSelect
      });
    });
  }

  private async lockFloor(tx: Prisma.TransactionClient, siteId: string, floorId: string) {
    const rows = await tx.$queryRaw<LockedFloor[]>(Prisma.sql`
      SELECT "id", "siteId", "name", "level", "status", "displayOrder", "updatedAt"
      FROM "Floor"
      WHERE "id" = ${floorId} AND "siteId" = ${siteId}
      FOR UPDATE
    `);
    if (!rows[0]) throw new NotFoundException("floor not found");
    return rows[0];
  }

  private async lockSite(tx: Prisma.TransactionClient, siteId: string) {
    const rows = await tx.$queryRaw<LockedSite[]>(Prisma.sql`
      SELECT "id", "address", "tariffKwhRate", "timeZone", "updatedAt"
      FROM "Site"
      WHERE "id" = ${siteId}
      FOR UPDATE
    `);
    if (!rows[0]) throw new NotFoundException("site not found");
    return rows[0];
  }

  private assertCurrentVersion(current: Date, expected: string) {
    if (current.getTime() !== new Date(expected).getTime()) {
      throw new ConflictException({ code: "settings_version_conflict" });
    }
  }

  private energySettingsChanged(
    current: LockedSite,
    changes: { timeZone?: string; tariffKwhRate?: number }
  ) {
    return (changes.timeZone !== undefined && changes.timeZone !== current.timeZone)
      || (changes.tariffKwhRate !== undefined
        && (current.tariffKwhRate === null || !current.tariffKwhRate.equals(changes.tariffKwhRate)));
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException(message);
  return parsed.data;
}

function hasMutableFields(input: object) {
  return Object.keys(input).some((key) => key !== "expectedUpdatedAt");
}

function isIanaTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
