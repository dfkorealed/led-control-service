import { Body, Controller, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { FixtureIdentifyService } from "./fixture-identify.service";

@UseGuards(SessionAuthGuard)
@Controller("floors/:floorId/fixtures/:fixtureId/identify")
export class FixtureIdentifyController {
  constructor(private readonly service: FixtureIdentifyService) {}
  @Post()
  @HttpCode(200)
  identify(@Param("floorId") floorId: string, @Param("fixtureId") fixtureId: string,
    @CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.service.identify(floorId, fixtureId, user, body);
  }
}
