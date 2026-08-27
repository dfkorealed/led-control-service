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
});
