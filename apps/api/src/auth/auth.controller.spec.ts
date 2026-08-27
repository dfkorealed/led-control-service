import { BadRequestException } from "@nestjs/common";
import { AuthController } from "./auth.controller";

describe("AuthController", () => {
  it("reads the current session cookie when changing a password", async () => {
    const authService = { changePassword: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new AuthController(authService as any);
    const user = {
      id: "admin-1",
      organizationId: "organization-1",
      organizationType: "customer" as const,
      loginId: "admin_01",
      email: null,
      name: "Admin",
      role: "admin" as const,
      status: "active" as const
    };

    await expect((controller as any).changePassword(
      { currentPassword: "old", newPassword: "new password", newPasswordConfirmation: "new password" },
      { user, headers: { cookie: "led_session=current-token" } }
    )).resolves.toEqual({ ok: true });
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
});
