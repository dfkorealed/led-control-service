import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
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
  customerOrganizationName: string;
  siteName: string;
  address: string;
  tariffKwhRate: number;
  timeZone?: string;
  floors: FloorBody[];
}

interface AddFloorsBody {
  siteId: string;
  floors: FloorBody[];
}

@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("operator")
@Controller("setup")
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  @Post("initial-site")
  createInitialSite(@CurrentUser() user: AuthenticatedUser, @Body() body: InitialSiteSetupBody) {
    return this.setupService.createInitialSite(user, body);
  }

  @Post("floors")
  addFloors(@CurrentUser() user: AuthenticatedUser, @Body() body: AddFloorsBody) {
    return this.setupService.addFloors(user, body);
  }
}
