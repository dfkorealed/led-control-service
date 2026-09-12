import { Body, Controller, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { MonitoringIncidentsService } from "./monitoring-incidents.service";

@UseGuards(SessionAuthGuard)
@Controller("sites/:siteId")
export class MonitoringIncidentsController {
  constructor(private readonly incidents: MonitoringIncidentsService) {}

  @Get("monitoring-policy")
  policy(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string) {
    return this.incidents.getPolicy(user, siteId);
  }

  @Patch("monitoring-policy")
  updatePolicy(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Body() body: unknown) {
    return this.incidents.updatePolicy(user, siteId, body);
  }

  @Get("monitoring-incidents")
  list(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Query() query: unknown) {
    return this.incidents.list(user, siteId, query);
  }

  @Patch("monitoring-incidents/:incidentId")
  update(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Param("incidentId") id: string, @Body() body: unknown) {
    return this.incidents.update(user, siteId, id, body);
  }
}
