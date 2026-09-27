import {
  commandClockRequestSchema,
  commandClockResponseSchema,
  GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS,
  type CommandClockRequest
} from "@led-control/shared";
import type { BootClockSample } from "./linux-boot-clock";

const MAX_RTT_MS = 1000;
const MAX_SAMPLE_AGE_MS = 10_000;
const MONOTONIC_ERROR_BUDGET_MS = 100;
export type CommandClockDecision = "allowed" | "expired" | "clock_untrusted";

export class DbClockProof {
  private pending?: { request: CommandClockRequest; start: BootClockSample };
  private cached?: { publishEpoch: number; dbUpperAtReceipt: number; uncertainty: number; end: BootClockSample };
  private lastSample?: BootClockSample;
  private highestEpoch = 0;

  constructor(private readonly scope: { siteId: string; gatewayId: string }) {}

  begin(request: CommandClockRequest, start: BootClockSample): boolean {
    const valid = commandClockRequestSchema.safeParse(request);
    if (!this.continuous(start) || !valid.success || !this.matchesScope(request)) {
      this.invalidate();
      return false;
    }
    this.pending = { request: { ...request }, start: { ...start } };
    return true;
  }

  observe(request: CommandClockRequest, response: unknown, start: BootClockSample, end: BootClockSample): boolean {
    if (!this.continuous(end)) return false;
    const pending = this.pending;
    // Unknown/reordered packets cannot consume the current nonce or refresh its age.
    if (!pending || request.nonce !== pending.request.nonce || !this.matchesScope(request) ||
        start.bootId !== pending.start.bootId || start.milliseconds !== pending.start.milliseconds) return false;
    const parsed = commandClockResponseSchema.safeParse(response);
    if (!parsed.success || !this.matchesScope(parsed.data) || parsed.data.nonce !== request.nonce) return false;
    this.pending = undefined;
    const rtt = end.milliseconds - start.milliseconds;
    // /proc/uptime truncates to centiseconds. Raw differences can undercount;
    // the same fixed budget must bound admission durations, not just DB expiry.
    // This intentionally rejects even exact synthetic RTTs above 900ms.
    const rttUpper = rtt + MONOTONIC_ERROR_BUDGET_MS;
    const uncertainty = rttUpper;
    if (start.bootId !== end.bootId || rtt < 0 || rttUpper > MAX_RTT_MS ||
        uncertainty >= GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS || parsed.data.publishEpoch < this.highestEpoch) {
      this.invalidate();
      return false;
    }
    this.highestEpoch = parsed.data.publishEpoch;
    this.cached = {
      publishEpoch: parsed.data.publishEpoch,
      dbUpperAtReceipt: Date.parse(parsed.data.dbNow) + uncertainty,
      uncertainty,
      end: { ...end }
    };
    return true;
  }

  allows(publishEpoch: number, expiresAt: string, now: BootClockSample): boolean {
    return this.evaluate(publishEpoch, expiresAt, now) === "allowed";
  }

  evaluate(publishEpoch: number, expiresAt: string, now: BootClockSample): CommandClockDecision {
    if (!this.continuous(now)) return "clock_untrusted";
    const cached = this.cached;
    if (!cached) return "clock_untrusted";
    const age = now.milliseconds - cached.end.milliseconds;
    const ageUpper = age + MONOTONIC_ERROR_BUDGET_MS;
    if (cached.publishEpoch !== publishEpoch || now.bootId !== cached.end.bootId || age < 0 ||
        ageUpper > MAX_SAMPLE_AGE_MS || cached.uncertainty >= GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS) {
      this.invalidate();
      return "clock_untrusted";
    }
    const expires = Date.parse(expiresAt);
    // Receipt upper already includes the full-interval 100ms budget. Raw RTT
    // plus raw age telescopes to now-start; adding ageUpper would count it twice.
    if (!Number.isFinite(expires)) return "clock_untrusted";
    return cached.dbUpperAtReceipt + age < expires - GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS ? "allowed" : "expired";
  }

  invalidate(): void {
    this.pending = undefined;
    this.cached = undefined;
  }

  private matchesScope(value: { siteId: string; gatewayId: string }): boolean {
    return value.siteId === this.scope.siteId && value.gatewayId === this.scope.gatewayId;
  }

  private continuous(sample: BootClockSample): boolean {
    const previous = this.lastSample;
    if (!Number.isSafeInteger(sample.milliseconds) || sample.milliseconds < 0 || !sample.bootId) {
      this.invalidate();
      return false;
    }
    this.lastSample = { ...sample };
    if (previous && (sample.bootId !== previous.bootId || sample.milliseconds < previous.milliseconds)) {
      this.invalidate();
      return false;
    }
    return true;
  }
}
