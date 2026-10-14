import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { CreateTemporaryControlInput, EndTemporaryControlInput, TemporaryControlListQuery } from "@led-control/shared";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { TemporaryControlsService } from "./temporary-controls.service";

@UseGuards(SessionAuthGuard)
@Controller("sites/:siteId/temporary-controls")
export class TemporaryControlsController {
  constructor(private readonly controls: TemporaryControlsService) {}
  @Post()
  @HttpCode(202)
  @Header("Cache-Control", "private, no-store")
  start(@Param("siteId") siteId: string, @CurrentUser() actor: AuthenticatedUser, @Body() input: CreateTemporaryControlInput) {
    return this.controls.start(siteId, actor, input);
  }
  @Post(":id/end")
  @HttpCode(202)
  @Header("Cache-Control", "private, no-store")
  end(@Param("siteId") siteId: string, @Param("id") id: string, @CurrentUser() actor: AuthenticatedUser, @Body() input: EndTemporaryControlInput) {
    return this.controls.end(siteId, id, actor, input);
  }
  @Get(":id")
  @Header("Cache-Control", "private, no-store")
  get(@Param("siteId") siteId: string, @Param("id") id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.controls.get(siteId, id, actor);
  }
  @Get()
  @Header("Cache-Control", "private, no-store")
  list(@Param("siteId") siteId: string, @CurrentUser() actor: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.controls.list(siteId, actor, { ...query, ...(typeof query.limit === "string" ? { limit: Number(query.limit) } : {}) } as TemporaryControlListQuery);
  }
}
