import { mqttTopics, temporaryControlCommandSchema, temporaryControlIngestedReceiptSchema,
  type TemporaryControlCommand, type TemporaryControlResult } from "@led-control/shared";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";
import type { BioTemporaryControlRuntime, TemporaryDeliveryAuthority } from "./bio-temporary-control-runtime";
import type { TemporaryControlResultOutbox } from "./temporary-control-result-outbox";
import type { ClockTrustProvider } from "./clock-trust-provider";

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Delivery freshness is independent of the original immutable command identity.
 * A broker PUBACK authorizes neither admission nor target settlement. */
export function parseTemporaryControlDelivery(value: unknown,
  scope: { siteId: string; gatewayId: string; assignmentVersion: number }, now: Date): { command: TemporaryControlCommand; authority: TemporaryDeliveryAuthority } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("temporary_delivery_invalid");
  const { deliveryGeneration, deliveryGeneratedAt, deliveryWindowMs, expiresAt, deliveryPayloadHash, ...original } = value as Record<string, unknown>;
  if (typeof deliveryGeneration !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryGeneration) ||
    typeof deliveryGeneratedAt !== "string" || !instant.test(deliveryGeneratedAt) || !Number.isFinite(Date.parse(deliveryGeneratedAt)) ||
    typeof expiresAt !== "string" || !instant.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) ||
    typeof deliveryWindowMs !== "number" || !Number.isInteger(deliveryWindowMs) || deliveryWindowMs <= 0 || deliveryWindowMs > 10_000 ||
    typeof deliveryPayloadHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(deliveryPayloadHash)) throw new Error("temporary_delivery_invalid");
  const command = temporaryControlCommandSchema.parse(original);
  const { payloadHash, ...payload } = command;
  if (bioEnvelopeHash(payload) !== payloadHash ||
    bioEnvelopeHash({ ...command, deliveryGeneration, deliveryGeneratedAt, deliveryWindowMs, expiresAt }) !== deliveryPayloadHash) {
    throw new Error("temporary_delivery_hash_mismatch");
  }
  const generated = Date.parse(deliveryGeneratedAt), expires = Date.parse(expiresAt), epoch = now.getTime();
  if (command.siteId !== scope.siteId || command.gatewayId !== scope.gatewayId || command.assignmentVersion !== scope.assignmentVersion) {
    throw new Error("temporary_delivery_scope_mismatch");
  }
  if (!Number.isFinite(epoch) || expires !== generated + deliveryWindowMs || epoch < generated || epoch >= expires ||
    (command.kind === "start" && (epoch < Date.parse(command.startedAt) || epoch >= Date.parse(command.endsAt) || expires > Date.parse(command.endsAt)))) {
    throw new Error("temporary_delivery_expired");
  }
  return { command, authority: { generatedAt: generated, expiresAt: expires } };
}

export class TemporaryControlMqtt {
  private publish?: (topic: string, value: TemporaryControlResult) => Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private expiry?: Promise<void>;
  private generation = 0;
  private offset = 0;
  private retryMs: number;
  private stopping = false;
  constructor(private readonly options: {
    scope: { siteId: string; gatewayId: string; assignmentVersion: number };
    runtime: Pick<BioTemporaryControlRuntime, "accept" | "release" | "expire" | "stopAndDrain">;
    outbox: TemporaryControlResultOutbox; clockTrust: ClockTrustProvider; now?: () => Date;
    settleReceipt?: (operation: () => Promise<boolean>) => Promise<boolean>;
    publishTimeoutMs?: number; retryInitialMs?: number; retryMaxMs?: number; onError?: (error: unknown) => void;
  }) { this.retryMs = options.retryInitialMs ?? 1000; }

  async handleCommand(payload: Buffer) {
    if (this.stopping) throw new Error("temporary_runtime_stopping");
    const now = this.now();
    const { command, authority } = parseTemporaryControlDelivery(JSON.parse(payload.toString()), this.options.scope, now);
    if (command.kind === "start") {
      if (!await this.options.clockTrust.isTrusted(now)) throw new Error("temporary_clock_untrusted");
      await this.options.runtime.accept(command, authority);
    } else await this.options.runtime.release(command);
    await this.wake();
  }

  async handleReceipt(payload: Buffer) {
    const receipt = temporaryControlIngestedReceiptSchema.parse(JSON.parse(payload.toString()));
    const settle = () => this.options.outbox.confirm(receipt);
    await (this.options.settleReceipt ? this.options.settleReceipt(settle) : settle());
    // Rejected immutable receipts cannot be replayed into acceptance. The next
    // expiry reconciliation must establish a fresh goal/readback and event ID.
    await this.expireOnce();
    await this.wake();
  }

  start() {
    if (this.ticker || this.stopping) return;
    this.ticker = setInterval(() => { void this.expireOnce().catch(error => this.options.onError?.(error)); }, 1000);
  }
  connect(publish: (topic: string, value: TemporaryControlResult) => Promise<void>) {
    this.disconnect(); this.publish = publish; this.retryMs = this.options.retryInitialMs ?? 1000;
    return this.wake();
  }
  disconnect() { this.generation++; this.publish = undefined; clearTimeout(this.retry); this.retry = undefined; }
  async wake(): Promise<void> {
    if (this.stopping || !this.publish) return;
    if (this.flight) { await this.flight; return this.wake(); }
    clearTimeout(this.retry); this.retry = undefined;
    const generation = this.generation, publish = this.publish;
    const flight = (async () => {
      try {
        const records = await this.options.outbox.pending();
        if (this.offset >= records.length) this.offset = 0;
        const batch = records.slice(this.offset, this.offset + 50); this.offset += batch.length;
        for (const result of batch) {
          if (generation !== this.generation || this.stopping) return;
          await publishWithin(publish!(mqttTopics.temporaryControlResult(this.options.scope.siteId, this.options.scope.gatewayId), result),
            this.options.publishTimeoutMs ?? 10_000);
        }
      } catch (error) { this.options.onError?.(error); }
      finally {
        if (generation === this.generation && this.publish && !this.stopping) {
          this.retry = setTimeout(() => { this.retry = undefined; void this.wake(); }, this.retryMs);
          this.retryMs = Math.min(this.retryMs * 2, this.options.retryMaxMs ?? 30_000);
        }
      }
    })();
    this.flight = flight;
    try { await flight; } finally { if (this.flight === flight) this.flight = undefined; }
  }
  async stopAndDrain() {
    this.stopping = true; this.disconnect(); clearInterval(this.ticker); this.ticker = undefined;
    await this.options.runtime.stopAndDrain(); await this.expiry; await this.flight;
  }
  private now() { return this.options.now?.() ?? new Date(); }
  private expireOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.expiry) return this.expiry;
    const expiry = this.options.runtime.expire(this.now()).finally(() => { if (this.expiry === expiry) this.expiry = undefined; });
    this.expiry = expiry; return expiry;
  }
}

function publishWithin(promise: Promise<void>, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("temporary_result_publish_timeout")), milliseconds);
    promise.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
  });
}
