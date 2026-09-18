import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { parseMonitoringRefreshInput } from "./monitoring-refresh.dto";
import { MonitoringRefreshService } from "./monitoring-refresh.service";

@Controller()
@UseGuards(SessionAuthGuard)
export class MonitoringRefreshController {
  constructor(private readonly service: MonitoringRefreshService) {}

  @Post("sites/:siteId/floors/:floorId/monitoring-refreshes")
  create(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.service.create(user, siteId, floorId, parseMonitoringRefreshInput(body));
  }

  @Get("sites/:siteId/monitoring-refreshes/:refreshId")
  get(
    @Param("siteId") siteId: string,
    @Param("refreshId") refreshId: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.service.get(user, siteId, refreshId);
  }
}
