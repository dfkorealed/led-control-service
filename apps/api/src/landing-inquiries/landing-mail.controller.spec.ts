import type { INestApplication } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuthService } from "../auth/auth.service";
import { LandingMailOAuthService } from "./landing-mail-oauth.service";
import { LandingMailCallbackController, OperatorLandingMailController } from "./landing-mail.controller";

describe("landing mail HTTP authorization boundary", () => {
  let app: INestApplication;
  let base: string;
  const oauth = {
    getConnectionStatus: jest.fn(async () => ({ connected: true })),
    beginAuthorization: jest.fn(async (_id: string) => ({ authorizationUrl: "https://auth.worksmobile.com/oauth2/v2.0/authorize" })),
    completeAuthorization: jest.fn(async (_code: string, _state: string) => {})
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OperatorLandingMailController, LandingMailCallbackController],
      providers: [
        { provide: LandingMailOAuthService, useValue: oauth },
        { provide: AuthService, useValue: { getUserBySessionToken: async (role: string) => ({ id: "operator-1", role, mustChangePassword: false }) } }
      ]
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it.each(["GET", "POST"])("rejects anonymous and customer %s while allowing operator", async (method) => {
    const path = method === "GET" ? "/operator/landing-mail/status" : "/operator/landing-mail/authorize";
    expect((await fetch(base + path, { method })).status).toBe(401);
    for (const role of ["admin", "viewer"]) {
      expect((await fetch(base + path, { method, headers: { Cookie: `${AuthService.sessionCookieName}=${role}` } })).status).toBe(403);
    }
    expect(oauth.getConnectionStatus).not.toHaveBeenCalled();
    expect(oauth.beginAuthorization).not.toHaveBeenCalled();
    const response = await fetch(base + path, { method, headers: { Cookie: `${AuthService.sessionCookieName}=operator` } });
    expect(response.status).toBe(method === "GET" ? 200 : 201);
    if (method === "GET") expect(await response.json()).toEqual({ connected: true });
    else expect(oauth.beginAuthorization).toHaveBeenCalledWith("operator-1");
  });

  it("redirects successful public callback only to the fixed operator page", async () => {
    const response = await fetch(base + "/landing-mail/oauth/callback?code=code-one&state=state-one", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/operator/landing-inquiries?mail=connected");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(oauth.completeAuthorization).toHaveBeenCalledWith("code-one", "state-one");
  });

  it("rejects callback errors without redirecting code or state", async () => {
    oauth.completeAuthorization.mockRejectedValueOnce(new BadRequestException("Invalid state"));
    const response = await fetch(base + "/landing-mail/oauth/callback?code=secret&state=invalid", { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).not.toContain("secret");
  });
});
