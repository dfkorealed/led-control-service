import { Body, Controller, Get, Header, HttpCode, Param, Post, Redirect, UseGuards } from "@nestjs/common";
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

  @Get("active")
  active(@Param("floorId") floorId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.getActive(user, floorId);
  }

  @Get("applied-overlay")
  appliedOverlay(@Param("floorId") floorId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.getAppliedOverlay(user, floorId);
  }

  @Get(":jobId")
  get(@Param("floorId") floorId: string, @Param("jobId") jobId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.get(user, floorId, jobId);
  }

  @Get(":jobId/candidates")
  candidates(@Param("floorId") floorId: string, @Param("jobId") jobId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.listCandidates(user, floorId, jobId);
  }

  @Get(":jobId/regions")
  regions(@Param("floorId") floorId: string, @Param("jobId") jobId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.imports.listRegions(user, floorId, jobId);
  }

  @Post(":jobId/regions/select")
  @HttpCode(200)
  selectRegion(
    @Param("floorId") floorId: string,
    @Param("jobId") jobId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.imports.selectRegion(user, floorId, jobId, body);
  }

  @Get(":jobId/scene/manifest/content")
  @Header("Cache-Control", "private, no-store")
  sceneManifest(
    @Param("floorId") floorId: string,
    @Param("jobId") jobId: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.imports.getSceneManifestContent(user, floorId, jobId);
  }

  @Get(":jobId/scene/tiles/:lod/:tileX/:tileY/:part/content")
  @Redirect(undefined, 302)
  @Header("Cache-Control", "private, no-store")
  sceneTile(
    @Param("floorId") floorId: string,
    @Param("jobId") jobId: string,
    @Param("lod") lod: string,
    @Param("tileX") tileX: string,
    @Param("tileY") tileY: string,
    @Param("part") part: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.imports.getSceneTileContent(user, floorId, jobId, {
      lod: Number(lod), tileX: Number(tileX), tileY: Number(tileY), part: Number(part)
    });
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
