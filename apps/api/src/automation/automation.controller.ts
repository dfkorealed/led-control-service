import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { SchedulesService } from "./schedules.service";
import { VehicleEventRulesService } from "./vehicle-event-rules.service";

@UseGuards(SessionAuthGuard)
@Controller("sites/:siteId/automation/schedules")
export class AutomationController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(
    @Param("siteId") siteId: string,
    @Query() query: unknown,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.schedules.list(siteId, actor, query);
  }

  @Post()
  create(
    @Param("siteId") siteId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.schedules.create(siteId, actor, body);
  }

  @Patch(":scheduleId")
  update(
    @Param("siteId") siteId: string,
    @Param("scheduleId") scheduleId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.schedules.update(siteId, scheduleId, actor, body);
  }

  @Delete(":scheduleId")
  @HttpCode(HttpStatus.OK)
  remove(
    @Param("siteId") siteId: string,
    @Param("scheduleId") scheduleId: string,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.schedules.remove(siteId, scheduleId, actor);
  }
}

@UseGuards(SessionAuthGuard)
@Controller("sites/:siteId/automation/vehicle-event-rules")
export class VehicleEventRulesController {
  constructor(private readonly vehicleEventRules: VehicleEventRulesService) {}

  @Get()
  list(
    @Param("siteId") siteId: string,
    @Query() query: unknown,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.vehicleEventRules.list(siteId, actor, query);
  }

  @Post()
  create(
    @Param("siteId") siteId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.vehicleEventRules.create(siteId, actor, body);
  }

  @Patch(":ruleId")
  update(
    @Param("siteId") siteId: string,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.vehicleEventRules.update(siteId, ruleId, actor, body);
  }

  @Delete(":ruleId")
  @HttpCode(HttpStatus.OK)
  remove(
    @Param("siteId") siteId: string,
    @Param("ruleId") ruleId: string,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.vehicleEventRules.remove(siteId, ruleId, actor);
  }
}
