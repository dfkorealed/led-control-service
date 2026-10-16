import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { FixtureRegistrationRemovalsService, type RemovalScope } from "./fixture-registration-removals.service";

@Controller("sites/:siteId/floors/:floorId/fixtures/:fixtureId")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("admin")
export class FixtureRegistrationRemovalsController {
  constructor(private readonly operations: FixtureRegistrationRemovalsService) {}
  @Get("registration-removal-preview")
  preview(@CurrentUser() user: AuthenticatedUser, @Param() scope: RemovalScope) { return this.operations.preview(user, scope); }
  @Post("registration-removals")
  @HttpCode(202)
  create(@CurrentUser() user: AuthenticatedUser, @Param() scope: RemovalScope, @Body() body: unknown) {
    return this.operations.create(user, scope, body);
  }
  @Get("registration-removals/by-request/:clientRequestId")
  byRequest(@CurrentUser() user: AuthenticatedUser, @Param() params: RemovalScope & { clientRequestId: string }) {
    return this.operations.byRequest(user, removalScope(params), params.clientRequestId);
  }
  @Get("registration-removals/:operationId")
  get(@CurrentUser() user: AuthenticatedUser, @Param() params: RemovalScope & { operationId: string }) {
    return this.operations.get(user, removalScope(params), params.operationId);
  }
}
function removalScope({ siteId, floorId, fixtureId }: RemovalScope): RemovalScope { return { siteId, floorId, fixtureId }; }
