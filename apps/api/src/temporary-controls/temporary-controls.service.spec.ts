import { Test } from "@nestjs/testing";
import { HttpException, type INestApplication } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { TemporaryControlsService } from "./temporary-controls.service";

describe("temporary HTTP boundary", () => {
  let app: INestApplication; let base: string;
  const calls: unknown[] = [];
  const api = { start: async (...args: unknown[]) => { calls.push(args); return { state: "pending" }; },
    end: async (...args: unknown[]) => { calls.push(args); return { state: "releasing" }; },
    get: async () => ({ state: "unknown" }), list: async (_site: string, _actor: unknown, query: unknown) => { calls.push(query); return { items: [], nextCursor: null }; } };
  beforeAll(async () => {
    const { TemporaryControlsController } = require("./temporary-controls.controller");
    const module = await Test.createTestingModule({ controllers: [TemporaryControlsController], providers: [SessionAuthGuard,
      { provide: TemporaryControlsService, useValue: api }, { provide: AuthService, useValue: { getUserBySessionToken: async () => ({ id: "actor", mustChangePassword: false }) } }] }).compile();
    app = module.createNestApplication(); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  const call = (path: string, method = "GET", body?: unknown, auth = true) => fetch(`${base}/sites/site/temporary-controls${path}`, {
    method, headers: { ...(auth ? { cookie: `${AuthService.sessionCookieName}=mock-session` } : {}), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  it("requires a real session guard and returns 202 for start/end acceptance with no-store reads", async () => {
    expect((await call("", "POST", {}, false)).status).toBe(401);
    expect((await call("", "POST", { clientRequestId: "opaque" })).status).toBe(202);
    expect((await call("/id/end", "POST", { clientRequestId: "opaque" })).status).toBe(202);
    const read = await call("/id"); expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect((await call("?limit=2")).status).toBe(200); expect(calls.at(-1)).toEqual({ limit: 2 });
  });
  it.each([400, 403, 404, 409, 503])("preserves service status %s instead of disguising it as accepted", async status => {
    const original = api.start; api.start = async () => { throw new HttpException("fixture", status); };
    try { expect((await call("", "POST", {})).status).toBe(status); } finally { api.start = original; }
  });
});
