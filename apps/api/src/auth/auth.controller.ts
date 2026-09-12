import { BadRequestException, Body, Controller, Delete, Get, Optional, Param, Post, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./current-user.decorator";
import { SessionAuthGuard } from "./session-auth.guard";
import { AuthenticatedRequest, AuthenticatedUser } from "./auth.types";
import { AllowPasswordChangePending } from "./allow-password-change-pending.decorator";
import { MfaService } from "./mfa.service";
import { SessionManagementService } from "./session-management.service";

type CookieResponse = {
  cookie: (name: string, value: string, options: Record<string, unknown>) => CookieResponse;
  clearCookie: (name: string, options: Record<string, unknown>) => CookieResponse;
};

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Optional() private readonly mfaService?: MfaService,
    @Optional() private readonly sessionManagement?: SessionManagementService
  ) {}

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
      ipAddress: request.ip ?? "unknown"
    });
    if ("mfaRequired" in result) return result;
    this.setSessionCookie(response, result.sessionToken, result.expiresAt);
    return { user: result.user };
  }

  @Post("login/mfa")
  async completeMfaLogin(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse
  ) {
    const value = this.record(body);
    const verification = this.verificationBody(value);
    const result = await this.mfa().completeLogin({
      challengeToken: this.requiredString(value.challengeToken, "challengeToken"),
      ...verification
    }, request.ip ?? "unknown", this.readHeader(request.headers["user-agent"]));
    this.setSessionCookie(response, result.sessionToken, result.expiresAt);
    return { user: result.user, recoveryCodeUsed: result.recoveryCodeUsed };
  }

  @Get("mfa")
  @UseGuards(SessionAuthGuard)
  async mfaStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa().status(user);
  }

  @Post("mfa/enrollment")
  @UseGuards(SessionAuthGuard)
  async startMfaEnrollment(@Req() request: AuthenticatedRequest) {
    return this.mfa().startEnrollment(
      request.user!,
      this.currentSessionToken(request),
      request.ip ?? "unknown",
      this.readHeader(request.headers["user-agent"])
    );
  }

  @Post("mfa/enrollment/confirm")
  @UseGuards(SessionAuthGuard)
  async confirmMfaEnrollment(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse
  ) {
    const token = this.currentSessionToken(request);
    const value = this.record(body);
    const result = await this.mfa().confirmEnrollment(request.user!, token, {
      enrollmentToken: this.requiredString(value.enrollmentToken, "enrollmentToken"),
      code: this.requiredString(value.code, "code")
    }, request.ip ?? "unknown", this.readHeader(request.headers["user-agent"]));
    this.setSessionCookie(response, result.sessionToken, result.expiresAt);
    return { mfaEnabled: true, recoveryCodes: result.recoveryCodes };
  }

  @Post("mfa/disable")
  @UseGuards(SessionAuthGuard)
  async disableMfa(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse
  ) {
    const token = this.currentSessionToken(request);
    const value = this.record(body);
    const result = await this.mfa().disable(request.user!, token, {
      currentPassword: this.requiredString(value.currentPassword, "currentPassword"),
      ...this.verificationBody(value)
    });
    this.setSessionCookie(response, result.sessionToken, result.expiresAt);
    return { mfaEnabled: false };
  }

  @Get("sessions")
  @UseGuards(SessionAuthGuard)
  listSessions(@Req() request: AuthenticatedRequest) {
    return this.sessions().list(request.user!, this.currentSessionToken(request));
  }

  @Delete("sessions/:sessionId")
  @UseGuards(SessionAuthGuard)
  async revokeSession(
    @Param("sessionId") sessionId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse
  ) {
    const result = await this.sessions().revoke(request.user!, this.currentSessionToken(request), sessionId);
    if (result.currentSessionRevoked) {
      response.clearCookie(AuthService.sessionCookieName, this.cookieBaseOptions());
    }
    return { ok: true };
  }

  @Post("sessions/revoke-others")
  @UseGuards(SessionAuthGuard)
  revokeOtherSessions(@Req() request: AuthenticatedRequest) {
    return this.sessions().revokeOthers(request.user!, this.currentSessionToken(request));
  }

  @Get("me")
  @AllowPasswordChangePending()
  @UseGuards(SessionAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user };
  }

  @Post("logout")
  @AllowPasswordChangePending()
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
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse
  ) {
    const token = this.readCookie(request.headers.cookie, AuthService.sessionCookieName);
    if (!token || !request.user) throw new UnauthorizedException("Authentication required");
    const result = await this.authService.changePassword(request.user, token, this.changePasswordBody(body));
    this.setSessionCookie(response, result.sessionToken, result.expiresAt);
    return { ok: true, user: result.user };
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

  private verificationBody(value: Record<string, unknown>) {
    const code = typeof value.code === "string" && value.code.trim() ? value.code.trim() : undefined;
    const recoveryCode = typeof value.recoveryCode === "string" && value.recoveryCode.trim() ? value.recoveryCode.trim() : undefined;
    if (Boolean(code) === Boolean(recoveryCode)) throw new BadRequestException("Provide exactly one MFA code");
    return { code, recoveryCode };
  }

  private currentSessionToken(request: AuthenticatedRequest) {
    const token = this.readCookie(request.headers.cookie, AuthService.sessionCookieName);
    if (!token || !request.user) throw new UnauthorizedException("Authentication required");
    return token;
  }

  private mfa() {
    if (!this.mfaService) {
      throw new ServiceUnavailableException({ code: "MFA_UNAVAILABLE", message: "MFA service is unavailable" });
    }
    return this.mfaService;
  }

  private sessions() {
    if (!this.sessionManagement) {
      throw new ServiceUnavailableException({ code: "SESSION_MANAGEMENT_UNAVAILABLE", message: "Session management is unavailable" });
    }
    return this.sessionManagement;
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
