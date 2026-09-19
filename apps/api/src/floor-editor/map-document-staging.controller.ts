import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { MapDocumentStagingService } from "./map-document-staging.service";

@Controller("floors/:floorId/editor-stages")
@UseGuards(SessionAuthGuard)
export class MapDocumentStagingController {
  constructor(private readonly stages: MapDocumentStagingService) {}
  @Post()
  create(@Param("floorId") floorId: string, @CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.stages.create(floorId, user, body);
  }
  @Put(":stageId/parts/:part")
  part(@Param("floorId") floorId: string, @Param("stageId") id: string, @Param("part") part: string,
    @CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.stages.part(floorId, id, part, user, body);
  }
  @Post(":stageId/commit")
  @HttpCode(202)
  commit(@Param("floorId") floorId: string, @Param("stageId") id: string, @CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.stages.commit(floorId, id, user, body);
  }
  @Post(":stageId/prepare")
  @HttpCode(202)
  prepare(@Param("floorId") floorId: string, @Param("stageId") id: string, @CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.stages.prepare(floorId, id, user, body);
  }
  @Get(":stageId")
  status(@Param("floorId") floorId: string, @Param("stageId") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.stages.status(floorId, id, user);
  }
  @Delete(":stageId")
  cancel(@Param("floorId") floorId: string, @Param("stageId") id: string, @CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.stages.cancel(floorId, id, user, body);
  }
}
