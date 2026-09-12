import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { AuthController } from "./auth.controller";
import { SessionAuthGuard } from "./session-auth.guard";

describe("AuthController", () => {
  it("keeps logout idempotent so a rotated cookie can still revoke its session family", async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.logout)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.me)).toEqual([SessionAuthGuard]);

    const authService = { logout: jest.fn().mockResolvedValue(undefined) };
    const response = { clearCookie: jest.fn().mockReturnThis() };
    const controller = new AuthController(authService as any);

    await expect(controller.logout(
      { headers: { cookie: "led_session=pre-rotation-token" } } as any,
      response as any
    )).resolves.toEqual({ ok: true });
    expect(authService.logout).toHaveBeenCalledWith("pre-rotation-token");
    expect(response.clearCookie).toHaveBeenCalledWith("led_session", expect.objectContaining({ path: "/" }));
  });

  it("marks exactly me, logout and changePassword as pending-password exceptions", () => {
    const methods = Object.getOwnPropertyNames(AuthController.prototype).filter((name) =>
      Reflect.getMetadata("allowPasswordChangePending", (AuthController.prototype as any)[name]) === true
    );
    expect(methods.sort()).toEqual(["changePassword", "logout", "me"]);
    expect(Reflect.getMetadata("allowPasswordChangePending", AuthController)).toBeUndefined();
  });
  it("reads the current session cookie when changing a password", async () => {
    const user = {
      id: "admin-1",
      organizationId: "organization-1",
      organizationType: "customer" as const,
      loginId: "admin_01",
      name: "Admin",
      role: "admin" as const,
      status: "active" as const,
      mustChangePassword: true
    };
    const result = {
      ok: true, user: { ...user, mustChangePassword: false }, sessionToken: "replacement-token", expiresAt: new Date("2026-10-01T00:00:00Z")
    };
    const authService = { changePassword: jest.fn().mockResolvedValue(result) };
    const controller = new AuthController(authService as any);
    const response = { cookie: jest.fn().mockReturnThis() };

    await expect((controller as any).changePassword(
      { currentPassword: "old", newPassword: "new password", newPasswordConfirmation: "new password" },
      { user, headers: { cookie: "led_session=current-token" } },
      response
    )).resolves.toEqual({ ok: true, user: result.user });
    expect(authService.changePassword).toHaveBeenCalledWith(user, "current-token", {
      currentPassword: "old",
      newPassword: "new password",
      newPasswordConfirmation: "new password"
    });
    expect(response.cookie).toHaveBeenCalledWith("led_session", "replacement-token", expect.objectContaining({ expires: result.expiresAt }));
  });

  it("rejects malformed auth bodies before they reach service code", async () => {
    const authService = { signup: jest.fn(), login: jest.fn(), changePassword: jest.fn() };
    const controller = new AuthController(authService as any);
    const request = { headers: { cookie: "led_session=current-token" }, user: { id: "admin-1", organizationId: "organization-1" } };

    await expect(controller.signup({ token: "token", loginId: null, email: "viewer@example.com", name: "Viewer", password: "password" } as any))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.login({ loginId: "admin_01", password: null } as any, request as any, {} as any))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect((controller as any).changePassword({ currentPassword: "old", newPassword: null, newPasswordConfirmation: "new" }, request))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(authService.signup).not.toHaveBeenCalled();
    expect(authService.login).not.toHaveBeenCalled();
    expect(authService.changePassword).not.toHaveBeenCalled();
  });

  it("uses Express request.ip and never trusts a caller-supplied forwarded-for header directly", async () => {
    const authService = {
      login: jest.fn().mockResolvedValue({
        user: { id: "admin-1" }, sessionToken: "token", expiresAt: new Date("2026-10-01T00:00:00.000Z")
      })
    };
    const response = { cookie: jest.fn() };
    response.cookie.mockReturnValue(response);
    const controller = new AuthController(authService as any);

    await controller.login(
      { loginId: "admin_01", password: "password", rememberMe: false },
      { ip: "10.0.0.15", headers: { "x-forwarded-for": "198.51.100.99", "user-agent": "browser" } } as any,
      response as any
    );

    expect(authService.login).toHaveBeenCalledWith(expect.objectContaining({ ipAddress: "10.0.0.15", userAgent: "browser" }));
  });

  it("returns an MFA challenge without setting a session cookie", async () => {
    const result = { mfaRequired: true, challengeToken: "challenge", expiresAt: new Date("2026-09-12T00:05:00Z") };
    const authService = { login: jest.fn().mockResolvedValue(result) };
    const response = { cookie: jest.fn() };
    const controller = new AuthController(authService as any, {} as any);

    await expect(controller.login(
      { loginId: "admin_01", password: "password", rememberMe: false },
      { ip: "203.0.113.7", headers: {} } as any,
      response as any
    )).resolves.toEqual(result);
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it("sets the session cookie only after a successful MFA completion", async () => {
    const result = {
      user: { id: "admin-1" }, sessionToken: "verified-token", expiresAt: new Date("2026-10-01T00:00:00Z"), recoveryCodeUsed: false
    };
    const mfaService = { completeLogin: jest.fn().mockResolvedValue(result) };
    const response = { cookie: jest.fn().mockReturnThis() };
    const controller = new AuthController({} as any, mfaService as any);

    await expect(controller.completeMfaLogin(
      { challengeToken: "challenge", code: "123456" },
      { ip: "203.0.113.7", headers: { "user-agent": "browser" } } as any,
      response as any
    )).resolves.toEqual({ user: result.user, recoveryCodeUsed: false });
    expect(mfaService.completeLogin).toHaveBeenCalledWith(
      { challengeToken: "challenge", code: "123456", recoveryCode: undefined }, "203.0.113.7", "browser"
    );
    expect(response.cookie).toHaveBeenCalledWith("led_session", "verified-token", expect.objectContaining({ httpOnly: true, expires: result.expiresAt }));
  });

  it("rotates the current cookie after MFA enrollment confirmation and disable", async () => {
    const user = {
      id: "admin-1", organizationId: "org-1", organizationType: "customer", loginId: "admin_01",
      name: "Admin", role: "admin", status: "active", mustChangePassword: false
    };
    const mfaService = {
      startEnrollment: jest.fn().mockResolvedValue({ enrollmentToken: "enroll" }),
      confirmEnrollment: jest.fn().mockResolvedValue({
        mfaEnabled: true, recoveryCodes: ["one"], sessionToken: "enrolled-token", expiresAt: new Date("2026-10-01T00:00:00Z")
      }),
      disable: jest.fn().mockResolvedValue({
        mfaEnabled: false, sessionToken: "disabled-token", expiresAt: new Date("2026-10-01T00:00:00Z")
      })
    };
    const response = { cookie: jest.fn().mockReturnThis() };
    const request = { user, ip: "203.0.113.7", headers: { cookie: "led_session=current-token" } } as any;
    const controller = new AuthController({} as any, mfaService as any);

    await expect(controller.startMfaEnrollment(request)).resolves.toEqual({ enrollmentToken: "enroll" });
    await expect(controller.confirmMfaEnrollment({ enrollmentToken: "enroll", code: "123456" }, request, response as any))
      .resolves.toEqual({ mfaEnabled: true, recoveryCodes: ["one"] });
    await expect(controller.disableMfa({ currentPassword: "password", code: "123456" }, request, response as any))
      .resolves.toEqual({ mfaEnabled: false });
    expect(response.cookie).toHaveBeenNthCalledWith(1, "led_session", "enrolled-token", expect.any(Object));
    expect(response.cookie).toHaveBeenNthCalledWith(2, "led_session", "disabled-token", expect.any(Object));
    expect(mfaService.startEnrollment).toHaveBeenCalledWith(
      user, "current-token", "203.0.113.7", undefined
    );
    expect(mfaService.confirmEnrollment).toHaveBeenCalledWith(
      user,
      "current-token",
      { enrollmentToken: "enroll", code: "123456" },
      "203.0.113.7",
      undefined
    );
  });

  it("lists and revokes only the authenticated user's sessions, clearing the cookie for current-session revoke", async () => {
    const user = { id: "admin-1", organizationId: "org-1" };
    const sessions = {
      list: jest.fn().mockResolvedValue({ sessions: [] }),
      revoke: jest.fn().mockResolvedValue({ ok: true, currentSessionRevoked: true }),
      revokeOthers: jest.fn().mockResolvedValue({ ok: true, revokedSessionCount: 2 })
    };
    const response = { clearCookie: jest.fn().mockReturnThis() };
    const request = { user, headers: { cookie: "led_session=current-token" } } as any;
    const controller = new AuthController({} as any, undefined, sessions as any);

    await expect(controller.listSessions(request)).resolves.toEqual({ sessions: [] });
    await expect(controller.revokeSession("session-1", request, response as any)).resolves.toEqual({ ok: true });
    await expect(controller.revokeOtherSessions(request)).resolves.toEqual({ ok: true, revokedSessionCount: 2 });
    expect(sessions.list).toHaveBeenCalledWith(user, "current-token");
    expect(sessions.revoke).toHaveBeenCalledWith(user, "current-token", "session-1");
    expect(sessions.revokeOthers).toHaveBeenCalledWith(user, "current-token");
    expect(response.clearCookie).toHaveBeenCalledWith("led_session", expect.objectContaining({ path: "/" }));
  });
});
