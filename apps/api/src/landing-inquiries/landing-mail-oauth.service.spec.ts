import { createDecipheriv } from "node:crypto";
import { LandingMailOAuthService } from "./landing-mail-oauth.service";

const key = Buffer.alloc(32, 17).toString("base64");
const configuration = {
  LANDING_NAVER_WORKS_CLIENT_ID: "test-client",
  LANDING_NAVER_WORKS_CLIENT_SECRET: "test-secret",
  LANDING_NAVER_WORKS_REDIRECT_URI: "https://kinda.example/landing-mail/oauth/callback",
  LANDING_NAVER_WORKS_SENDER: "sender@example.com",
  LANDING_MAIL_TOKEN_KEY: key
};
function setup() {
  const states = new Map<string, any>();
  let credential: any = null;
  const db: any = {
    landingMailOAuthState: {
      create: jest.fn(async ({ data }) => { states.set(data.stateHash, data); return data; }),
      deleteMany: jest.fn(async ({ where }) => {
        if (!where.stateHash) {
          for (const [hash, row] of states) if (row.expiresAt <= where.expiresAt.lte) states.delete(hash);
          return { count: 0 };
        }
        const row = states.get(where.stateHash);
        if (!row || row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        states.delete(where.stateHash);
        return { count: 1 };
      })
    },
    landingMailCredential: {
      findUnique: jest.fn(async () => credential),
      upsert: jest.fn(async ({ create, update }) => { credential = { ...(credential ? update : create) }; return credential; })
    },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (run) => run(db))
  };
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    access_token: "access-one", refresh_token: "refresh-one", expires_in: "3600", scope: "mail", token_type: "Bearer"
  }) });
  global.fetch = fetchMock;
  return { service: new LandingMailOAuthService(db), db, states, fetchMock, credential: () => credential };
}
async function authorize(ctx: ReturnType<typeof setup>) {
  const result = await ctx.service.beginAuthorization("operator-1");
  return new URL(result.authorizationUrl).searchParams.get("state")!;
}
function plaintext(row: any) {
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), Buffer.from(row.tokenIv, "base64"));
  decipher.setAAD(Buffer.from("kinda-landing-mail:v1"));
  decipher.setAuthTag(Buffer.from(row.tokenTag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.tokenCiphertext, "base64")), decipher.final()]).toString());
}

describe("LandingMailOAuthService", () => {
  const oldEnv = { ...process.env };
  const oldFetch = global.fetch;
  beforeEach(() => { Object.assign(process.env, configuration); });
  afterEach(() => { process.env = { ...oldEnv }; global.fetch = oldFetch; jest.useRealTimers(); });

  it("issues mail-only authorization with exact redirect and a hash-only ten-minute state", async () => {
    const ctx = setup();
    const started = Date.now();
    const result = await ctx.service.beginAuthorization("operator-1");
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.worksmobile.com/oauth2/v2.0/authorize");
    expect(url.searchParams.get("scope")).toBe("mail");
    expect(url.searchParams.get("redirect_uri")).toBe(configuration.LANDING_NAVER_WORKS_REDIRECT_URI);
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = [...ctx.states.values()][0];
    expect(stored.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(state);
    expect(stored.operatorId).toBe("operator-1");
    expect(stored.expiresAt.getTime() - started).toBeGreaterThanOrEqual(600_000);
  });

  it("encrypts tokens with AES-256-GCM, exchanges only once, and never overwrites on replay", async () => {
    const ctx = setup();
    const state = await authorize(ctx);
    await ctx.service.completeAuthorization("code-1", state);
    const before = { ...ctx.credential() };
    expect(JSON.stringify(before)).not.toMatch(/access-one|refresh-one|code-1/);
    expect(plaintext(before)).toEqual({ accessToken: "access-one", refreshToken: "refresh-one" });
    expect(Buffer.from(before.tokenIv, "base64")).toHaveLength(12);
    expect(Buffer.from(before.tokenTag, "base64")).toHaveLength(16);
    await expect(ctx.service.completeAuthorization("code-2", state)).rejects.toMatchObject({ status: 400 });
    expect(ctx.credential()).toEqual(before);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
    expect(await ctx.service.getConnectionStatus()).toEqual({ connected: true });
    expect(await ctx.service.getAccessToken()).toBe("access-one");
    const [url, options] = ctx.fetchMock.mock.calls[0];
    expect(url).toBe("https://auth.worksmobile.com/oauth2/v2.0/token");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeDefined();
    expect(options.body.get("redirect_uri")).toBe(configuration.LANDING_NAVER_WORKS_REDIRECT_URI);
  });

  it("rejects missing, modified and expired states before contacting the provider", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-25T00:00:00Z"));
    const ctx = setup();
    const state = await authorize(ctx);
    for (const invalid of ["", state + "x", "x".repeat(43)]) {
      await expect(ctx.service.completeAuthorization("code", invalid)).rejects.toMatchObject({ status: 400 });
    }
    jest.advanceTimersByTime(600_000);
    await expect(ctx.service.completeAuthorization("code", state)).rejects.toMatchObject({ status: 400 });
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it("allows only one concurrent callback to claim a state", async () => {
    const ctx = setup();
    const state = await authorize(ctx);
    const results = await Promise.allSettled([ctx.service.completeAuthorization("a", state), ctx.service.completeAuthorization("b", state)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(ctx.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes expired tokens, preserving the refresh token when rotation is off", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-25T00:00:00Z"));
    const ctx = setup();
    await ctx.service.completeAuthorization("code", await authorize(ctx));
    jest.advanceTimersByTime(3_600_000);
    ctx.fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "access-two", expires_in: "3600", scope: "mail", token_type: "Bearer" }) });
    expect(await ctx.service.getAccessToken()).toBe("access-two");
    expect(plaintext(ctx.credential()).refreshToken).toBe("refresh-one");
    expect(ctx.fetchMock.mock.calls[1][1].body.get("grant_type")).toBe("refresh_token");
    expect(ctx.fetchMock.mock.calls[1][1].body.get("refresh_token")).toBe("refresh-one");
  });

  it("supports forced refresh and rotated refresh tokens", async () => {
    const ctx = setup();
    await ctx.service.completeAuthorization("code", await authorize(ctx));
    ctx.fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "access-two", refresh_token: "refresh-two", expires_in: 3600, scope: "mail", token_type: "Bearer" }) });
    expect(await ctx.service.getAccessToken(true)).toBe("access-two");
    expect(plaintext(ctx.credential()).refreshToken).toBe("refresh-two");
  });

  it.each([
    ["LANDING_MAIL_TOKEN_KEY", ""], ["LANDING_MAIL_TOKEN_KEY", "bad-key"],
    ["LANDING_MAIL_TOKEN_KEY", Buffer.alloc(31).toString("base64")],
    ["LANDING_NAVER_WORKS_CLIENT_SECRET", ""], ["LANDING_NAVER_WORKS_SENDER", ""],
    ["LANDING_NAVER_WORKS_REDIRECT_URI", "http://kinda.example/landing-mail/oauth/callback"],
    ["LANDING_NAVER_WORKS_REDIRECT_URI", "https://kinda.example/wrong"]
  ])("fails disconnected without crashing for bad %s", async (name, value) => {
    process.env[name] = value;
    const ctx = setup();
    expect(await ctx.service.getConnectionStatus()).toEqual({ connected: false });
    await expect(ctx.service.beginAuthorization("operator-1")).rejects.toMatchObject({ status: 503 });
    await expect(ctx.service.getAccessToken()).rejects.toMatchObject({ status: 503 });
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it("detects tampered ciphertext and a different client/sender as disconnected", async () => {
    const ctx = setup();
    await ctx.service.completeAuthorization("code", await authorize(ctx));
    process.env.LANDING_NAVER_WORKS_SENDER = "other@example.com";
    expect(await ctx.service.getConnectionStatus()).toEqual({ connected: false });
    process.env.LANDING_NAVER_WORKS_SENDER = configuration.LANDING_NAVER_WORKS_SENDER;
    ctx.credential().tokenTag = Buffer.alloc(16).toString("base64");
    expect(await ctx.service.getConnectionStatus()).toEqual({ connected: false });
  });

  it("rejects truncated authentication tags instead of weakening GCM integrity", async () => {
    const ctx = setup();
    await ctx.service.completeAuthorization("code", await authorize(ctx));
    ctx.credential().tokenTag = Buffer.from(ctx.credential().tokenTag, "base64").subarray(0, 4).toString("base64");
    expect(await ctx.service.getConnectionStatus()).toEqual({ connected: false });
  });

  it("sanitizes provider errors and consumes state even when token exchange fails", async () => {
    const ctx = setup();
    const state = await authorize(ctx);
    ctx.fetchMock.mockRejectedValueOnce(new Error("secret token provider body"));
    await expect(ctx.service.completeAuthorization("code", state)).rejects.toMatchObject({ status: 503, message: "메일 연결을 사용할 수 없습니다. 운영자에게 문의해 주세요." });
    await expect(ctx.service.completeAuthorization("code", state)).rejects.toMatchObject({ status: 400 });
    expect(await ctx.service.getConnectionStatus()).toEqual({ connected: false });
  });

  it.each([
    { access_token: "a", refresh_token: "r", expires_in: 0, scope: "mail", token_type: "Bearer" },
    { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "mail.read", token_type: "Bearer" },
    { access_token: "a", expires_in: 3600, scope: "mail", token_type: "Bearer" }
  ])("rejects unusable provider tokens", async (response) => {
    const ctx = setup();
    ctx.fetchMock.mockResolvedValueOnce({ ok: true, json: async () => response });
    await expect(ctx.service.completeAuthorization("code", await authorize(ctx))).rejects.toMatchObject({ status: 503 });
    expect(ctx.credential()).toBeNull();
  });
});
