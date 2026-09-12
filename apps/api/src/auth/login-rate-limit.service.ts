import { HttpException, Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { RedisProvider } from "../redis/redis.provider";

const WINDOW_SECONDS = 15 * 60;
const IP_LIMIT = 30;
const ACCOUNT_LIMIT = 10;
const TENANT_IP_LIMIT = 20;
export const LOGIN_RATE_LIMIT_KEY_PREFIX = Symbol("LOGIN_RATE_LIMIT_KEY_PREFIX");

const CONSUME_SCRIPT = `
local window = tonumber(ARGV[1])
local blocked = 0
local retryAfter = 0
for index, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('EXPIRE', key, window) end
  local ttl = redis.call('TTL', key)
  local limit = tonumber(ARGV[index + 1])
  if blocked == 0 and count > limit then
    blocked = index
    retryAfter = math.max(ttl, 1)
  end
end
return { blocked, retryAfter }
`;

export interface LoginRateLimitInput {
  ipAddress: string;
  loginId: string;
  organizationId?: string;
  userId?: string;
  userAgent?: string;
}

@Injectable()
export class LoginRateLimitService {
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisProvider,
    private readonly audit: AuditService,
    @Optional() @Inject(LOGIN_RATE_LIMIT_KEY_PREFIX) keyPrefix?: string
  ) {
    this.keyPrefix = keyPrefix?.trim() || "auth:rate";
  }

  async consume(input: LoginRateLimitInput) {
    const buckets = this.buckets(input);
    let result: unknown;
    try {
      result = await this.redis.getClient().eval(
        CONSUME_SCRIPT,
        buckets.length,
        ...buckets.map((bucket) => bucket.key),
        WINDOW_SECONDS,
        ...buckets.map((bucket) => bucket.limit)
      );
    } catch {
      await this.record(input, "auth.login_rate_limit_unavailable", "failure");
      throw this.unavailable();
    }

    const [blockedIndex, retryAfter] = Array.isArray(result) ? result.map(Number) : [NaN, NaN];
    if (!Number.isInteger(blockedIndex) || !Number.isInteger(retryAfter)) {
      await this.record(input, "auth.login_rate_limit_unavailable", "failure");
      throw this.unavailable();
    }
    if (blockedIndex > 0) {
      const dimension = buckets[blockedIndex - 1]?.dimension ?? "unknown";
      const retryAfterSeconds = Math.max(retryAfter, 1);
      await this.record(input, "auth.login_rate_limited", "blocked", { dimension, retryAfterSeconds });
      throw new HttpException({ code: "LOGIN_RATE_LIMITED", message: "Too many login attempts", retryAfterSeconds }, 429);
    }
  }

  async resetAfterSuccess(input: LoginRateLimitInput) {
    const keys = this.buckets(input)
      .filter((bucket) => bucket.dimension !== "ip")
      .map((bucket) => bucket.key);
    if (keys.length === 0) return;
    try {
      await this.redis.getClient().del(...keys);
    } catch {
      await this.record(input, "auth.login_rate_limit_unavailable", "failure");
      throw this.unavailable();
    }
  }

  private buckets(input: LoginRateLimitInput) {
    const result = [
      { dimension: "ip", key: this.key("ip", input.ipAddress), limit: IP_LIMIT },
      { dimension: "account", key: this.key("account", input.loginId), limit: ACCOUNT_LIMIT }
    ];
    if (input.organizationId) {
      result.push({
        dimension: "tenant-ip",
        key: this.key("tenant-ip", `${input.organizationId}\0${input.ipAddress}`),
        limit: TENANT_IP_LIMIT
      });
    }
    return result;
  }

  private key(dimension: string, value: string) {
    return `${this.keyPrefix}:${dimension}:${createHash("sha256").update(value).digest("hex")}`;
  }

  private record(input: LoginRateLimitInput, action: string, outcome: string, metadata?: Record<string, unknown>) {
    return this.audit.record({
      organizationId: input.organizationId,
      actorId: input.userId,
      action,
      targetType: "User",
      targetId: input.userId,
      outcome,
      metadata,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    });
  }

  private unavailable() {
    return new ServiceUnavailableException({ code: "LOGIN_RATE_LIMIT_UNAVAILABLE", message: "Login is temporarily unavailable" });
  }
}
