import type { BioByteConnection } from "./bio-byte-connection";
import { BioFrameCodec, encodeCrcFrame, encodeGsFrame, type BioFrame, type BioProtocol } from "./bio-frame-codec";
import { BioUsbError, type BioUsbErrorCode } from "./bio-usb-error";
import { assertCommandWriteAllowed, type CommandWriteControl } from "../commands/command-rf-drain";

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
  /** [확인됨] Android 1.2.0은 converter-info startup과 ACK/notification 채널을 분리한다. */
  profile?: "legacy" | "android-v1.2.0";
  protocol?: BioProtocol | "auto";
  timeoutMs?: number;
  /** [확인됨] native descriptor 폐기는 이 상한 안에서 성공 또는 영구 write 차단으로 판정한다. */
  retirementTimeoutMs?: number;
  connectionFactory: () => BioByteConnection;
  /** The adapter must validate its durable mapping before enabling requests. */
  validateReadiness: (probe: BioFrame) => Promise<void>;
}
/** [미확인] 임의 opcode 의미는 제조사 문서가 없으므로, 상위 계층은 캡처된 요청만 전달해야 한다. */
export interface BioUsbRequest {
  command: number;
  payload: Uint8Array;
}
export interface BioUsbOperationControl extends Partial<CommandWriteControl> {
  signal?: AbortSignal;
  deadlineAt?: number;
  /** [확인됨] callback은 queue 진입이 아니라 native connection.write 호출 직전에 한 번 실행된다. */
  onWriteStarted?: () => void;
}
interface PendingRequest {
  command: number;
  bytes: Buffer;
  resolve: (frame: BioFrame) => void;
  reject: (error: unknown) => void;
  control?: BioUsbOperationControl;
  controlTimeout?: ReturnType<typeof setTimeout>;
  cancelForControl?: () => void;
  settled?: boolean;
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
  private startup?: { infoSeen: boolean; literalsComplete: boolean; resolve: () => void; reject: (error: BioUsbError) => void };
  private timeout?: ReturnType<typeof setTimeout>;
  private partialTimeout?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private writing = false;
  private reconnectDelay = 2000;
  private nextProtocol: BioProtocol;
  private closing: Promise<void> = Promise.resolve();
  private closeError?: BioUsbError;
  private readonly retirementTimeoutMs: number;
  private attempt?: { promise: Promise<void>; resolve: () => void; reject: (error: BioUsbError) => void };

  constructor(private readonly options: BioTransportOptions) {
    const timeout = options.timeoutMs ?? 300;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new RangeError("Invalid BIO response timeout");
    this.retirementTimeoutMs = options.retirementTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.retirementTimeoutMs) || this.retirementTimeoutMs < 1 || this.retirementTimeoutMs > 2147483647) {
      throw new RangeError("Invalid BIO retirement timeout");
    }
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

  async request(request: BioUsbRequest, control: BioUsbOperationControl = {}): Promise<BioFrame> {
    throwIfOperationStopped(control);
    if (!this.status.ready) throw new BioUsbError("NOT_READY", "BIO transport is not ready");
    if (request.command === 0xff) throw new RangeError("BIO command has no one-byte successor response");
    const bytes = this.status.protocol === "crc16" ? encodeCrcFrame(request.command, request.payload) : encodeGsFrame(request.command, request.payload);
    return new Promise<BioFrame>((resolve, reject) => {
      const pending: PendingRequest = { command: request.command, bytes, resolve, reject, control };
      pending.cancelForControl = () => this.cancelPendingRequest(pending);
      control.signal?.addEventListener("abort", pending.cancelForControl, { once: true });
      if (control.deadlineAt !== undefined) {
        pending.controlTimeout = setTimeout(
          pending.cancelForControl,
          Math.min(2_147_483_647, Math.max(0, control.deadlineAt - Date.now()))
        );
      }
      this.queue.push(pending);
      // Abort can race the first check and listener installation. The second check removes
      // the queued owner synchronously, before any later pump can reach connection.write().
      if (operationStopped(control)) pending.cancelForControl();
      // A notification listener can enqueue reentrantly while receive() still
      // owns other frames from the same chunk. Inspect those before writing.
      if (this.options.profile === "android-v1.2.0") void Promise.resolve().then(() => this.pump());
      else this.pump();
    });
  }

  async retireCancelledOperation(): Promise<void> {
    if (this.status.ready) {
      // [확인됨] scan start ACK 뒤 caller가 취소되면 STOP write도 만료 후 새 write가 된다.
      // 또한 accepted GET 뒤 matching report가 없으면 transaction ID가 없어 늦은 report를
      // 다음 GET과 구분할 수 없다. 두 경우 모두 descriptor 세대를 폐기해 다음 요청이 같은
      // byte stream을 소유하지 못하게 하고, reconnect probe로만 새 소유권을 연다.
      this.fail(this.status.generation, new BioUsbError("STOPPED", "BIO operation cancelled after a physical write"));
    }
    await this.closing;
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
    // [확인됨] native open 중에도 03이 올 수 있으므로 먼저 수신 소유권을 건다. APK/HIL은
    // 두 82 literal 뒤의 유효 03을 준비 완료로 사용했다. 82 자체의 제조사 명칭/필드 의미는
    // [미확인]이며, zero trailer literal을 일반 checksum 응답이나 83 ACK로 해석하지 않는다.
    const startup = traced ? new Promise<void>((resolve, reject) => {
      this.startup = { infoSeen: false, literalsComplete: false, resolve, reject };
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
      if (!this.current(generation)) return;
      if (this.startup) this.startup.literalsComplete = true;
      this.advanceStartup(generation);
      if (!this.current(generation)) return;
      await startup;
      if (!this.current(generation)) return;
      // [확인됨] 원래 converter-info deadline은 두 native write와 startup 알림 drain 전체를
      // 감싼다. 반복 알림이 이 시간을 연장하지 않으며, 이후 GET_NWK는 별도 deadline을 갖는다.
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    // [확인됨] APK의 82 probe 두 개는 checksum이 아닌 zero trailer를 가진 고정 literal이다.
    // 일반 encoder/decoder를 예외 처리해 만들면 응답 검증까지 약해지므로 byte를 그대로 유지한다.
    // [확인됨] 설치 앱은 GET_NWK 0A 요청과 CRC16 0B 응답을 썼다. 82는 startup literal의
    // command byte일 뿐 모든 dongle이 83을 반환한다는 근거가 아니다.
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
    if (request.control && operationStopped(request.control)) {
      this.rejectRequest(request, abortError());
      this.pump();
      return;
    }
    if (this.codec.hasPendingFrame()) {
      this.fail(this.status.generation, new BioUsbError(
        "LATE_RESPONSE",
        "BIO response candidate started before request ownership"
      ));
      return;
    }
    const generation = this.status.generation;
    try {
      assertCommandWriteAllowed(request.control);
    } catch (error) {
      this.rejectRequest(request, error);
      this.pump();
      return;
    }
    this.active = request;
    this.writing = true;
    this.armResponseTimeout();
    request.control?.onWriteStarted?.();
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
    const events = this.codec.push(bytes);
    for (const [index, event] of events.entries()) {
      if (!this.current(generation)) break;
      if (event.type === "malformed") {
        const recoveredStartupInfo = event.reason === "checksum"
          && this.options.profile === "android-v1.2.0"
          && this.startup !== undefined
          && this.active === undefined
          && events.slice(index + 1).some((candidate) => candidate.type === "frame" && candidate.frame.command === 0x03);
        // [추정] converter startup이 진행 중인 12를 끊을 수 있다. 같은 batch 뒤에서 checksum이
        // 유효한 03을 실제로 복구한 경우만 그 checksum 오류를 건너뛴다. request-owned/length/
        // 단독 malformed는 제조사 의미가 [미확인]이므로 계속 fail-closed다.
        if (recoveredStartupInfo) continue;
        this.fail(generation, new BioUsbError("MALFORMED_FRAME", "Malformed BIO frame"));
        break;
      }
      if (this.options.profile === "android-v1.2.0" && (event.frame.command === 0x03 || (event.frame.protocol === "crc16" && event.frame.command === 0x12))) {
        // [확인됨] 03 converter-info는 CRC16/GS 양쪽 캡처가 있고 12는 CRC16 비동기 RX다.
        // 03을 봤다는 사실만 기록하고, 같은 stream의 허용된 partial 후보가 끝나기 전에는
        // GET_NWK 소유권을 주지 않는다. 12나 무관한 ACK는 준비 완료를 만들지 못한다.
        if (event.frame.command === 0x03 && this.startup) this.startup.infoSeen = true;
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
      this.resolveRequest(completed, event.frame);
    }
    this.advanceStartup(generation);
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
      if (this.startup) return;
      // [확인됨] idle 상태의 분할 03/12 알림은 정상 캡처에 존재한다. 완전한 header/frame이
      // 소유권을 확정할 때까지 다음 요청을 막고, 지연 ACK는 새 요청이 소비하지 못하게 한다.
      // startup 이후의 멈춘 partial도 timeout으로 제한한다.
      this.partialTimeout ??= setTimeout(() => this.fail(generation, new BioUsbError("TIMEOUT", "BIO partial notification timed out")), this.options.timeoutMs ?? 300);
    }
    // Finish inspecting complete and partial candidates before another request
    // becomes eligible to own bytes from this connection.
    void Promise.resolve().then(() => { if (this.current(generation)) this.pump(); });
  }

  private advanceStartup(generation: number): void {
    if (!this.current(generation) || !this.startup) return;
    // [확인됨] APK 호환 순서상 두 literal은 하나의 고정 startup 단계다. open 중 먼저 온
    // partial 후보도 literal 전송을 생략시키지 않으며, 둘 다 완료된 뒤에만 분류한다.
    if (!this.startup.literalsComplete) return;
    const pending = this.codec.pendingCandidate();
    // [확인됨] startup 중 실제로 관찰된 drain 대상은 CRC16 12와 CRC16/GS 03뿐이다.
    // [추정] 0B/기타 command 후보는 이전 응답일 수 있으므로 즉시 LATE_RESPONSE로 닫고,
    // command조차 아직 없는 split header만 원래 startup deadline 안에서 더 기다린다.
    // 별도 quiet sleep을 두지 않아 USB timing 추측이 요청 소유권 규칙이 되지 않게 한다.
    const allowedStartupCandidate = pending?.command === undefined
      || pending.command === 0x03
      || (pending.protocol === "crc16" && pending.command === 0x12);
    if (pending && !allowedStartupCandidate) {
      this.fail(generation, new BioUsbError("LATE_RESPONSE", "Unexpected BIO response candidate during converter startup"));
      return;
    }
    // [확인됨] GET_NWK 소유권은 (1) checksum-valid 03 수신, (2) 두 fixed literal의
    // native write 완료, (3) codec pending 후보 없음이 모두 참일 때만 열린다. 어느 조건을
    // 기다리더라도 최초 converter-info deadline은 그대로이며 새 timer를 만들지 않는다.
    if (!pending && this.startup.infoSeen && this.startup.literalsComplete) {
      const completed = this.startup;
      this.startup = undefined;
      completed.resolve();
    }
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
    if (this.active) this.rejectRequest(this.active, error);
    this.active = undefined;
    for (const pending of this.queue.splice(0)) this.rejectRequest(pending, error);
    this.attempt?.reject(error);
    this.attempt = undefined;
    this.writing = false;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    const connection = this.connection;
    const nativeClose = this.closing.then(async () => {
      await connection?.close();
      // Retain ownership until native close confirms the descriptor was closed.
      if (this.connection === connection) this.connection = undefined;
    });
    // [확인됨] active request cancellation 뒤 descriptor close를 무기한 기다리면 CLI의
    // sensor 복귀/temporary cleanup까지 도달하지 못한다. timeout은 native close를 성공으로
    // 간주하지 않는다. transport를 영구 중지하고 reconnect/write 권한을 닫은 뒤
    // CLOSE_FAILED로 소유권 불확실성을 보존한다. [미확인] libusb stopInput/release/reattach 중
    // 어디에서 멈췄는지는 backend가 완료를 알리지 않으므로 USB release나 kernel-driver
    // 재부착을 추정하지 않는다. 남은 native promise는 write 경로와 분리되어 정리만 가능하다.
    this.closing = boundedRetirement(nativeClose, this.retirementTimeoutMs).catch((cause: unknown) => {
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

  private cancelPendingRequest(request: PendingRequest) {
    if (request.settled) return;
    const queuedIndex = this.queue.indexOf(request);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.rejectRequest(request, abortError());
      this.pump();
      return;
    }
    if (this.active === request) {
      // [확인됨] 이미 connection.write를 호출한 request의 늦은 ACK는 취소 뒤 다음 request와
      // 구분할 transaction ID가 없다. caller는 즉시 AbortError를 받고, stream은 close/reconnect로
      // 세대 폐기해 late ACK가 다음 owner를 만족시키지 못하게 한다.
      this.rejectRequest(request, abortError());
      this.fail(this.status.generation, new BioUsbError("STOPPED", "BIO active request cancelled"));
      return;
    }
    this.rejectRequest(request, abortError());
  }

  private resolveRequest(request: PendingRequest, frame: BioFrame) {
    if (request.settled) return;
    request.settled = true;
    this.cleanupRequestControl(request);
    request.resolve(frame);
  }

  private rejectRequest(request: PendingRequest, error: unknown) {
    if (request.settled) return;
    request.settled = true;
    this.cleanupRequestControl(request);
    request.reject(error);
  }

  private cleanupRequestControl(request: PendingRequest) {
    if (request.controlTimeout) clearTimeout(request.controlTimeout);
    request.controlTimeout = undefined;
    if (request.cancelForControl) request.control?.signal?.removeEventListener("abort", request.cancelForControl);
    request.cancelForControl = undefined;
  }

  private update(change: Partial<BioTransportSnapshot>) {
    this.status = { ...this.status, ...change };
    for (const listener of this.listeners) listener(this.snapshot());
  }
}

function operationStopped(control: BioUsbOperationControl) {
  return Boolean(control.signal?.aborted ||
    (control.deadlineAt !== undefined && Date.now() >= control.deadlineAt));
}

function throwIfOperationStopped(control: BioUsbOperationControl) {
  if (operationStopped(control)) throw abortError();
}

function abortError() {
  return new DOMException("BIO operation cancelled or expired", "AbortError");
}

function boundedRetirement(retirement: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    retirement,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("BIO native connection retirement timed out")), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
