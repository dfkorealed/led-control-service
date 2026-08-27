import { Body, Controller, Get, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./current-user.decorator";
import { SessionAuthGuard } from "./session-auth.guard";
import { AuthenticatedRequest, AuthenticatedUser } from "./auth.types";

type CookieResponse = {
  cookie: (name: string, value: string, options: Record<string, unknown>) => CookieResponse;
  clearCookie: (name: string, options: Record<string, unknown>) => CookieResponse;
};

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("signup")
  signup(
    @Body() body: { token: string; loginId: string; email: string; name: string; password: string }
  ) {
    return this.authService.signup(body);
  }

  @Post("login")
  async login(
    @Body() body: { loginId: string; password: string; rememberMe?: boolean },
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse
  ) {
    const result = await this.authService.login({
      loginId: body.loginId,
      password: body.password,
      rememberMe: body.rememberMe === true,
      userAgent: this.readHeader(request.headers["user-agent"]),
      ipAddress: this.readHeader(request.headers["x-forwarded-for"])
    });
    this.setSessionCookie(response, result.sessionToken, result.expiresAt);
    return { user: result.user };
  }

  @Get("me")
  @UseGuards(SessionAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user };
  }

  @Post("logout")
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
  @UseGuards(SessionAuthGuard)
  changePassword(
    @Body() body: { currentPassword: string; newPassword: string; newPasswordConfirmation: string },
    @Req() request: AuthenticatedRequest
  ) {
    const token = this.readCookie(request.headers.cookie, AuthService.sessionCookieName);
    if (!token || !request.user) throw new UnauthorizedException("Authentication required");
    return this.authService.changePassword(request.user, token, body);
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
