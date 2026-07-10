import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { SetupService } from "./setup.service";

interface FloorPlanBody {
  imageUrl: string;
  width: number;
  height: number;
}

interface FloorBody {
  name: string;
  level: number;
  floorPlan?: FloorPlanBody;
}

interface InitialSiteSetupBody {
  siteName: string;
  address: string;
  tariffKwhRate: number;
  floors: FloorBody[];
  gateway?: {
    name: string;
    serialNumber: string;
  };
}

interface AddFloorsBody {
  siteId: string;
  floors: FloorBody[];
}

interface RegisterGatewayBody {
  siteId: string;
  name: string;
  serialNumber: string;
  firmwareVersion?: string;
}

@UseGuards(SessionAuthGuard)
@Controller("setup")
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Post("initial-site")
  createInitialSite(@CurrentUser() user: AuthenticatedUser, @Body() body: InitialSiteSetupBody) {
    return this.setupService.createInitialSite(this.withOrganizationId(body, user.organizationId));
  }

  @Post("floors")
  addFloors(@CurrentUser() user: AuthenticatedUser, @Body() body: AddFloorsBody) {
    return this.setupService.addFloors(this.withOrganizationId(body, user.organizationId));
  }

  @Post("gateways")
  registerGateway(@CurrentUser() user: AuthenticatedUser, @Body() body: RegisterGatewayBody) {
    return this.setupService.registerGateway(this.withOrganizationId(body, user.organizationId));
  }

  private withOrganizationId<T>(body: T, organizationId: string): T & { organizationId: string } {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return { ...body, organizationId };
    }
    return { organizationId } as T & { organizationId: string };
  }
}
