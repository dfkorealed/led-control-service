import { randomUUID } from "node:crypto";
import { fixtureRegistrationRemovalBindingIdentity, fixtureRegistrationRemovalCommandSchema,
  fixtureRegistrationRemovalTerminalSchema, fixtureRegistrationRemovalTopics,
  type FixtureRegistrationRemovalCommand, type FixtureRegistrationRemovalTerminal } from "@led-control/shared";
import { FixtureRegistrationRemovalJournal, registrationRemovalHash } from "../state/fixture-registration-removal-journal";

export interface RegistrationRemovalPort {
  retireRegistration(command: FixtureRegistrationRemovalCommand, assertSafe: () => Promise<void>): Promise<void>;
  retirement(command: FixtureRegistrationRemovalCommand): Promise<unknown | null>;
  fenceRegistration(command: FixtureRegistrationRemovalCommand): void;
  releaseRegistrationFence(operationId: string): void;
}
export interface RegistrationRemovalOptions {
  journal: FixtureRegistrationRemovalJournal; port?: RegistrationRemovalPort;
  scope: { siteId: string; gatewayId: string; gatewaySerial: string; assignmentVersion: number };
  clockTrusted(): Promise<boolean>; blockedReason(command: FixtureRegistrationRemovalCommand): Promise<string | null>;
  afterRetire(command: FixtureRegistrationRemovalCommand): Promise<void>;
  now?: () => Date; onError?: (error: unknown) => void;
  retryMs?: number; publishTimeoutMs?: number;
}
export class RegistrationRemovalRefused extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Intake, replay and reconnect share one journal owner; removal never calls RF. */
export class FixtureRegistrationRemovalHandler {
  private publish?: (topic: string, value: FixtureRegistrationRemovalTerminal) => Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private readonly tasks = new Set<Promise<unknown>>();
  private stopped = false;
  private generation = 0;
  private retryDelay: number;
  constructor(private readonly options: RegistrationRemovalOptions) {
    this.retryDelay = options.retryMs ?? 1_000;
    if (!Number.isSafeInteger(this.retryDelay) || this.retryDelay < 1 || this.retryDelay > 30_000
      || (options.publishTimeoutMs !== undefined && (!Number.isSafeInteger(options.publishTimeoutMs) || options.publishTimeoutMs < 1))) throw new Error("REMOVAL_RETRY_CONFIG_INVALID");
  }
  private inScope(command: FixtureRegistrationRemovalCommand) {
    return Object.entries(this.options.scope).every(([key, value]) => command[key as keyof typeof this.options.scope] === value);
  }
  handle(raw: unknown, onDurableReceipt?: () => void): Promise<FixtureRegistrationRemovalTerminal> {
    const command = fixtureRegistrationRemovalCommandSchema.parse(raw);
    if (!this.inScope(command)) throw new Error("REMOVAL_SCOPE_MISMATCH");
    if (this.stopped) return Promise.reject(new Error("GATEWAY_SHUTDOWN"));
    const task = this.options.journal.serialize(() => this.execute(command, onDurableReceipt));
    this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => undefined); return task;
  }
  async recover() {
    for (const row of await this.options.journal.records()) {
      if (!this.inScope(row.command)) continue;
      if (!row.terminal || row.terminal.status === "reconcile_required") this.options.port?.fenceRegistration(row.command);
      if (!row.terminal || row.terminal.status === "reconcile_required") await this.handle(row.command);
    }
  }
  private async execute(command: FixtureRegistrationRemovalCommand, received?: () => void): Promise<FixtureRegistrationRemovalTerminal> {
    const { journal, port } = this.options, { record, fresh } = await journal.accept(command);
    received?.();
    if (record.terminal && (record.terminal.status !== "reconcile_required" || !port)) {
      this.wake(); return record.terminal;
    }
    let status: FixtureRegistrationRemovalTerminal["status"] = "rejected", errorCode: string | null = null;
    let mutationPossible = false, admitted = record.admitted;
    try {
      if (!port) throw new RegistrationRemovalRefused("UNSUPPORTED_ADAPTER");
      if (registrationRemovalHash(fixtureRegistrationRemovalBindingIdentity(command)) !== command.bindingHash) throw new RegistrationRemovalRefused("REMOVAL_BINDING_HASH_MISMATCH");
      // A tombstone or durable admitted intent authorizes exact reconciliation,
      // even after TTL. Bare intake alone never grants post-expiry deletion.
      const retired = await port.retirement(command);
      if (record.terminal && !retired && !record.admitted) { this.wake(); return record.terminal; }
      if (!fresh && !retired && !record.admitted) throw new RegistrationRemovalRefused("REMOVAL_NOT_ADMITTED");
      if (!retired) {
        const check = async () => {
          if (this.stopped) throw new RegistrationRemovalRefused("GATEWAY_SHUTDOWN");
          if (!await this.options.clockTrusted()) throw new RegistrationRemovalRefused("GATEWAY_CLOCK_UNTRUSTED");
          const now = (this.options.now?.() ?? new Date()).getTime();
          if (fresh && (now < Date.parse(command.requestedAt) || now >= Date.parse(command.expiresAt))) throw new RegistrationRemovalRefused("COMMAND_EXPIRED");
          const reason = await this.options.blockedReason(command); if (reason) throw new RegistrationRemovalRefused(reason);
        };
        await check();
        if (fresh) { await journal.admit(command.operationId); admitted = true; }
        await port.retireRegistration(command, async () => { await check(); mutationPossible = true; });
      } else {
        // Re-fsync the known tombstone if the previous process lost a parent
        // directory durability barrier; never infer success from visibility only.
        mutationPossible = true; await port.retireRegistration(command, async () => undefined);
      }
      await this.options.afterRetire(command);
      status = "removed";
    } catch (error) {
      // A previous admission can already own a durable mapping manifest. A
      // temporary safety refusal must preserve that intent for exact recovery;
      // a definitive rejection would strand its persistent registration fence.
      if (error instanceof RegistrationRemovalRefused && !mutationPossible && !admitted) errorCode = error.code;
      else if (fresh && error instanceof Error && error.message === "BIO_REMOVAL_BINDING_MISMATCH") errorCode = "REMOVAL_BINDING_MISMATCH";
      else { status = "reconcile_required"; errorCode = "REMOVAL_RECONCILE_REQUIRED"; port?.fenceRegistration(command); }
    }
    if (record.terminal && status !== "removed") { this.wake(); return record.terminal; }
    const occurredAt = new Date(Math.max((this.options.now?.() ?? new Date()).getTime(), Date.parse(command.requestedAt))).toISOString();
    const terminal = await journal.complete(fixtureRegistrationRemovalTerminalSchema.parse({ ...command, commandHash: registrationRemovalHash(command),
      eventId: randomUUID(), occurredAt, status, errorCode }));
    if (status !== "reconcile_required") port?.releaseRegistrationFence(command.operationId);
    this.wake(); return terminal;
  }
  connect(publish: NonNullable<FixtureRegistrationRemovalHandler["publish"]>) {
    this.disconnect(); this.publish = publish; this.retryDelay = this.options.retryMs ?? 1_000; this.wake();
  }
  disconnect() { this.generation++; this.publish = undefined; clearTimeout(this.timer); this.timer = undefined; }
  async acknowledge(raw: unknown) { const applied = await this.options.journal.acknowledge(raw); if (applied) this.wake(); return applied; }
  wake() {
    if (this.stopped || !this.publish || this.timer || this.flushing) return;
    const generation = this.generation;
    this.timer = setTimeout(() => { this.timer = undefined;
      void this.flush(generation).catch(error => this.options.onError?.(error)).finally(() => {
        if (this.publish) this.wake();
      });
    }, this.retryDelay);
    this.timer.unref();
  }
  flush(generation = this.generation): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.drain(generation).finally(() => { this.flushing = undefined; });
    this.flushing = run; return run;
  }
  private async drain(generation: number) {
    const publish = this.publish; if (!publish || this.stopped) return;
    const records = await this.options.journal.records();
    const pending = records.filter(row => row.terminal && !row.acknowledged && this.inScope(row.command));
    try { for (const row of pending) {
      if (generation !== this.generation || this.stopped) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([publish(fixtureRegistrationRemovalTopics.terminal(row.command.siteId, row.command.gatewayId), row.terminal!),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("REMOVAL_PUBLISH_TIMEOUT")), this.options.publishTimeoutMs ?? 10_000); })]);
      } finally { clearTimeout(timer); }
    } } finally {
      if (generation === this.generation) this.retryDelay = pending.length ? Math.min(30_000, this.retryDelay * 2) : (this.options.retryMs ?? 1_000);
    }
  }
  async stopAndDrain() { this.stopped = true; this.disconnect(); await Promise.allSettled([...this.tasks]); await this.flushing; }
}
