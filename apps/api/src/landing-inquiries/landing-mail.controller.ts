import { Controller, Get, Header, Post, Query, Redirect, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { LandingMailOAuthService } from "./landing-mail-oauth.service";

@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("operator")
@Controller("operator/landing-mail")
export class OperatorLandingMailController {
  constructor(private readonly oauth: LandingMailOAuthService) {}

  @Get("status")
  @Header("Cache-Control", "no-store")
  status() { return this.oauth.getConnectionStatus(); }

  @Post("authorize")
  @Header("Cache-Control", "no-store")
  authorize(@CurrentUser() user: AuthenticatedUser) { return this.oauth.beginAuthorization(user.id); }
}

@Controller("landing-mail/oauth")
export class LandingMailCallbackController {
  constructor(private readonly oauth: LandingMailOAuthService) {}

  @Get("callback")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @Redirect("/operator/landing-inquiries?mail=connected", 302)
  async callback(@Query("code") code: string, @Query("state") state: string) {
    await this.oauth.completeAuthorization(code, state);
  }
}
