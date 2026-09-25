import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
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
      LANDING_NAVER_WORKS_REDIRECT_URI: "https://kinda.example/landing-mail/oauth/callback",
      LANDING_NAVER_WORKS_SENDER: "sender@example.com", LANDING_MAIL_TOKEN_KEY: Buffer.alloc(32, 17).toString("base64")
    });
    db = new PrismaService(); otherDb = new PrismaService();
    const sql = readFileSync(join(__dirname, "../../prisma/migrations/20260925130000_landing_mail_oauth/migration.sql"), "utf8");
    for (const statement of sql.split(";").filter((value) => value.trim())) await db.$executeRawUnsafe(statement);
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
    expect(await db.landingMailOAuthState.count()).toBe(0);
    expect(await db.landingMailCredential.count()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
