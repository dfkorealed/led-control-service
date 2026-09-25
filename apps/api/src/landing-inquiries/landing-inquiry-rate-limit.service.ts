import { HttpException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RedisProvider } from "../redis/redis.provider";

const WINDOW_SECONDS = 15 * 60;
const MAX_INQUIRIES_PER_IP = 5;
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
local ttl = redis.call('TTL', KEYS[1])
if count > tonumber(ARGV[2]) then return {0, math.max(ttl, 1)} end
return {1, math.max(ttl, 1)}
`;

@Injectable()
export class LandingInquiryRateLimitService {
  constructor(private readonly redis: RedisProvider) {}

  async consume(ip: string): Promise<void> {
    const key = `landing:inquiry:ip:${createHash("sha256").update(ip).digest("hex")}`;
    let result: unknown;
    try {
      result = await this.redis.getClient().eval(CONSUME_SCRIPT, 1, key, WINDOW_SECONDS, MAX_INQUIRIES_PER_IP);
    } catch {
      throw new ServiceUnavailableException({ code: "LANDING_RATE_LIMIT_UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." });
    }
    if (!Array.isArray(result) || result.length !== 2 || ![0, 1].includes(Number(result[0])) || !Number.isInteger(Number(result[1]))) {
      throw new ServiceUnavailableException({ code: "LANDING_RATE_LIMIT_UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." });
    }
    if (Number(result[0]) === 0) {
      throw new HttpException({ code: "LANDING_RATE_LIMITED", message: "잠시 후 다시 시도해 주세요.", retryAfterSeconds: Number(result[1]) }, 429);
    }
  }
}
