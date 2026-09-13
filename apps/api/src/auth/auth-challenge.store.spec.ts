import { ServiceUnavailableException } from "@nestjs/common";
import { AuthChallengeStore } from "./auth-challenge.store";
import { MfaCryptoService } from "./mfa-crypto.service";

describe("AuthChallengeStore", () => {
  const crypto = {
    encrypt: jest.fn((value: string) => `encrypted:${Buffer.from(value).toString("base64")}`),
    decrypt: jest.fn((value: string) => Buffer.from(value.slice("encrypted:".length), "base64").toString())
  } as unknown as MfaCryptoService;

  it("stores only encrypted payload under a hashed opaque-token key with a TTL", async () => {
    const redis = { set: jest.fn().mockResolvedValue("OK") };
    const store = new AuthChallengeStore({ getClient: () => redis } as any, crypto);

    const result = await store.create("login", { userId: "user-1", rememberMe: true }, 300);

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const [key, value, mode, ttl] = redis.set.mock.calls[0];
    expect(key).toMatch(/^auth:challenge:login:[a-f0-9]{64}$/);
    expect(key).not.toContain(result.token);
    expect(value).not.toContain("user-1");
    expect([mode, ttl]).toEqual(["EX", 300]);
  });

  it("reads a typed encrypted challenge and deletes it explicitly", async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(`encrypted:${Buffer.from('{"userId":"user-1"}').toString("base64")}`),
      del: jest.fn().mockResolvedValue(1)
    };
    const store = new AuthChallengeStore({ getClient: () => redis } as any, crypto);

    await expect(store.read<{ userId: string }>("login", "opaque-token")).resolves.toEqual({ userId: "user-1" });
    await store.delete("login", "opaque-token");
    expect(redis.del).toHaveBeenCalledWith(expect.stringMatching(/^auth:challenge:login:/));
  });

  it("atomically takes a one-time challenge", async () => {
    const redis = {
      getdel: jest.fn().mockResolvedValue(`encrypted:${Buffer.from('{"userId":"user-1"}').toString("base64")}`)
    };
    const store = new AuthChallengeStore({ getClient: () => redis } as any, crypto);

    await expect(store.take<{ userId: string }>("login", "opaque-token")).resolves.toEqual({ userId: "user-1" });
    expect(redis.getdel).toHaveBeenCalledWith(expect.stringMatching(/^auth:challenge:login:/));
  });

  it("fails closed when Redis is unavailable or contains malformed data", async () => {
    const failing = new AuthChallengeStore({ getClient: () => ({ get: jest.fn().mockRejectedValue(new Error("down")) }) } as any, crypto);
    const malformed = new AuthChallengeStore({ getClient: () => ({ get: jest.fn().mockResolvedValue(`encrypted:${Buffer.from("not-json").toString("base64")}`) }) } as any, crypto);

    await expect(failing.read("login", "token")).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(malformed.read("login", "token")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
