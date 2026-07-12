import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { SitesService } from "./sites.service";

@UseGuards(SessionAuthGuard)
@Controller("sites")
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  @Get("default/dashboard")
  getDefaultDashboard(@CurrentUser() user: AuthenticatedUser, @Query("includeFixtures") includeFixtures?: string) {
    return this.sitesService.getDefaultDashboard(user.organizationId, includeFixtures === "true");
  }
}
