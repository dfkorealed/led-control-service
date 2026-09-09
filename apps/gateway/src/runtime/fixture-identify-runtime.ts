import { FIXTURE_IDENTIFY_TTL_MS, fixtureIdentifyCommandSchema, type FixtureIdentifyCommand, type FixtureIdentifyResult } from "@led-control/shared";

interface Options {
  siteId: string;
  gatewayId: string;
  setAttention?: (fixtureId: string, expiresAt: number, action: "start" | "stop", signal?: AbortSignal) => Promise<number>;
}

export class FixtureIdentifyRuntime {
  private readonly startedAt = Date.now();
  private readonly seen = new Map<string, number>();
  private readonly sessions = new Map<string, number>();
  private active?: FixtureIdentifyCommand;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private stopping = false;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: Options) {}

  handle(input: unknown): Promise<FixtureIdentifyResult> {
    const command = fixtureIdentifyCommandSchema.parse(input);
    if (command.siteId !== this.options.siteId || command.gatewayId !== this.options.gatewayId) {
      return Promise.reject(new Error("identify_scope_mismatch"));
    }
    if (this.pending >= 16) return Promise.resolve(this.failure(command, "gateway_busy"));
    this.pending++;
    const result = this.tail.then(() => this.apply(command));
    this.tail = result.catch(() => undefined).finally(() => { this.pending--; });
    return result;
  }

  async stop() {
    this.stopping = true;
    this.abort?.abort();
    await this.tail;
    const active = this.active;
    this.clearActive();
    if (active && Date.parse(active.expiresAt) > Date.now()) {
      // On-node expiry remains the safety boundary if shutdown cannot reach the node.
      await this.attention({ ...active, action: "stop", expiresAt: new Date(Date.now() + 2000).toISOString() }).catch(() => undefined);
    }
    this.seen.clear();
    this.sessions.clear();
  }

  private async apply(command: FixtureIdentifyCommand): Promise<FixtureIdentifyResult> {
    const now = Date.now();
    const expires = Date.parse(command.expiresAt);
    const requested = Date.parse(command.requestedAt);
    for (const cache of [this.seen, this.sessions]) for (const [id, expiry] of cache) if (expiry <= now) cache.delete(id);
    if (this.active && Date.parse(this.active.expiresAt) <= now) this.clearActive();
    if (this.stopping) return this.failure(command, "gateway_stopping");
    if (expires <= now || requested > now) return this.failure(command, "command_expired");
    // Memory-only receipt caches must not replay a pre-restart start. During this
    // bounded boot window any previously sent on-node Attention has time to expire.
    if (requested < this.startedAt || now < this.startedAt + FIXTURE_IDENTIFY_TTL_MS) return this.failure(command, "gateway_starting");
    if (this.seen.has(command.commandId)) return this.failure(command, "duplicate_command");
    if (this.seen.size >= 256 || this.sessions.size >= 256) return this.failure(command, "identify_capacity");
    this.seen.set(command.commandId, expires);
    if (!this.options.setAttention) return this.failure(command, "attention_unsupported");
    if (command.action === "start") {
      if (this.sessions.has(command.sessionId)) return this.failure(command, "duplicate_session");
      if (this.active) return this.failure(command, "gateway_busy");
      this.sessions.set(command.sessionId, now + 30_000);
      this.active = command;
      this.expiryTimer = setTimeout(() => this.clearActive(), expires - now);
      this.expiryTimer.unref?.();
    } else {
      // A stop can overtake a lost/delayed start. Remember its session even when
      // there is no active target so that delayed start cannot blink afterwards.
      this.sessions.set(command.sessionId, now + 30_000);
      if (this.active?.sessionId !== command.sessionId || this.active.fixtureId !== command.fixtureId) {
        return this.failure(command, "stale_session");
      }
    }
    try {
      const attentionSeconds = await this.attention(command);
      if (Date.now() >= expires) return this.failure(command, "command_expired");
      if ((command.action === "start" && attentionSeconds <= 0) || (command.action === "stop" && attentionSeconds !== 0)) {
        return this.failure(command, "attention_status_mismatch");
      }
      if (command.action === "stop") this.clearActive();
      return { ...command, status: command.action === "start" ? "attention_confirmed" : "stopped", attentionSeconds,
        reportedAt: new Date().toISOString() };
    } catch (error) {
      // A timeout does not prove RF was not applied. Keep the active reservation
      // until a confirmed stop or the original TTL, never retry/extend a start.
      const reason = error instanceof Error && /^[a-z_]{1,128}$/.test(error.message) ? error.message : "attention_send_failed";
      return { ...this.failure(command, reason), status: reason === "attention_timeout" ? "timed_out" : "rejected" };
    }
  }

  private attention(command: FixtureIdentifyCommand) {
    const controller = new AbortController();
    this.abort = controller;
    return new Promise<number>((resolve, reject) => {
      const finish = (error?: unknown, seconds?: number) => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        if (this.abort === controller) this.abort = undefined;
        if (error) reject(error); else resolve(seconds!);
      };
      const onAbort = () => finish(new Error(this.stopping ? "gateway_stopping" : "attention_timeout"));
      const timer = setTimeout(() => controller.abort(), Math.min(2200, Math.max(1, Date.parse(command.expiresAt) - Date.now())));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve().then(() => this.options.setAttention!(command.fixtureId, Date.parse(command.expiresAt), command.action, controller.signal))
        .then((seconds) => finish(undefined, seconds), (error) => finish(error));
    });
  }
  private clearActive() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.active = undefined;
  }
  private failure(command: FixtureIdentifyCommand, reason: string): FixtureIdentifyResult {
    return { ...command, status: "rejected", reason, reportedAt: new Date().toISOString() };
  }
}
