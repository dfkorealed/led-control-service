import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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

interface GatewayInput {
  name: string;
  serialNumber: string;
  firmwareVersion?: string;
}

export interface CreateInitialSiteInput {
  organizationId: string;
  siteName: string;
  address: string;
  tariffKwhRate: number;
  floors: FloorInput[];
  gateway?: GatewayInput;
}

export interface AddFloorsInput {
  organizationId: string;
  siteId: string;
  floors: FloorInput[];
}

export interface RegisterGatewayInput {
  organizationId: string;
  siteId: string;
  name: string;
  serialNumber: string;
  firmwareVersion?: string;
}

@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesService: SitesService
  ) {}

  async createInitialSite(input: CreateInitialSiteInput) {
    this.validateInitialSiteInput(input);

    await this.assertGatewaySerialAvailable(input.gateway.serialNumber);

    try {
      await this.prisma.$transaction(async (tx) => {
        const existingSiteCount = await tx.site.count({ where: { organizationId: input.organizationId } });
        if (existingSiteCount > 0) throw new BadRequestException("initial site already exists");

        const createdSite = await tx.site.create({
          data: {
            organizationId: input.organizationId,
            name: input.siteName.trim(),
            address: input.address.trim(),
            tariffKwhRate: input.tariffKwhRate.toFixed(2)
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

        await tx.gateway.create({
          data: {
            siteId: createdSite.id,
            name: input.gateway.name.trim(),
            serialNumber: input.gateway.serialNumber.trim(),
            firmwareVersion: input.gateway.firmwareVersion?.trim() || "manual-unknown"
          }
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      this.throwMappedPrismaSetupError(error);
      throw error;
    }

    return this.sitesService.getDefaultDashboard(input.organizationId);
  }

  async addFloors(input: AddFloorsInput) {
    this.validateAddFloorsInput(input);
    await this.assertSiteInOrganization(input.siteId, input.organizationId);

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

    return this.sitesService.getDefaultDashboard(input.organizationId);
  }

  async registerGateway(input: RegisterGatewayInput) {
    this.validateRegisterGatewayInput(input);
    await this.assertSiteInOrganization(input.siteId, input.organizationId);
    await this.assertGatewaySerialAvailable(input.serialNumber);

    try {
      await this.prisma.gateway.create({
        data: {
          siteId: input.siteId,
          name: input.name.trim(),
          serialNumber: input.serialNumber.trim(),
          firmwareVersion: input.firmwareVersion?.trim() || "manual-unknown"
        }
      });
    } catch (error) {
      this.throwMappedPrismaSetupError(error);
      throw error;
    }

    return this.sitesService.getDefaultDashboard(input.organizationId);
  }

  private validateInitialSiteInput(input: CreateInitialSiteInput): asserts input is CreateInitialSiteInput & { gateway: GatewayInput } {
    if (!this.isRecord(input)) throw new BadRequestException("setup payload must be an object");
    this.requireString(input.organizationId, "organizationId is required");
    this.requireString(input.siteName, "siteName is required");
    this.requireString(input.address, "address is required");
    if (!Number.isFinite(input.tariffKwhRate) || input.tariffKwhRate <= 0 || input.tariffKwhRate > 100000) {
      throw new BadRequestException("tariffKwhRate must be greater than 0 and less than or equal to 100000");
    }
    this.validateFloors(input.floors);
    if (input.gateway === undefined) throw new BadRequestException("gateway is required");
    if (!this.isRecord(input.gateway)) throw new BadRequestException("gateway must be an object");
    this.requireString(input.gateway.name, "gateway name is required");
    this.requireString(input.gateway.serialNumber, "gateway serialNumber is required");
    if (input.gateway.firmwareVersion !== undefined) {
      this.requireString(input.gateway.firmwareVersion, "gateway firmwareVersion is required");
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
    this.requireString(input.organizationId, "organizationId is required");
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

  private validateRegisterGatewayInput(input: RegisterGatewayInput) {
    if (!this.isRecord(input)) throw new BadRequestException("gateway payload must be an object");
    this.requireString(input.organizationId, "organizationId is required");
    this.requireString(input.siteId, "siteId is required");
    this.requireString(input.name, "gateway name is required");
    this.requireString(input.serialNumber, "gateway serialNumber is required");
    if (input.firmwareVersion !== undefined) {
      this.requireString(input.firmwareVersion, "gateway firmwareVersion is required");
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
    if (this.isRecord(error) && error.code === "P2002") {
      throw new BadRequestException("gateway serialNumber already exists");
    }
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

  private async assertSiteInOrganization(siteId: string, organizationId: string) {
    const site = await this.prisma.site.findFirst({ where: { id: siteId, organizationId } });
    if (!site) throw new BadRequestException("siteId must reference a site in the current organization");
  }

  private async assertGatewaySerialAvailable(serialNumber: string) {
    const existingGateway = await this.prisma.gateway.findUnique({ where: { serialNumber: serialNumber.trim() } });
    if (existingGateway) throw new BadRequestException("gateway serialNumber already exists");
  }

  private async createFloorPlans(
    tx: Pick<Prisma.TransactionClient, "floor" | "floorPlan">,
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
