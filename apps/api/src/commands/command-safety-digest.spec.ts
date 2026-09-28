import { createHash } from "node:crypto";
import { CommandSafetyDigest } from "./command-safety-digest";

const firstKey = Buffer.alloc(32, 0x41).toString("base64url");
const secondKey = Buffer.alloc(32, 0x42).toString("base64url");

describe("CommandSafetyDigest", () => {
  it("uses a versioned, domain-separated server-key HMAC rather than raw SHA of a low-entropy client key", () => {
    const digest = new CommandSafetyDigest({ activeVersion: 1, keys: { 1: firstKey } });
    const replay = digest.sign("set-replay", ["site-1", "user-1", "1"]);
    const check = digest.sign("status-check-replay", ["site-1", "user-1", "1"]);
    expect(replay).toMatchObject({ keyVersion: 1, value: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/) });
    expect(replay.value).not.toBe(`hmac-sha256:${createHash("sha256").update("1").digest("hex")}`);
    expect(check.value).not.toBe(replay.value);
    expect(digest.verify("set-replay", ["site-1", "user-1", "1"], replay)).toBe(true);
    expect(digest.verify("set-replay", ["site-1", "user-2", "1"], replay)).toBe(false);
  });

  it("verifies old and new versions after rotation and fails closed when the old key is removed", () => {
    const old = new CommandSafetyDigest({ activeVersion: 1, keys: { 1: firstKey } });
    const receipt = old.sign("late-set-wire", ["site-1", "dispatch-1", "tiny-key", "9"]);
    const rotated = new CommandSafetyDigest({ activeVersion: 2, keys: { 1: firstKey, 2: secondKey } });
    expect(rotated.verify("late-set-wire", ["site-1", "dispatch-1", "tiny-key", "9"], receipt)).toBe(true);
    expect(rotated.sign("late-set-wire", ["site-1", "dispatch-1", "tiny-key", "9"]).keyVersion).toBe(2);
    expect(rotated.signAll("set-replay", ["site-1", "user-1", "tiny-key"]).map((item) => item.keyVersion)).toEqual([1, 2]);
    expect(() => new CommandSafetyDigest({ activeVersion: 2, keys: { 2: secondKey } })
      .verify("late-set-wire", ["site-1", "dispatch-1", "tiny-key", "9"], receipt)).toThrow("command safety HMAC key unavailable");
  });

  it("separates an orphan Set key by domain and site without reconstructing a deleted actor", () => {
    const digest = new CommandSafetyDigest({ activeVersion: 2,
      keys: { 1: firstKey, 2: secondKey } });
    const sameSite = digest.sign("set-replay-orphan", ["site-1", "tiny-key"]);
    expect(sameSite.value).not.toBe(digest.sign("set-replay", ["site-1", "user-1", "tiny-key"]).value);
    expect(sameSite.value).not.toBe(digest.sign("set-replay-orphan", ["site-2", "tiny-key"]).value);
    expect(digest.signAll("set-replay-orphan", ["site-1", "tiny-key"])
      .map(({ keyVersion }) => keyVersion)).toEqual([1, 2]);
  });

  it("rejects missing, short, malformed, or unconfigured signing keys without a fallback", () => {
    expect(() => new CommandSafetyDigest({ activeVersion: 1, keys: {} }).sign("set-replay", ["key"]))
      .toThrow("command safety HMAC key unavailable");
    expect(() => new CommandSafetyDigest({ activeVersion: 1, keys: { 1: "bad" } }).sign("set-replay", ["key"]))
      .toThrow("invalid command safety HMAC key");
    expect(() => new CommandSafetyDigest({ activeVersion: 1, keys: { 1: Buffer.alloc(16).toString("base64url") } })
      .sign("set-replay", ["key"])).toThrow("invalid command safety HMAC key");
  });

  it("constructs without injected test keys for legacy startup but fails closed on first protected operation", () => {
    const version = process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION;
    const keys = process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
    try {
      delete process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION;
      delete process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
      const digest = new CommandSafetyDigest();
      expect(() => digest.sign("set-replay", ["site", "user", "key"]))
        .toThrow("command safety HMAC key unavailable");
      expect(() => digest.signAll("status-check-replay", ["site", "user", "key"]))
        .toThrow("command safety HMAC key unavailable");
    } finally {
      if (version === undefined) delete process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION;
      else process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION = version;
      if (keys === undefined) delete process.env.COMMAND_SAFETY_HMAC_KEYS_JSON;
      else process.env.COMMAND_SAFETY_HMAC_KEYS_JSON = keys;
    }
  });
});
