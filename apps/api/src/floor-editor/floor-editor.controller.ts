import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { FloorEditorService } from "./floor-editor.service";
import { EditorLeaseService } from "./editor-lease.service";

@UseGuards(SessionAuthGuard)
@Controller()
export class FloorEditorController {
  constructor(
    private readonly floorEditorService: FloorEditorService,
    private readonly editorLeaseService: EditorLeaseService
  ) {}

  @Post("floors/:floorId/editor-lease")
  acquireLease(
    @Param("floorId") floorId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.editorLeaseService.acquire(floorId, user, this.readLeaseToken(body));
  }

  @Delete("floors/:floorId/editor-lease")
  releaseLease(
    @Param("floorId") floorId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.editorLeaseService.release(floorId, user, this.readForce(body), this.readLeaseToken(body));
  }

  @Get("floors/:floorId/editor-state")
  getEditorState(@Param("floorId") floorId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.floorEditorService.getEditorState(floorId, user);
  }

  @Put("floors/:floorId/editor-state")
  saveEditorState(
    @Param("floorId") floorId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorEditorService.saveEditorState(user, floorId, body);
  }

  @Get("floors/:floorId/editor-revisions")
  listEditorRevisions(
    @Param("floorId") floorId: string,
    @Query() query: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorEditorService.listEditorRevisions(user, floorId, query);
  }

  @Post("floors/:floorId/editor-revisions/:revision/restore")
  restoreEditorRevision(
    @Param("floorId") floorId: string,
    @Param("revision") revision: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorEditorService.restoreEditorRevision(user, floorId, revision, body);
  }

  @Patch("floors/:floorId/floor-plan")
  updateFloorPlan(
    @Param("floorId") floorId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorEditorService.updateFloorPlan(floorId, body, user);
  }

  @Patch("fixtures/:fixtureId")
  updateFixture(
    @Param("fixtureId") fixtureId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorEditorService.updateFixture(fixtureId, body, user);
  }

  @Post("floor-map-objects")
  createObject(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthenticatedUser) {
    return this.floorEditorService.createObject(body as never, user);
  }

  @Patch("floor-map-objects/:objectId")
  updateObject(
    @Param("objectId") objectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.floorEditorService.updateObject(objectId, body, user);
  }

  @Delete("floor-map-objects/:objectId")
  deleteObject(@Param("objectId") objectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.floorEditorService.deleteObject(objectId, user);
  }

  private readLeaseToken(body: Record<string, unknown>) {
    const token = body.token;
    if (token === undefined) return undefined;
    if (typeof token !== "string" || token.trim().length === 0 || token.length > 256) {
      throw new BadRequestException("invalid editor lease token");
    }
    return token;
  }

  private readForce(body: Record<string, unknown>) {
    const force = body.force;
    if (force === undefined) return false;
    if (typeof force !== "boolean") throw new BadRequestException("invalid editor lease force flag");
    return force;
  }
}
