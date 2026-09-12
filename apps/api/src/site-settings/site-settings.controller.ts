import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { SiteSettingsService } from "./site-settings.service";

@Controller("sites/:siteId")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("admin")
export class SiteSettingsController {
  constructor(private readonly siteSettingsService: SiteSettingsService) {}

  @Get("settings")
  getSettings(@Param("siteId") siteId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.siteSettingsService.getSettings(user, siteId);
  }

  @Patch("settings")
  updateSite(
    @Param("siteId") siteId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.siteSettingsService.updateSite(user, siteId, body);
  }

  @Post("floors")
  createFloor(
    @Param("siteId") siteId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.siteSettingsService.createFloor(user, siteId, body);
  }

  @Patch("floors/:floorId")
  updateFloor(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.siteSettingsService.updateFloor(user, siteId, floorId, body);
  }

  @Post("floors/:floorId/archive")
  @HttpCode(HttpStatus.OK)
  archiveFloor(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.siteSettingsService.archiveFloor(user, siteId, floorId);
  }
}
