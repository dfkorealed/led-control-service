import { Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { FloorMapService } from "./floor-map.service";

@Controller("sites/:siteId/floors/:floorId")
@UseGuards(SessionAuthGuard)
export class FloorMapController {
  constructor(private readonly floorMapService: FloorMapService) {}

  @Get("map-snapshot")
  getSnapshot(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorMapService.getSnapshot(user, siteId, floorId);
  }

  @Get("cad-scene")
  getCadSceneState(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorMapService.getCadSceneState(user, siteId, floorId);
  }

  @Put("cad-scene")
  editCadScene(
    @Param("siteId") siteId: string,
    @Param("floorId") floorId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorMapService.editCadScene(user, siteId, floorId, body);
  }
}
