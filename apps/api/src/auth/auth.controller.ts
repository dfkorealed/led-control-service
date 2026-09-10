import { BadRequestException, Body, Controller, Get, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./current-user.decorator";
import { SessionAuthGuard } from "./session-auth.guard";
import { AuthenticatedRequest, AuthenticatedUser } from "./auth.types";
import { AllowPasswordChangePending } from "./allow-password-change-pending.decorator";

type CookieResponse = {
  cookie: (name: string, value: string, options: Record<string, unknown>) => CookieResponse;
  clearCookie: (name: string, options: Record<string, unknown>) => CookieResponse;
};

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("signup")
  async signup(@Body() body: unknown) {
    return this.authService.signup(this.signupBody(body));
  }

  @Post("login")
  async login(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse
  ) {
    const result = await this.authService.login({
      ...this.loginBody(body),
      userAgent: this.readHeader(request.headers["user-agent"]),
      ipAddress: this.readHeader(request.headers["x-forwarded-for"])
    });
    this.setSessionCookie(response, result.sessionToken, result.expiresAt);
    return { user: result.user };
  }

  @Get("me")
  @AllowPasswordChangePending()
  @UseGuards(SessionAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user };
  }

  @Post("logout")
  @AllowPasswordChangePending()
  @UseGuards(SessionAuthGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse
  ) {
    const token = this.readCookie(request.headers.cookie, AuthService.sessionCookieName);
    if (token) {
      await this.authService.logout(token);
    }
    response.clearCookie(AuthService.sessionCookieName, this.cookieBaseOptions());
    return { ok: true };
  }

  @Post("change-password")
  @AllowPasswordChangePending()
  @UseGuards(SessionAuthGuard)
  async changePassword(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest
  ) {
    const token = this.readCookie(request.headers.cookie, AuthService.sessionCookieName);
    if (!token || !request.user) throw new UnauthorizedException("Authentication required");
    return this.authService.changePassword(request.user, token, this.changePasswordBody(body));
  }

  private setSessionCookie(response: CookieResponse, token: string, expiresAt: Date) {
    response.cookie(AuthService.sessionCookieName, token, {
      ...this.cookieBaseOptions(),
      expires: expiresAt
    });
  }

  private cookieBaseOptions() {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/"
    };
  }

  private readHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value.join(", ") : value;
  }

  private signupBody(body: unknown) {
    const value = this.record(body);
    return {
      token: this.requiredString(value.token, "token"),
      loginId: this.requiredString(value.loginId, "loginId"),
      email: this.requiredString(value.email, "email"),
      name: this.requiredString(value.name, "name"),
      password: this.requiredString(value.password, "password")
    };
  }

  private loginBody(body: unknown) {
    const value = this.record(body);
    if (value.rememberMe !== undefined && typeof value.rememberMe !== "boolean") {
      throw new BadRequestException("rememberMe must be a boolean");
    }
    return {
      loginId: this.requiredString(value.loginId, "loginId"),
      password: this.requiredString(value.password, "password"),
      rememberMe: value.rememberMe === true
    };
  }

  private changePasswordBody(body: unknown) {
    const value = this.record(body);
    return {
      currentPassword: this.requiredString(value.currentPassword, "currentPassword"),
      newPassword: this.requiredString(value.newPassword, "newPassword"),
      newPasswordConfirmation: this.requiredString(value.newPasswordConfirmation, "newPasswordConfirmation")
    };
  }

  private record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Invalid request body");
    return value as Record<string, unknown>;
  }

  private requiredString(value: unknown, name: string) {
    if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`);
    return value;
  }

  private readCookie(cookieHeader: string | string[] | undefined, name: string) {
    const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
    if (!header) return null;
    const cookie = header
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
  }
}
