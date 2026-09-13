import type { BioByteConnection } from "./bio-byte-connection";
import { BioFrameCodec, encodeCrcFrame, encodeGsFrame, type BioFrame, type BioProtocol } from "./bio-frame-codec";
import { BioUsbError, type BioUsbErrorCode } from "./bio-usb-error";

export interface BioTransportSnapshot {
  state: "stopped" | "connecting" | "probing" | "validating" | "ready" | "reconnecting" | "closing" | "close-failed";
  generation: number;
  transportConnected: boolean;
  protocolReady: boolean;
  ready: boolean;
  protocol?: BioProtocol;
  lastError?: BioUsbErrorCode;
}
export interface BioTransportOptions {
  /** Installed Android 1.2.0 uses converter-info startup and separate ACK/notification channels. */
  profile?: "legacy" | "android-v1.2.0";
  protocol?: BioProtocol | "auto";
  timeoutMs?: number;
  connectionFactory: () => BioByteConnection;
  /** The adapter must validate its durable mapping before enabling requests. */
  validateReadiness: (probe: BioFrame) => Promise<void>;
}
/** Raw substrate only: callers must gate operation encodings on verified traces. */
export interface BioUsbRequest {
  command: number;
  payload: Uint8Array;
}
interface PendingRequest {
  command: number;
  bytes: Buffer;
  resolve: (frame: BioFrame) => void;
  reject: (error: BioUsbError) => void;
}

export class BioUsbTransport {
  private status: BioTransportSnapshot = { state: "stopped", generation: 0, transportConnected: false, protocolReady: false, ready: false };
  private readonly listeners = new Set<(state: BioTransportSnapshot) => void>();
  private readonly notificationListeners = new Set<(frame: BioFrame) => void>();
  private readonly codec = new BioFrameCodec();
  private readonly queue: PendingRequest[] = [];
  private connection?: BioByteConnection;
  private unsubscribe: (() => void)[] = [];
  private active?: PendingRequest;
  private startup?: { resolve: () => void; reject: (error: BioUsbError) => void };
  private timeout?: ReturnType<typeof setTimeout>;
  private partialTimeout?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private writing = false;
  private reconnectDelay = 2000;
  private nextProtocol: BioProtocol;
  private closing: Promise<void> = Promise.resolve();
  private closeError?: BioUsbError;
  private attempt?: { promise: Promise<void>; resolve: () => void; reject: (error: BioUsbError) => void };

  constructor(private readonly options: BioTransportOptions) {
    const timeout = options.timeoutMs ?? 300;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new RangeError("Invalid BIO response timeout");
    if (options.profile === "android-v1.2.0" && options.protocol !== undefined && options.protocol !== "crc16") {
      throw new RangeError("Installed BIO profile has only CRC frame evidence");
    }
    this.nextProtocol = options.protocol === "gs" ? "gs" : "crc16";
  }

  start(): Promise<void> {
    if (this.closeError) return Promise.reject(this.closeError);
    if (this.running) {
      if (this.attempt) return this.attempt.promise;
      return this.status.ready ? Promise.resolve() : Promise.reject(new BioUsbError("NOT_READY", "BIO transport is reconnecting"));
    }
    this.running = true;
    return this.connect();
  }

  async request(request: BioUsbRequest): Promise<BioFrame> {
    if (!this.status.ready) throw new BioUsbError("NOT_READY", "BIO transport is not ready");
    if (request.command === 0xff) throw new RangeError("BIO command has no one-byte successor response");
    const bytes = this.status.protocol === "crc16" ? encodeCrcFrame(request.command, request.payload) : encodeGsFrame(request.command, request.payload);
    return new Promise<BioFrame>((resolve, reject) => {
      this.queue.push({ command: request.command, bytes, resolve, reject });
      // A notification listener can enqueue reentrantly while receive() still
      // owns other frames from the same chunk. Inspect those before writing.
      if (this.options.profile === "android-v1.2.0") void Promise.resolve().then(() => this.pump());
      else this.pump();
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const closing = this.retire(new BioUsbError("STOPPED", "BIO transport stopped"));
    this.update({ state: "closing" });
    await closing;
    this.update({ state: "stopped" });
  }

  snapshot(): BioTransportSnapshot {
    return { ...this.status };
  }
  onState(listener: (state: BioTransportSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  onNotification(listener: (frame: BioFrame) => void): () => void {
    this.notificationListeners.add(listener);
    return () => { this.notificationListeners.delete(listener); };
  }

  private connect(): Promise<void> {
    const generation = this.status.generation + 1;
    let resolve!: () => void;
    let reject!: (error: BioUsbError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.attempt = { promise, resolve, reject };
    this.update({ state: "connecting", generation, protocol: this.nextProtocol });
    void this.openAndProbe(generation).catch((cause: unknown) => {
      const error = cause instanceof BioUsbError ? cause : new BioUsbError("DISCONNECTED", "BIO USB connection failed", { cause });
      this.fail(generation, error);
    });
    return promise;
  }

  private async openAndProbe(generation: number) {
    if (this.connection) await this.closing;
    if (!this.current(generation)) return;
    const connection = this.options.connectionFactory();
    this.connection = connection;
    this.unsubscribe = [
      connection.onData((bytes) => this.receive(generation, bytes)),
      connection.onDisconnect(() => this.fail(generation, new BioUsbError("DISCONNECTED", "BIO USB disconnected")))
    ];
    const traced = this.options.profile === "android-v1.2.0";
    // Arm before native open so even an early info frame is preserved. HIL
    // requires both converter literals, not a passive power-on wait or an 83 ACK.
    const startup = traced ? new Promise<void>((resolve, reject) => {
      this.startup = { resolve, reject };
      this.timeout = setTimeout(() => this.fail(generation, new BioUsbError("TIMEOUT", "BIO converter info timed out")), this.options.timeoutMs ?? 300);
    }) : undefined;
    void startup?.catch(() => {});
    await connection.open();
    if (!this.current(generation)) {
      await connection.close();
      return;
    }
    this.update({ state: "probing", transportConnected: true });
    if (traced) {
      for (const literal of ["55aa82000000", "4753820000"]) {
        if (!this.current(generation)) return;
        await connection.write(Buffer.from(literal, "hex"));
      }
      await startup;
      if (!this.current(generation)) return;
      // Keep the startup deadline through both native write/drain operations,
      // even if info arrived early. The network request gets its own deadline.
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    // The APK probes deliberately have zero trailers; normal frame encoders
    // must never be used here or taught to bypass response checksum validation.
    // Installed-app trace uses GET_NWK 0A/0B; 82 is a legacy converter hint,
    // not evidence that every connected dongle must return command 83.
    const literal = traced ? "55aa0a000710" : this.status.protocol === "crc16" ? "55aa82000000" : "4753820000";
    const probe = await new Promise<BioFrame>((resolve, reject) => this.begin({ command: traced ? 0x0a : 0x82, bytes: Buffer.from(literal, "hex"), resolve, reject }));
    if (!this.current(generation)) return;
    this.update({ state: "validating", protocolReady: true });
    try {
      await this.options.validateReadiness(probe);
    } catch (cause) {
      throw new BioUsbError("READINESS", "BIO mapping readiness validation failed", { cause });
    }
    if (!this.current(generation)) return;
    this.reconnectDelay = 2000;
    this.update({ state: "ready", ready: true, lastError: undefined });
    this.attempt?.resolve();
    this.attempt = undefined;
  }

  private pump() {
    if (!this.status.ready || this.active || this.writing || this.codec.hasPendingFrame()) return;
    const next = this.queue.shift();
    if (next) this.begin(next);
  }

  private begin(request: PendingRequest) {
    if (this.codec.hasPendingFrame()) {
      this.fail(this.status.generation, new BioUsbError(
        "LATE_RESPONSE",
        "BIO response candidate started before request ownership"
      ));
      return;
    }
    const generation = this.status.generation;
    this.active = request;
    this.writing = true;
    this.armResponseTimeout();
    void this.connection!.write(request.bytes).then(() => {
      if (!this.current(generation)) return;
      this.writing = false;
      this.pump();
    }, () => this.fail(generation, new BioUsbError("DISCONNECTED", "BIO USB write failed")));
  }

  private armResponseTimeout() {
    const generation = this.status.generation;
    this.timeout = setTimeout(() => this.fail(generation, new BioUsbError("TIMEOUT", "BIO response timed out")), this.options.timeoutMs ?? 300);
  }

  private receive(generation: number, bytes: Buffer) {
    if (!this.current(generation)) return;
    for (const event of this.codec.push(bytes)) {
      if (!this.current(generation)) break;
      if (event.type === "malformed") {
        this.fail(generation, new BioUsbError("MALFORMED_FRAME", "Malformed BIO frame"));
        break;
      }
      if (this.options.profile === "android-v1.2.0" && (event.frame.command === 0x03 || (event.frame.protocol === "crc16" && event.frame.command === 0x12))) {
        // Converter detection can return 03 in either validated framing. Only
        // 03 releases startup; device RX 12 and unrelated ACKs never do.
        if (event.frame.command === 0x03 && this.startup) {
          this.startup.resolve();
          this.startup = undefined;
        }
        // These frames cannot acknowledge the in-flight request. A device RX
        // may arrive before/after 11 or with an unrelated device sequence.
        for (const listener of this.notificationListeners) listener(event.frame);
        continue;
      }
      if (!this.active || event.frame.protocol !== this.status.protocol || event.frame.command !== this.active.command + 1) {
        this.fail(generation, new BioUsbError("LATE_RESPONSE", "Unexpected or late BIO response"));
        break;
      }
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = undefined;
      const completed = this.active;
      this.active = undefined;
      completed.resolve(event.frame);
    }
    // A partial duplicate, including its first header byte, already belongs to
    // the previous request. Never let its later tail complete a queued request.
    if (!this.codec.hasPendingFrame() && this.partialTimeout) {
      clearTimeout(this.partialTimeout);
      this.partialTimeout = undefined;
    }
    if (this.current(generation) && !this.active && this.codec.hasPendingFrame()) {
      if (this.options.profile !== "android-v1.2.0") {
        this.fail(generation, new BioUsbError("LATE_RESPONSE", "BIO response candidate crossed request ownership"));
        return;
      }
      // An idle fragmented notification is normal. Keep subsequent requests
      // queued until its full header/frame establishes ownership; a duplicate
      // ACK then fails while no new request can consume it. Bound stalled input.
      this.partialTimeout ??= setTimeout(() => this.fail(generation, new BioUsbError("TIMEOUT", "BIO partial notification timed out")), this.options.timeoutMs ?? 300);
    }
    // Finish inspecting complete and partial candidates before another request
    // becomes eligible to own bytes from this connection.
    void Promise.resolve().then(() => { if (this.current(generation)) this.pump(); });
  }

  private current(generation: number) {
    return this.running && this.status.generation === generation;
  }

  private fail(generation: number, error: BioUsbError) {
    if (!this.current(generation)) return;
    if (this.options.profile !== "android-v1.2.0" && this.status.state === "probing" && (this.options.protocol ?? "auto") === "auto") {
      this.nextProtocol = this.status.protocol === "crc16" ? "gs" : "crc16";
    } else if (this.status.protocol) this.nextProtocol = this.status.protocol;
    // Observe the rejection without replacing the failed cleanup barrier with
    // a resolved promise. stop/start must still report uncertain ownership.
    void this.retire(error).catch(() => {});
    this.update({ state: "reconnecting", lastError: error.code });
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 32000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) void this.connect().catch(() => {});
    }, delay);
  }

  private retire(error: BioUsbError): Promise<void> {
    this.status = { ...this.status, generation: this.status.generation + 1, transportConnected: false, protocolReady: false, ready: false };
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    if (this.partialTimeout) clearTimeout(this.partialTimeout);
    this.partialTimeout = undefined;
    this.codec.reset();
    this.startup?.reject(error);
    this.startup = undefined;
    this.active?.reject(error);
    this.active = undefined;
    for (const pending of this.queue.splice(0)) pending.reject(error);
    this.attempt?.reject(error);
    this.attempt = undefined;
    this.writing = false;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    const connection = this.connection;
    this.closing = this.closing.then(async () => {
      await connection?.close();
      // Retain ownership until native close confirms the descriptor was closed.
      if (this.connection === connection) this.connection = undefined;
    }).catch((cause: unknown) => {
      this.closeError ??= new BioUsbError("CLOSE_FAILED", "BIO USB connection closure was not confirmed", { cause });
      this.attempt?.reject(this.closeError);
      this.attempt = undefined;
      this.running = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.update({ state: "close-failed", lastError: "CLOSE_FAILED" });
      throw this.closeError;
    });
    return this.closing;
  }

  private update(change: Partial<BioTransportSnapshot>) {
    this.status = { ...this.status, ...change };
    for (const listener of this.listeners) listener(this.snapshot());
  }
}
