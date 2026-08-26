import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { SitesService } from "../sites/sites.service";

interface FloorPlanInput {
  imageUrl: string;
  width: number;
  height: number;
}

interface FloorInput {
  name: string;
  level: number;
  floorPlan?: FloorPlanInput;
}

export interface CreateInitialSiteInput {
  customerOrganizationName: string;
  siteName: string;
  address: string;
  tariffKwhRate: number;
  timeZone?: string;
  floors: FloorInput[];
}

export interface AddFloorsInput {
  siteId: string;
  floors: FloorInput[];
}

@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesService: SitesService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async createInitialSite(user: AuthenticatedUser, input: CreateInitialSiteInput) {
    this.assertServiceProviderOperator(user);
    this.validateInitialSiteInput(input);

    try {
      const siteId = await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name: input.customerOrganizationName.trim(), type: "customer" }
        });

        const createdSite = await tx.site.create({
          data: {
            organizationId: organization.id,
            name: input.siteName.trim(),
            address: input.address.trim(),
            tariffKwhRate: input.tariffKwhRate.toFixed(2),
            ...(input.timeZone ? { timeZone: input.timeZone } : {})
          }
        });

        await tx.floor.createMany({
          data: input.floors.map((floor) => ({
            siteId: createdSite.id,
            name: floor.name.trim(),
            level: floor.level
          }))
        });

        await this.createFloorPlans(tx, createdSite.id, input.floors);
        await tx.siteMembership.create({ data: { userId: user.id, siteId: createdSite.id } });
        return createdSite.id;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return this.sitesService.getDashboardById(siteId);
    } catch (error) {
      this.throwMappedPrismaSetupError(error);
      throw error;
    }

  }

  async addFloors(user: AuthenticatedUser, input: AddFloorsInput) {
    this.assertServiceProviderOperator(user);
    this.validateAddFloorsInput(input);
    await this.siteAccess.assert(user, input.siteId, "commission");

    try {
      await this.prisma.$transaction(async (tx) => {
        const existingFloors = await tx.floor.findMany({
          where: { siteId: input.siteId },
          select: { name: true, level: true }
        });
        this.assertNoExistingFloorDuplicates(input.floors, existingFloors);

        await tx.floor.createMany({
          data: input.floors.map((floor) => ({
            siteId: input.siteId,
            name: floor.name.trim(),
            level: floor.level
          }))
        });

        await this.createFloorPlans(tx, input.siteId, input.floors);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwMappedPrismaSetupError(error);
      throw error;
    }

    return this.sitesService.getDashboardById(input.siteId);
  }

  private validateInitialSiteInput(input: CreateInitialSiteInput) {
    if (!this.isRecord(input)) throw new BadRequestException("setup payload must be an object");
    this.requireString(input.customerOrganizationName, "customerOrganizationName is required");
    this.requireString(input.siteName, "siteName is required");
    this.requireString(input.address, "address is required");
    if (!Number.isFinite(input.tariffKwhRate) || input.tariffKwhRate <= 0 || input.tariffKwhRate > 100000) {
      throw new BadRequestException("tariffKwhRate must be greater than 0 and less than or equal to 100000");
    }
    if (input.timeZone !== undefined) this.validateTimeZone(input.timeZone);
    this.validateFloors(input.floors);
  }

  private validateTimeZone(value: unknown) {
    if (typeof value !== "string" || value.length === 0) {
      throw new BadRequestException("timeZone must be a valid IANA timezone");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    } catch {
      throw new BadRequestException("timeZone must be a valid IANA timezone");
    }
  }

  private validateFloors(floors: FloorInput[]) {
    if (!Array.isArray(floors) || floors.length < 1) throw new BadRequestException("floors must contain at least 1 item");

    const names = new Set<string>();
    const levels = new Set<number>();
    for (const floor of floors) {
      if (!this.isRecord(floor)) throw new BadRequestException("floor must be an object");
      this.requireString(floor.name, "floor name is required");
      const name = floor.name.trim();
      if (!Number.isFinite(floor.level) || !Number.isInteger(floor.level)) {
        throw new BadRequestException("floor level must be a finite integer");
      }
      if (floor.level < -100 || floor.level > 100 || floor.level === 0) {
        throw new BadRequestException("floor level must be between -100 and 100 and cannot be 0");
      }
      this.validateFloorPlan(floor.floorPlan);
      if (names.has(name)) throw new BadRequestException("floor names must be unique");
      if (levels.has(floor.level)) throw new BadRequestException("floor levels must be unique");
      names.add(name);
      levels.add(floor.level);
    }
  }

  private validateAddFloorsInput(input: AddFloorsInput) {
    if (!this.isRecord(input)) throw new BadRequestException("add floors payload must be an object");
    this.requireString(input.siteId, "siteId is required");
    this.validateFloors(input.floors);
  }

  private validateFloorPlan(floorPlan: FloorPlanInput | undefined) {
    if (floorPlan === undefined) return;
    if (!this.isRecord(floorPlan)) throw new BadRequestException("floorPlan must be an object");
    this.requireString(floorPlan.imageUrl, "floorPlan imageUrl is required");
    if (!Number.isInteger(floorPlan.width) || floorPlan.width <= 0) {
      throw new BadRequestException("floorPlan width must be a positive integer");
    }
    if (!Number.isInteger(floorPlan.height) || floorPlan.height <= 0) {
      throw new BadRequestException("floorPlan height must be a positive integer");
    }
  }

  private requireString(value: unknown, message: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException(message);
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private throwMappedPrismaSetupError(error: unknown) {
    if (this.isRecord(error) && error.code === "P2034") {
      throw new ConflictException("setup transaction conflicted, please retry");
    }
  }

  private assertNoExistingFloorDuplicates(
    floors: FloorInput[],
    existingFloors: Array<{ name: string; level: number }>
  ) {
    const existingNames = new Set(existingFloors.map((floor) => floor.name.trim()));
    const existingLevels = new Set(existingFloors.map((floor) => floor.level));
    for (const floor of floors) {
      if (existingNames.has(floor.name.trim())) throw new BadRequestException("floor names must be unique");
      if (existingLevels.has(floor.level)) throw new BadRequestException("floor levels must be unique");
    }
  }

  private assertServiceProviderOperator(user: AuthenticatedUser) {
    if (user.role !== "operator" || user.organizationType !== "service_provider") {
      throw new ForbiddenException("setup requires a service-provider operator");
    }
  }

  private async createFloorPlans(
    tx: Pick<Prisma.TransactionClient, "organization" | "site" | "siteMembership" | "floor" | "floorPlan">,
    siteId: string,
    floors: FloorInput[]
  ) {
    for (const floor of floors) {
      if (!floor.floorPlan) continue;
      const createdFloor = await tx.floor.findFirstOrThrow({
        where: { siteId, name: floor.name.trim(), level: floor.level }
      });
      await tx.floorPlan.create({
        data: {
          floorId: createdFloor.id,
          imageUrl: floor.floorPlan.imageUrl.trim(),
          width: floor.floorPlan.width,
          height: floor.floorPlan.height
        }
      });
    }
  }
}
