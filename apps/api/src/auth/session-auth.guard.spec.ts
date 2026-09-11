import "reflect-metadata";
import { Controller, Get, INestApplication, SetMetadata, UnauthorizedException, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionAuthGuard } from "./session-auth.guard";

@Controller("protected")
@UseGuards(SessionAuthGuard)
@SetMetadata("allowPasswordChangePending", true)
class ProtectedController {
  @Get("me")
  me() { return { secret: true }; }
}

describe("SessionAuthGuard pending-password HTTP boundary", () => {
  let app: INestApplication;
  let baseUrl: string;
  const user = {
    id: "viewer-1", organizationId: "org-1", organizationType: "customer", loginId: "viewer_01",
    name: "Viewer", role: "viewer", status: "active", mustChangePassword: true
  };
  const auth = {
    getUserBySessionToken: jest.fn(), logout: jest.fn(), changePassword: jest.fn(), login: jest.fn()
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController, ProtectedController],
      providers: [SessionAuthGuard, { provide: AuthService, useValue: auth }]
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    auth.getUserBySessionToken.mockResolvedValue({ ...user });
    auth.changePassword.mockResolvedValue({ ok: true, user: { ...user, mustChangePassword: false } });
    auth.login.mockResolvedValue({ user, sessionToken: "token", expiresAt: new Date(Date.now() + 60_000) });
  });
  afterAll(async () => { await app.close(); });

  const request = (path: string, method = "GET", body?: object, cookie = true) => fetch(baseUrl + path, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: "led_session=token" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });

  it.each(["/protected/me", "/protected/me?path=/auth/me", "/protected/me?mustChangePassword=false"])("denies %s with the coded 403", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
  });

  it.each(["me", "logout", "change-password"])("allows pending users through auth/%s", async (route) => {
    const response = await request(`/auth/${route}`, route === "me" ? "GET" : "POST", route === "change-password" ? {
      currentPassword: "temporary password", newPassword: "replacement password", newPasswordConfirmation: "replacement password"
    } : undefined);
    expect(response.status).toBe(route === "me" ? 200 : 201);
    if (route === "me") expect(await response.json()).toMatchObject({ user: { mustChangePassword: true } });
    if (route === "change-password") expect(await response.json()).toMatchObject({ ok: true, user: { mustChangePassword: false } });
    if (route === "logout") expect(auth.logout).toHaveBeenCalledWith("token");
  });

  it.each(["me", "logout", "change-password"])("does not make auth/%s public", async (route) => {
    const response = await request(`/auth/${route}`, route === "me" ? "GET" : "POST", undefined, false);
    expect(response.status).toBe(401);
  });

  it("permits login and exposes the flag without returning the session token in JSON", async () => {
    const response = await request("/auth/login", "POST", { loginId: user.loginId, password: "temporary password", rememberMe: false }, false);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ user });
    expect(response.headers.get("set-cookie")).toContain("led_session=token");
  });

  it("allows a user with a completed password change to use protected routes", async () => {
    auth.getUserBySessionToken.mockResolvedValue({ ...user, mustChangePassword: false });
    expect((await request("/protected/me")).status).toBe(200);
  });

  it.each(["/auth/me", "/protected/me"])("does not bypass session validation for %s", async (path) => {
    auth.getUserBySessionToken.mockRejectedValue(new UnauthorizedException("Authentication required"));
    expect((await request(path)).status).toBe(401);
  });
});
