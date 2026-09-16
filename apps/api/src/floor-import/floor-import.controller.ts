import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { type AuthenticatedUser } from "../auth/auth.types";
import { FloorImportService } from "./floor-import.service";

@UseGuards(SessionAuthGuard)
@Controller("floors/:floorId/import-jobs")
export class FloorImportController {
  constructor(private readonly imports: FloorImportService) {}

  @Post()
  create(@Param("floorId") floorId: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.create(user, floorId, body);
  }

  @Get(":jobId")
  get(@Param("floorId") floorId: string, @Param("jobId") jobId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.get(user, floorId, jobId);
  }

  @Get(":jobId/candidates")
  candidates(@Param("floorId") floorId: string, @Param("jobId") jobId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.listCandidates(user, floorId, jobId);
  }

  @Post(":jobId/cancel")
  @HttpCode(200)
  cancel(@Param("floorId") floorId: string, @Param("jobId") jobId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.cancel(user, floorId, jobId);
  }

  @Post(":jobId/apply")
  @HttpCode(200)
  apply(
    @Param("floorId") floorId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.imports.apply(user, floorId, jobId, body);
  }
}
