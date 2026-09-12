import { BadRequestException } from "@nestjs/common";
import { AuthController } from "./auth.controller";

describe("AuthController", () => {
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
    const result = { ok: true, user: { ...user, mustChangePassword: false } };
    const authService = { changePassword: jest.fn().mockResolvedValue(result) };
    const controller = new AuthController(authService as any);

    await expect((controller as any).changePassword(
      { currentPassword: "old", newPassword: "new password", newPasswordConfirmation: "new password" },
      { user, headers: { cookie: "led_session=current-token" } }
    )).resolves.toEqual(result);
    expect(authService.changePassword).toHaveBeenCalledWith(user, "current-token", {
      currentPassword: "old",
      newPassword: "new password",
      newPasswordConfirmation: "new password"
    });
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
});
