import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { LandingInquiriesService } from "./landing-inquiries.service";
import { LandingMailOAuthService } from "./landing-mail-oauth.service";

const databaseUrl = process.env.LANDING_MAIL_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("landing mail OAuth PostgreSQL serialization", () => {
  let db: PrismaService;
  let otherDb: PrismaService;
  let service: LandingMailOAuthService;
  let otherService: LandingMailOAuthService;
  const oldEnv = { ...process.env };
  const oldFetch = global.fetch;
  const schema = `landing_oauth_${Date.now()}`;
  let admin: PrismaService;
  const fetchMock = jest.fn();

  beforeAll(async () => {
    // Explicit test URL only. Each run owns a new schema and never deletes shared rows.
    process.env.DATABASE_URL = databaseUrl;
    admin = new PrismaService();
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("schema", schema);
    process.env.DATABASE_URL = scoped.toString();
    Object.assign(process.env, {
      LANDING_NAVER_WORKS_CLIENT_ID: "test-client", LANDING_NAVER_WORKS_CLIENT_SECRET: "test-secret",
      WEB_PUBLIC_URL: "https://kinda.example",
      LANDING_NAVER_WORKS_REDIRECT_URI: "https://kinda.example/api/landing-mail/oauth/callback",
      LANDING_NAVER_WORKS_SENDER: "sender@example.com", LANDING_MAIL_TOKEN_KEY: Buffer.alloc(32, 17).toString("base64")
    });
    db = new PrismaService(); otherDb = new PrismaService();
    for (const migration of ["20260925130000_landing_mail_oauth", "20260925150000_landing_oauth_generation"]) {
      const sql = readFileSync(join(__dirname, `../../prisma/migrations/${migration}/migration.sql`), "utf8");
      for (const statement of sql.split(";").filter((value) => value.trim())) await db.$executeRawUnsafe(statement);
    }
    service = new LandingMailOAuthService(db); otherService = new LandingMailOAuthService(otherDb);
    global.fetch = fetchMock;
  });
  afterAll(async () => {
    await db?.$disconnect(); await otherDb?.$disconnect();
    if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); }
    process.env = oldEnv; global.fetch = oldFetch;
  });
  beforeEach(async () => {
    await db.landingMailCredential.deleteMany(); await db.landingMailOAuthState.deleteMany();
    fetchMock.mockReset().mockImplementation(async () => ({ ok: true, json: async () => ({
      access_token: "access-one", refresh_token: "refresh-one", expires_in: "3600", scope: "mail", token_type: "Bearer"
    }) }));
  });

  async function state() {
    const result = await service.beginAuthorization("operator-1");
    return new URL(result.authorizationUrl).searchParams.get("state")!;
  }

  it("claims a callback once across separate database connections", async () => {
    const value = await state();
    const results = await Promise.allSettled([
      service.completeAuthorization("first-code", value), otherService.completeAuthorization("second-code", value)
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.getStatus()).toBe(400);
    expect(await db.landingMailOAuthState.count({ where: { consumedAt: { not: null } } })).toBe(1);
    expect(await db.landingMailCredential.count()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fences distinct outstanding states across connections, including concurrent callbacks", async () => {
    const first = await state();
    const second = await state();
    const results = await Promise.allSettled([
      service.completeAuthorization("old-code", first), otherService.completeAuthorization("new-code", second)
    ]);
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].body.get("code")).toBe("new-code");
  });

  it("rejects a consumed callback if a newer generation begins before its exchange lock", async () => {
    const first = await state();
    const original = db.$transaction.bind(db);
    let calls = 0;
    let newer: string | undefined;
    const transaction = jest.spyOn(db, "$transaction").mockImplementation((async (...args: any[]) => {
      const result = await (original as any)(...args);
      if (++calls === 1) {
        const started = await otherService.beginAuthorization("operator-2");
        newer = new URL(started.authorizationUrl).searchParams.get("state")!;
      }
      return result;
    }) as any);
    try { await expect(service.completeAuthorization("old-code", first)).rejects.toMatchObject({ status: 400 }); }
    finally { transaction.mockRestore(); }
    expect(fetchMock).not.toHaveBeenCalled();
    await otherService.completeAuthorization("new-code", newer!);
    expect(await service.getAccessToken()).toBe("access-one");
  });

  it("commits rejected-refresh invalidation and blocks new intake", async () => {
    await service.completeAuthorization("code", await state());
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
    await expect(service.getAccessToken(true)).rejects.toMatchObject({ status: 503 });
    expect(await otherService.getConnectionStatus()).toEqual({ connected: false });
    expect(await db.landingMailCredential.count()).toBe(0);
    const create = jest.fn();
    const intake = new LandingInquiriesService({ landingInquiry: { findUnique: async () => null }, $transaction: create } as any, { consume: jest.fn() } as any, otherService);
    await expect(intake.submit({ idempotencyKey: "bdb372be-ea3e-4ab0-9b3f-8f98f5f2b5b1", companyName: "Test", contactName: "Contact", email: "test@example.com", phone: "", audience: null,
      message: "Test inquiry", consent: true, consentVersion: "landing-2026-09-v1-90d", website: "" }, "127.0.0.1")).rejects.toMatchObject({ status: 503 });
    expect(create).not.toHaveBeenCalled();
  });

  it("serializes expired refreshes across separate API service instances", async () => {
    await service.completeAuthorization("code", await state());
    await db.landingMailCredential.updateMany({ data: { accessTokenExpiresAt: new Date(0) } });
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({
      access_token: "access-two", refresh_token: "refresh-two", expires_in: "3600", scope: "mail", token_type: "Bearer"
    }) }));
    const results = await Promise.all([service.getAccessToken(), otherService.getAccessToken()]);
    expect(results).toEqual(["access-two", "access-two"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
