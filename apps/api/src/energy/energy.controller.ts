import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { EnergyService } from "./energy.service";

@UseGuards(SessionAuthGuard)
@Controller("energy")
export class EnergyController {
  constructor(private readonly energyService: EnergyService) {}

  @Get("default/estimate")
  getDefaultEstimate(@CurrentUser() user: AuthenticatedUser) {
    return this.energyService.getDefaultSiteEstimate(user.organizationId);
  }
}
