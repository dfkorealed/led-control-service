import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import {
  type CreateReplacementAdminInput,
  type CreateSiteAdminInput,
  OperatorSiteAdminsService,
  type UpdateSiteAdminInput
} from "./operator-site-admins.service";

interface ResetPasswordInput {
  newPassword: string;
}

@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("operator")
@Controller("operator")
export class OperatorSiteAdminsController {
  constructor(private readonly siteAdmins: OperatorSiteAdminsService) {}

  @Get("site-admins")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.siteAdmins.list(user);
  }

  @Post("site-admins")
  createSiteAdmin(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateSiteAdminInput) {
    return this.siteAdmins.createSiteAdmin(user, body);
  }

  @Post("sites/:siteId/admin")
  createReplacementAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Param("siteId") siteId: string,
    @Body() body: CreateReplacementAdminInput
  ) {
    return this.siteAdmins.createReplacementAdmin(user, siteId, body);
  }

  @Patch("site-admins/:userId")
  update(@CurrentUser() user: AuthenticatedUser, @Param("userId") userId: string, @Body() body: UpdateSiteAdminInput) {
    return this.siteAdmins.update(user, userId, body);
  }

  @Post("site-admins/:userId/reset-password")
  resetPassword(@CurrentUser() user: AuthenticatedUser, @Param("userId") userId: string, @Body() body: ResetPasswordInput) {
    return this.siteAdmins.resetPassword(user, userId, body?.newPassword);
  }

  @Delete("site-admins/:userId")
  disable(@CurrentUser() user: AuthenticatedUser, @Param("userId") userId: string) {
    return this.siteAdmins.disable(user, userId);
  }
}
