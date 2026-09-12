import { Body, Controller, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { FixturesService } from "./fixtures.service";

@Controller("sites/:siteId/floors/:floorId/fixtures")
@UseGuards(SessionAuthGuard, RolesGuard)
export class FixturesController {
  constructor(private readonly fixturesService: FixturesService) {}

  @Get()
  getFloorFixtures(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.fixturesService.getFloorFixtures(user, siteId, floorId, {
      cursor,
      limit: limit === undefined ? undefined : Number(limit)
    });
  }

  @Patch(":fixtureId")
  @Roles("admin")
  updateMetadata(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @Param("fixtureId") fixtureId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.fixturesService.updateMetadata(user, siteId, floorId, fixtureId, body);
  }
}
