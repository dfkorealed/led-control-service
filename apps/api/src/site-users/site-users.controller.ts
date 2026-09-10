import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { SiteUsersService } from "./site-users.service";

@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("admin")
@Controller("sites/:siteId/users")
export class SiteUsersController {
  constructor(private readonly users: SiteUsersService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string) {
    return this.users.list(user, siteId);
  }
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Body() body: unknown) {
    return this.users.create(user, siteId, body);
  }
  @Patch(":userId")
  update(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Param("userId") userId: string, @Body() body: unknown) {
    return this.users.update(user, siteId, userId, body);
  }
  @Post(":userId/reset-password")
  resetPassword(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Param("userId") userId: string, @Body() body: unknown) {
    return this.users.resetPassword(user, siteId, userId, body);
  }
  @Delete(":userId")
  remove(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string, @Param("userId") userId: string, @Body() body: unknown) {
    return this.users.remove(user, siteId, userId, body);
  }
}
