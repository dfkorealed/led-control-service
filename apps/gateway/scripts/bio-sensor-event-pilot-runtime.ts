import type { BioSensorPulseCandidate } from "../src/bio/bio-command-codec";
import type { BioConfigurationState, BioOperationControl } from "../src/bio/bio-dongle-client";
export interface PilotOriginal { configuration: BioConfigurationState; raw: number }
export interface PilotPort {
  prepare(control: BioOperationControl): Promise<{ generation: number; originals: Record<"A" | "B", PilotOriginal> }>;
  sensor(control: BioOperationControl): Promise<void>;
  applyB(control: BioOperationControl): Promise<void>;
  link(control: BioOperationControl): Promise<boolean>;
  restore(name: "A" | "B", original: PilotOriginal, control: BioOperationControl): Promise<void>;
  close(): Promise<void>;
}
export interface PilotState { phase: string; originals: Record<"A" | "B", PilotOriginal> | null; pending: Array<"A" | "B">; occurrence: number; deadlineMonotonicMs: number | null; notification?: { body: string; generation: number; sequence: number; receivedMonotonicMs: number } }
export interface PilotOptions { holdSeconds: number; monotonic: () => number; journal: (state: PilotState) => Promise<void>; port: PilotPort }
export class PilotRuntime {
  private state: PilotState = { phase: "new", originals: null, pending: [], occurrence: 0, deadlineMonotonicMs: null };
  private queue: Promise<unknown> = Promise.resolve();
  private active = new AbortController();
  private stopping = false;
  private degraded = false;
  private stopPromise?: Promise<void>;
  private generation = -1;
  private startedAt = 0;
  private started = false;
  private last?: { sequence: number; body: string; at: number };
  constructor(private readonly options: PilotOptions) {
    if (!Number.isInteger(options.holdSeconds) || options.holdSeconds < 10 || options.holdSeconds > 1800) throw Error("PILOT_HOLD_RANGE");
  }
  get closed() { return this.stopping; }
  private run(job: () => Promise<void>) { const next = this.queue.then(job); this.queue = next.catch(() => {}); return next; }
  private control(): BioOperationControl { return { signal: this.active.signal, mayStartWrite: () => !this.stopping && !this.degraded }; }
  private save() { return this.options.journal(structuredClone(this.state)); }
  async start() {
    return this.run(async () => {
      if (this.state.phase !== "new" || this.stopping) throw Error("PILOT_ONE_USE");
      try {
        const prepared = await this.options.port.prepare(this.control());
        this.generation = prepared.generation; this.state.originals = prepared.originals;
        this.state.phase = "captured"; await this.save();
        // Pending is durable before either physical write; failure remains recoverable.
        this.state.pending.push("A"); await this.save();
        await this.options.port.sensor(this.control());
        if (this.stopping || this.degraded) throw Error("PILOT_STOPPED");
        this.startedAt = this.options.monotonic(); this.started = true; this.state.phase = "observing"; await this.save();
      } catch (error) { this.fault(); throw error; }
    });
  }
  async pulse(candidate: BioSensorPulseCandidate) {
    const copy = { ...candidate, innerBody: Buffer.from(candidate.innerBody) };
    return this.run(async () => {
      if (this.stopping || this.degraded || this.state.phase !== "observing") return;
      const now = this.options.monotonic(), at = copy.receivedMonotonicMs, body = copy.innerBody.toString("hex");
      if (copy.innerOpcode !== 9 || copy.deviceUuid !== "bio:e466e5265fe4" || copy.logicalAddress !== 256 || copy.networkId !== 0 ||
        copy.generation !== this.generation || !["0101000000000000", "0505000000000000"].includes(body) ||
        !Number.isFinite(at) || at < this.startedAt || at > now || now - at > 3000 || now - this.startedAt >= 300000) return;
      if (this.last) {
        const delta = (copy.sequence - this.last.sequence + 256) % 256;
        if (at < this.last.at || delta === 0 || delta > 127 || (body === this.last.body && at - this.last.at < 250)) return;
      }
      this.last = { sequence: copy.sequence, body, at };
      this.state.notification = { body, generation: copy.generation, sequence: copy.sequence, receivedMonotonicMs: at };
      try {
        if (!this.state.pending.includes("B")) {
          this.state.pending.push("B"); this.state.occurrence++;
          this.state.deadlineMonotonicMs = at + this.options.holdSeconds * 1000; await this.save();
          await this.options.port.applyB(this.control());
          if (this.stopping || this.degraded) return;
        } else this.state.deadlineMonotonicMs = at + this.options.holdSeconds * 1000;
        await this.save();
      } catch { this.fault(); await this.save().catch(() => {}); }
    });
  }
  async tick() {
    if (this.started && this.options.monotonic() - this.startedAt >= 300000) return this.stop();
    return this.run(async () => {
      if (this.stopping || this.degraded || this.state.deadlineMonotonicMs === null || this.options.monotonic() < this.state.deadlineMonotonicMs) return;
      try {
        // This separate GET proves node/link response only, never PIR capability.
        if (!await this.options.port.link(this.control())) throw Error("PILOT_NODE_LINK_UNKNOWN");
        if (this.stopping || this.degraded) return;
        await this.options.port.restore("B", this.state.originals!.B, this.control());
        this.state.pending = this.state.pending.filter(x => x !== "B"); this.state.deadlineMonotonicMs = null; await this.save();
      } catch { this.fault(); await this.save().catch(() => {}); }
    });
  }
  fault() { this.degraded = true; this.state.phase = "degraded"; this.active.abort(); }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; this.active.abort();
    this.stopPromise = this.run(async () => {
      const recovery = new AbortController();
      const timer = setTimeout(() => recovery.abort(), 30000);
      const control: BioOperationControl = { signal: recovery.signal, mayStartWrite: () => !recovery.signal.aborted };
      try {
        this.state.phase = "recovering"; await this.save().catch(() => {});
        for (const name of ["B", "A"] as const) {
          if (!this.state.pending.includes(name) || !this.state.originals) continue;
          try {
            await this.options.port.restore(name, this.state.originals[name], control);
            this.state.pending = this.state.pending.filter(x => x !== name); await this.save();
          } catch { /* Unknown recovery is durable pending, never an automatic retry. */ }
        }
      } finally {
        clearTimeout(timer); this.state.phase = this.state.pending.length ? "restore-pending" : "closed";
        await this.save().catch(() => {}); await this.options.port.close();
      }
    });
    return this.stopPromise;
  }
}
