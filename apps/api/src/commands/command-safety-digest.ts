import { Injectable, Optional } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

export type CommandSafetyDomain = "set-replay" | "set-replay-orphan" | "status-check-replay" | "late-set-wire"
  | "late-set-dispatch" | "legacy-status-check-global" | "legacy-status-check-dispatch"
  | "manual-source" | "manual-execution-full-event"
  | "monitoring-activity" | "recommission-retry" | "recovery-cursor";
export type VersionedCommandDigest = { keyVersion: number; value: string };
type Keyring = { activeVersion: number; keys: Record<number, string> };

export class CommandSafetyKeyUnavailableError extends Error {}

/**
 * A durable server-key HMAC keeps low-entropy client request keys and Gateway
 * source IDs out of long-lived safety markers. The keyring must be available
 * across every API instance and retain old versions while markers use them.
 */
@Injectable()
export class CommandSafetyDigest {
  constructor(@Optional() private readonly configured?: Keyring) {}

  sign(domain: CommandSafetyDomain, parts: readonly string[]): VersionedCommandDigest {
    const ring = this.keyring();
    return { keyVersion: ring.activeVersion,
      value: this.compute(domain, parts, ring.activeVersion, ring) };
  }

  signAll(domain: CommandSafetyDomain, parts: readonly string[]): VersionedCommandDigest[] {
    const ring = this.keyring();
    const versions = Object.keys(ring.keys).map(Number).sort((a, b) => a - b);
    if (!versions.includes(ring.activeVersion)) throw new CommandSafetyKeyUnavailableError("command safety HMAC key unavailable");
    return versions.map((keyVersion) => ({ keyVersion, value: this.compute(domain, parts, keyVersion, ring) }));
  }

  verify(domain: CommandSafetyDomain, parts: readonly string[], expected: VersionedCommandDigest): boolean {
    const ring = this.keyring();
    const actual = this.compute(domain, parts, expected.keyVersion, ring);
    if (!/^hmac-sha256:[a-f0-9]{64}$/.test(expected.value)) return false;
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected.value));
  }

  private compute(domain: CommandSafetyDomain, parts: readonly string[], version: number, ring: Keyring): string {
    const encodedKey = ring.keys[version];
    if (!encodedKey) throw new CommandSafetyKeyUnavailableError("command safety HMAC key unavailable");
    const key = Buffer.from(encodedKey, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
      throw new CommandSafetyKeyUnavailableError("invalid command safety HMAC key");
    }
    // Canonical tuple encoding prevents component concatenation ambiguity and
    // makes replay, source, and wire receipts cryptographically independent.
    return `hmac-sha256:${createHmac("sha256", key).update(JSON.stringify([domain, ...parts])).digest("hex")}`;
  }

  private keyring(): Keyring {
    if (this.configured) return this.configured;
    const version = Number(process.env.COMMAND_SAFETY_HMAC_ACTIVE_VERSION);
    let keys: Record<number, string> = {};
    try {
      const parsed: unknown = JSON.parse(process.env.COMMAND_SAFETY_HMAC_KEYS_JSON ?? "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || Object.values(parsed).some((value) => typeof value !== "string")) throw new Error();
      keys = parsed as Record<number, string>;
    } catch {
      throw new CommandSafetyKeyUnavailableError("invalid command safety HMAC keyring");
    }
    if (!Number.isSafeInteger(version) || version < 1) throw new CommandSafetyKeyUnavailableError("command safety HMAC key unavailable");
    return { activeVersion: version, keys };
  }
}
