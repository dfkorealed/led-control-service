import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { BioClientEvent } from "./bio-dongle-client";

export const BIO_SENSOR_SHADOW_SCHEMA_VERSION = 1 as const;
export const BIO_SENSOR_SHADOW_APK_SHA256 = "1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e";

const BIO_SENSOR_SHADOW_CYCLES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const BIO_SENSOR_SHADOW_PHASES = [
  { kind: "baseline", cycle: 0, durationMs: 60_000 },
  ...BIO_SENSOR_SHADOW_CYCLES.flatMap((cycle) => [
    { kind: "stimulus" as const, cycle, durationMs: 8_000 },
    { kind: "recovery" as const, cycle, durationMs: 22_000 }
  ])
] as const;

export type BioSensorShadowPhase =
  | { kind: "baseline"; cycle: 0 }
  | { kind: "stimulus" | "recovery"; cycle: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 };

export interface BioSensorShadowSource {
  nativeUuid: string;
  logicalAddress: number;
  firmware: string;
  protocol: string;
}

export interface BioSensorShadowScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

type CaptureOptions = {
  evidenceRoot: string;
  captureName: string;
  source: BioSensorShadowSource;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  scheduler?: BioSensorShadowScheduler;
  onPhase?: (phase: BioSensorShadowPhase) => void;
  onComplete?: () => void;
  onFailure?: (error: unknown) => void;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

function requireInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError("Invalid BIO shadow numeric field");
  return value;
}

function requireToken(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._+-]{1,64}$/.test(value)) throw new RangeError("Invalid BIO shadow source token");
  return value;
}

function requireTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RangeError("Invalid BIO shadow clock");
  return value.toISOString();
}

function assertPlainJsonRecord(record: JsonRecord): void {
  if (Object.getPrototypeOf(record) !== Object.prototype) throw new TypeError("BIO shadow record must be a plain object");
  const check = (value: JsonValue): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("BIO shadow record contains a non-finite number");
      return;
    }
    if (Array.isArray(value)) { value.forEach(check); return; }
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("BIO shadow record contains a non-plain object");
    Object.values(value).forEach(check);
  };
  Object.values(record).forEach(check);
}

export class BioSensorShadowCapture {
  private readonly source: BioSensorShadowSource;
  private readonly sourceFingerprint: string;
  private readonly now: () => Date;
  private readonly scheduler: BioSensorShadowScheduler;
  private readonly onPhase?: (phase: BioSensorShadowPhase) => void;
  private readonly onComplete?: () => void;
  private readonly onFailure?: (error: unknown) => void;
  private pending: Promise<void> = Promise.resolve();
  private timer: unknown;
  private phaseIndex = 0;
  private stopped = false;
  private failure: unknown;
  private closePromise?: Promise<void>;

  private constructor(private readonly handle: FileHandle, options: CaptureOptions, fingerprint: string) {
    this.source = { ...options.source };
    this.sourceFingerprint = fingerprint;
    this.now = options.now ?? (() => new Date());
    this.scheduler = options.scheduler ?? { setTimeout, clearTimeout };
    this.onPhase = options.onPhase;
    this.onComplete = options.onComplete;
    this.onFailure = options.onFailure;
  }

  static async create(options: CaptureOptions): Promise<BioSensorShadowCapture> {
    if (!/^bio-sensor-shadow-[0-9]{8}T[0-9]{6}Z\.jsonl$/.test(options.captureName)) throw new RangeError("Invalid BIO shadow capture name");
    if (!/^[0-9a-f]{12}$/.test(options.source.nativeUuid)) throw new RangeError("Invalid BIO native UUID");
    requireInteger(options.source.logicalAddress, 1, 0x7fff);
    requireToken(options.source.firmware);
    requireToken(options.source.protocol);
    const root = await lstat(options.evidenceRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.geteuid?.() || (root.mode & 0o7777) !== 0o700) {
      throw new Error("BIO shadow evidence root must be a private, owned, real directory");
    }
    const key = (options.randomBytes ?? nodeRandomBytes)(32);
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new RangeError("Invalid BIO shadow HMAC key");
    // 이 키는 파일에 쓰지 않는다. UUID의 HMAC은 같은 캡처 안에서만 안정적이며 캡처 간 장치 식별자로 사용할 수 없다.
    const fingerprint = createHmac("sha256", key).update(options.source.nativeUuid).digest("hex");
    const handle = await open(join(options.evidenceRoot, options.captureName), "wx", 0o600);
    try {
      await handle.chmod(0o600);
      const capture = new BioSensorShadowCapture(handle, options, fingerprint);
      capture.enqueue({
        type: "capture-start",
        schemaVersion: BIO_SENSOR_SHADOW_SCHEMA_VERSION,
        apkSha256: BIO_SENSOR_SHADOW_APK_SHA256,
        timestamp: requireTimestamp(capture.now),
        source: { fingerprint, logicalAddress: options.source.logicalAddress, firmware: options.source.firmware, protocol: options.source.protocol }
      }, true);
      capture.enterPhase(0);
      await capture.pending;
      if (capture.failure !== undefined) throw capture.failure;
      return capture;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private fail(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.stopped = true;
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    // 증거 쓰기 실패는 이 캡처만 중단한다. 조명 제어 명령을 보내거나 기존 명령을 변경하는 경로가 아니다.
    try { this.onFailure?.(error); } catch { /* 관측 콜백 오류가 원래 쓰기 실패를 덮지 않는다. */ }
  }

  private enqueue(record: JsonRecord, durable = false): void {
    assertPlainJsonRecord(record);
    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending.then(async () => {
      if (this.failure !== undefined) return;
      await this.handle.writeFile(line, "utf8");
      if (durable) await this.handle.datasync();
    }).catch((error: unknown) => this.fail(error));
  }

  private enterPhase(index: number): void {
    if (this.stopped || this.failure !== undefined) return;
    const phase = BIO_SENSOR_SHADOW_PHASES[index];
    if (!phase) {
      this.stopped = true;
      this.enqueue({ type: "capture-complete", timestamp: requireTimestamp(this.now) }, true);
      this.pending = this.pending.then(() => { if (this.failure === undefined) this.onComplete?.(); }).catch((error: unknown) => this.fail(error));
      return;
    }
    this.phaseIndex = index;
    this.enqueue({ type: "phase", kind: phase.kind, cycle: phase.cycle, durationMs: phase.durationMs, timestamp: requireTimestamp(this.now) }, true);
    this.pending = this.pending.then(() => {
      if (this.failure === undefined && !this.closePromise) this.onPhase?.({ kind: phase.kind, cycle: phase.cycle } as BioSensorShadowPhase);
    }).catch((error: unknown) => this.fail(error));
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      this.enterPhase(this.phaseIndex + 1);
    }, phase.durationMs);
  }

  record(event: BioClientEvent): void {
    if (this.stopped || this.closePromise || this.failure !== undefined) return;
    if (event.kind !== "alive-status" && event.kind !== "sensor-status-candidate") return;
    // UUID와 현재 논리 주소를 모두 맞춰야 다른 장치의 관측을 섞지 않는다. 재할당/재연결을 고려한 운영 이벤트 식별자로는 아직 충분하지 않다.
    if (event.deviceUuid !== this.source.nativeUuid || event.logicalAddress !== this.source.logicalAddress) return;
    if (!Buffer.isBuffer(event.innerBody)) return;
    // 파서가 분리한 inner body만 허용한다. 전체 55aa 프레임과 UUID는 장치·현장 추적 정보를 담으므로 저장하지 않는다.
    const innerBodyHex = event.innerBody.toString("hex");
    if (innerBodyHex.includes(this.source.nativeUuid) || /^55aa[0-9a-f]{10,}$/i.test(innerBodyHex)) return;
    const opcode = event.kind === "alive-status" ? 0x0c : 0x09;
    if (event.innerOpcode !== opcode) return;
    try {
      const record: JsonRecord = {
        type: "observation",
        timestamp: requireTimestamp(this.now),
        classification: event.kind === "alive-status" ? "liveness" : "candidate",
        sourceFingerprint: this.sourceFingerprint,
        logicalAddress: this.source.logicalAddress,
        networkId: requireInteger(event.networkId, 0, 0xffff),
        destination: requireInteger(event.destination, 0, 0xffff),
        rssiDbm: requireInteger(event.rssiDbm, -128, 127),
        sequence: requireInteger(event.sequence, 0, 255),
        ttl: requireInteger(event.ttl, 0, 127),
        control: event.control === true,
        innerOpcode: opcode,
        innerBodyHex
      };
      this.enqueue(record);
    } catch (error) { this.fail(error); }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.closePromise = this.pending.then(async () => {
      try { if (this.failure === undefined) await this.handle.datasync(); }
      catch (error) { this.fail(error); }
      finally { await this.handle.close(); }
      if (this.failure !== undefined) throw this.failure;
    });
    return this.closePromise;
  }
}
