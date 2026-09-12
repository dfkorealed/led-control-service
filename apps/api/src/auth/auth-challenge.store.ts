import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { RedisProvider } from "../redis/redis.provider";
import { MfaCryptoService } from "./mfa-crypto.service";

export type AuthChallengeKind = "login" | "enrollment";

@Injectable()
export class AuthChallengeStore {
  constructor(private readonly redis: RedisProvider, private readonly crypto: MfaCryptoService) {}

  async create(kind: AuthChallengeKind, payload: Record<string, unknown>, ttlSeconds: number) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000);
    try {
      const encrypted = this.crypto.encrypt(JSON.stringify(payload));
      await this.redis.getClient().set(this.key(kind, token), encrypted, "EX", ttlSeconds);
      return { token, expiresAt };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw this.unavailable();
    }
  }

  async read<T>(kind: AuthChallengeKind, token: string): Promise<T | null> {
    try {
      const value = await this.redis.getClient().get(this.key(kind, token));
      if (!value) return null;
      return JSON.parse(this.crypto.decrypt(value)) as T;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw this.unavailable();
    }
  }

  async take<T>(kind: AuthChallengeKind, token: string): Promise<T | null> {
    try {
      const value = await this.redis.getClient().getdel(this.key(kind, token));
      if (!value) return null;
      return JSON.parse(this.crypto.decrypt(value)) as T;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw this.unavailable();
    }
  }

  async delete(kind: AuthChallengeKind, token: string) {
    try {
      await this.redis.getClient().del(this.key(kind, token));
    } catch {
      throw this.unavailable();
    }
  }

  private key(kind: AuthChallengeKind, token: string) {
    const digest = createHash("sha256").update(token).digest("hex");
    return `auth:challenge:${kind}:${digest}`;
  }

  private unavailable() {
    return new ServiceUnavailableException({ code: "AUTH_CHALLENGE_UNAVAILABLE", message: "Authentication challenge service is unavailable" });
  }
}
