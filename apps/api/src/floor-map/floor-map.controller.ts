import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { FloorMapService } from "./floor-map.service";

@Controller("sites/:siteId/floors/:floorId/map-snapshot")
@UseGuards(SessionAuthGuard)
export class FloorMapController {
  constructor(private readonly floorMapService: FloorMapService) {}

  @Get()
  getSnapshot(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorMapService.getSnapshot(user, siteId, floorId);
  }
}
