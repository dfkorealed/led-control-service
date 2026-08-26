import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { FixtureGroupsService } from "./fixture-groups.service";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@UseGuards(SessionAuthGuard, RolesGuard)
@Controller("sites/:siteId/fixture-groups")
export class FixtureGroupsController {
  constructor(private readonly fixtureGroupsService: FixtureGroupsService) {}

  @Get()
  list(
    @Param("siteId") siteId: string,
    @Query() query: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.fixtureGroupsService.list(user, siteId, this.readFloorIdQuery(query));
  }

  @Post()
  @Roles("operator", "admin")
  create(@Param("siteId") siteId: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.fixtureGroupsService.create(user, siteId, body);
  }

  @Patch(":groupId")
  @Roles("operator", "admin")
  update(
    @Param("siteId") siteId: string,
    @Param("groupId") groupId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.fixtureGroupsService.update(user, siteId, groupId, body);
  }

  @Delete(":groupId")
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles("operator", "admin")
  remove(@Param("siteId") siteId: string, @Param("groupId") groupId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.fixtureGroupsService.remove(user, siteId, groupId);
  }

  @Post(":groupId/resync")
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles("operator", "admin")
  resync(@Param("siteId") siteId: string, @Param("groupId") groupId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.fixtureGroupsService.resync(user, siteId, groupId);
  }

  private readFloorIdQuery(query: unknown) {
    if (!query || Array.isArray(query) || typeof query !== "object") {
      throw new BadRequestException("invalid fixture group query");
    }
    const entries = Object.entries(query);
    if (entries.some(([key]) => key !== "floorId")) throw new BadRequestException("invalid fixture group query");
    const floorId = (query as { floorId?: unknown }).floorId;
    if (floorId === undefined) return undefined;
    if (typeof floorId !== "string" || !UUID_PATTERN.test(floorId)) {
      throw new BadRequestException("invalid fixture group query");
    }
    return floorId;
  }
}
