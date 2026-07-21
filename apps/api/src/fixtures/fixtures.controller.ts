import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { FixturesService } from "./fixtures.service";

@Controller("sites/:siteId/floors/:floorId/fixtures")
@UseGuards(SessionAuthGuard)
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
}
