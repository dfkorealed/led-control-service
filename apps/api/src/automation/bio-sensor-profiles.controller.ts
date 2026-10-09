import { Body, Controller, Get, Param, Put, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { BioSensorProfilesService } from "./bio-sensor-profiles.service";

@UseGuards(SessionAuthGuard)
@Controller("bio-sensor-profiles")
export class BioSensorProfilesController {
  constructor(private readonly profiles: BioSensorProfilesService) {}
  @Get() list(@CurrentUser() actor: AuthenticatedUser) { return this.profiles.list(actor); }
  @Post() create(@CurrentUser() actor: AuthenticatedUser, @Body() value: unknown) { return this.profiles.createRevision(actor, value); }
  @Post(":profileId/revoke") revoke(@CurrentUser() actor: AuthenticatedUser, @Param("profileId") profileId: string) { return this.profiles.revoke(actor, profileId); }
}

@UseGuards(SessionAuthGuard)
@Controller("sites/:siteId/bio-sensor-policy")
export class BioSensorSitePolicyController {
  constructor(private readonly profiles: BioSensorProfilesService) {}
  @Get() get(@CurrentUser() actor: AuthenticatedUser, @Param("siteId") siteId: string) { return this.profiles.getSitePolicy(actor, siteId); }
  @Put() set(@CurrentUser() actor: AuthenticatedUser, @Param("siteId") siteId: string, @Body() value: unknown) { return this.profiles.setSitePolicy(actor, siteId, value); }
}
