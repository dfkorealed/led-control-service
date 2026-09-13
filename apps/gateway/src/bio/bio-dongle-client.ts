import { randomInt } from "node:crypto";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import { bioRawToPercent, percentToBioRaw } from "./bio-brightness-table";
import { BioUsbTransport, type BioTransportOptions } from "./bio-usb-transport";
import { BioDirectUsbConnection } from "./bio-direct-usb-connection";
import {
  decodeBioResponse,
  encodeBioCommand,
  type BioControlMode,
  type BioLampTarget,
  type BioOperation,
  type BioResponse
} from "./bio-command-codec";
import { formatBioDeviceUuid, parseBioDeviceUuid } from "./bio-device-identity";
import { BioUsbError } from "./bio-usb-error";

export type BioClientEvent = Exclude<BioResponse, { kind: "probe" | "outer-ack" }> | { kind: "invalid-notification" };
export type BioDongleClientOptions = Pick<BioTransportOptions, "timeoutMs"> & {
  connectionFactory?: BioTransportOptions["connectionFactory"];
  initialSequence?: number;
  scanDurationMs?: number;
  observationTimeoutMs?: number;
  reconnectReadyTimeoutMs?: number;
};
export interface BioOperationControl {
  signal?: AbortSignal;
  deadlineAt?: number;
}
export interface BioCommandAcceptance { outcome: "dongle-accepted"; deviceApplied: false }
export interface BioDiscoveredDevice {
  nativeUuid: string;
  deviceUuid: string;
  logicalAddress: number;
  networkId: number;
  firmwareVersion: string;
  rssi: number;
}
export type BioAddressAssignmentResult =
  | { outcome: "confirmed"; device: BioDiscoveredDevice }
  | { outcome: "unchanged"; device: BioDiscoveredDevice }
  | { outcome: "unknown"; code: "BIO_ADDRESS_STATE_UNKNOWN" };
export type BioVerifiedLampTarget = Extract<BioLampTarget, { kind: "unicast" }> & { nativeUuid: string };

type ReadbackEvent = Extract<BioResponse, { kind: "high-brightness-report" | "control-mode-report" }>;
type BioReadbackOperation = Extract<BioOperation,
  { kind: "readHighBrightness" | "readControlMode" | "setControlMode" }>;

/**
 * BIO direct-USB 상위 lifecycle client.
 *
 * - [확인됨] 외부 0x11 status 0은 동글의 TX 수락일 뿐이며 `deviceApplied`는 항상 false다.
 *   주소는 UUID/old/new scan 증거, 제어는 동일 UUID/address의 0x12 read-back으로만 확정한다.
 * - [확인됨] scan cache는 한 scan window에서 UUID별 마지막 report의 address/RSSI를 보관하고,
 *   deadline 종료·오류 모두 finally에서 stop ACK까지 확인한 경우에만 현재 cache로 교체한다.
 * - [확인됨] 설치 APK의 address/brightness/getter serializer와 exact brightness table을 쓴다.
 *   [미확인] 이 정적 계약의 실제 firmware 적용은 Task 9 단일 장치 HIL 전까지 미확인이다.
 */
export class BioDongleClient {
  private readonly transport: BioUsbTransport;
  private readonly listeners = new Set<(event: BioClientEvent) => void>();
  private readonly scanDurationMs: number;
  private readonly observationTimeoutMs: number;
  private readonly reconnectReadyTimeoutMs: number;
  private readonly operationQueue = new SerialTaskQueue();
  private readonly identifySessions = new Map<string, { controller: AbortController; promise: Promise<BioDiscoveredDevice> }>();
  private sequence: number;
  private probeResult?: Extract<BioResponse, { kind: "probe" }>;
  private activeScan?: Map<string, BioDiscoveredDevice>;
  private activeScanObservations?: BioDiscoveredDevice[];
  private lastScanObservations: BioDiscoveredDevice[] = [];
  private scanCache = new Map<string, BioDiscoveredDevice>();

  constructor(options: BioDongleClientOptions) {
    this.sequence = options.initialSequence ?? randomInt(10, 100);
    if (!Number.isInteger(this.sequence) || this.sequence < 0 || this.sequence > 255) throw new RangeError("Invalid BIO initial sequence");
    this.scanDurationMs = positiveDuration(options.scanDurationMs ?? 5000, "scan duration");
    this.observationTimeoutMs = positiveDuration(options.observationTimeoutMs ?? options.timeoutMs ?? 300, "observation timeout");
    this.reconnectReadyTimeoutMs = positiveDuration(options.reconnectReadyTimeoutMs ?? 35000, "reconnect ready timeout");
    this.transport = new BioUsbTransport({
      timeoutMs: options.timeoutMs,
      connectionFactory: options.connectionFactory ?? (() => new BioDirectUsbConnection()),
      profile: "android-v1.2.0", protocol: "crc16",
      validateReadiness: async (frame) => {
        const parsed = decodeBioResponse(frame);
        if (parsed.kind !== "probe") throw new BioUsbError("READINESS", "BIO traced probe was not validated");
        this.probeResult = parsed;
      }
    });
    this.transport.onNotification((frame) => {
      let event: BioClientEvent;
      try {
        const parsed = decodeBioResponse(frame);
        if (parsed.kind === "probe" || parsed.kind === "outer-ack") return;
        event = parsed;
        if (parsed.kind === "discovery" && this.activeScan) {
          // [확인됨] 같은 UUID의 더 늦은 report가 현 scan window의 address/RSSI를 대체한다.
          const discovered = toDiscoveredDevice(parsed);
          this.activeScan.set(parsed.deviceUuid, discovered);
          this.activeScanObservations?.push(discovered);
        }
      } catch {
        // [추정] 손상된 비동기 0x12는 ACK 요청과 다른 소유권이다. device state로 만들지
        // 않되 무관한 request를 성공시키지도 않고 redacted invalid event로 격리한다.
        event = { kind: "invalid-notification" };
      }
      for (const listener of this.listeners) listener(event);
    });
  }

  /** [확인됨] 세대별 USB/GET_NWK만 검증하며 fixture의 durable mapping 확인을 대신하지 않는다. */
  async probe(): Promise<Extract<BioResponse, { kind: "probe" }>> {
    await this.transport.start();
    if (!this.probeResult) throw new BioUsbError("READINESS", "BIO traced probe was not validated");
    return { ...this.probeResult };
  }

  async close(): Promise<void> {
    for (const session of this.identifySessions.values()) session.controller.abort();
    await Promise.allSettled([...this.identifySessions.values()].map((session) => session.promise));
    await this.transport.stop();
  }

  /**
   * [확인됨] scan 성공은 start ACK만이 아니라 fixed deadline 뒤 finally의 stop ACK까지 필요하다.
   * stop ACK가 없으면 수집 목록을 cache/성공으로 공개하지 않아 동글의 scan 상태를 추정하지 않는다.
   */
  async scan(control: BioOperationControl = {}): Promise<BioDiscoveredDevice[]> {
    throwIfOperationStopped(control);
    if (this.activeScan) throw new Error("BIO scan is already active");
    const collected = new Map<string, BioDiscoveredDevice>();
    const observations: BioDiscoveredDevice[] = [];
    this.activeScan = collected;
    this.activeScanObservations = observations;
    let failure: unknown;
    try {
      await this.send({ kind: "scan" }, control);
      await controlledDelay(this.scanDurationMs, control);
    } catch (error) {
      failure = error;
    } finally {
      try {
        // [확인됨] expiry 뒤 새 physical write를 금지한다. scan stop도 새 write이므로
        // 취소된 caller 대신 보내지 않으며, transport lifecycle 복구는 Task 8 범위에 남긴다.
        if (!operationStopped(control)) await this.stopScan(control);
      } catch (stopError) {
        // stop ACK는 성공 list의 필수 gate다. start/window 오류가 이미 있어도 불확실한
        // dongle scan lifecycle을 더 구체적인 stop 실패로 덮어 fail-closed한다.
        failure = stopError;
      }
      this.activeScan = undefined;
      this.activeScanObservations = undefined;
    }
    if (failure !== undefined) throw failure;
    throwIfOperationStopped(control);
    const devices = [...collected.values()].map((device) => ({ ...device }));
    this.lastScanObservations = observations.map((device) => ({ ...device }));
    this.scanCache = new Map(devices.map((device) => [device.deviceUuid, device]));
    return devices;
  }

  async stopScan(control: BioOperationControl = {}): Promise<BioCommandAcceptance> {
    return this.send({ kind: "stopScan" }, control);
  }

  /** APK-table-backed raw setter. It still returns only dongle acceptance, never application. */
  async setBrightness(target: BioLampTarget, value: { rawHighBrightness: number }, control: BioOperationControl = {}): Promise<BioCommandAcceptance> {
    return this.send({ kind: "setHighBrightness", target, rawHighBrightness: value.rawHighBrightness }, control);
  }

  async setControlMode(target: BioLampTarget, mode: BioControlMode, control: BioOperationControl = {}): Promise<BioCommandAcceptance> {
    return this.send({ kind: "setControlMode", target, mode }, control);
  }

  /**
   * [확인됨] 현재 성공 scan cache의 UUID/address만 2초 force-on 대상으로 삼고 항상 sensor
   * restore를 최종 시도한다. cancel/timeout/throw도 이 finally 성격을 우회하지 않는다.
   * 동일 UUID/address의 sensor report가 없으면 ACK가 있어도 복귀 미확정이다.
   */
  async startIdentify(nativeId: string, control: BioOperationControl = {}): Promise<BioDiscoveredDevice> {
    const device = this.resolveCachedDevice(nativeId);
    if (this.identifySessions.has(device.nativeUuid)) throw new Error("BIO identify is already active");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (control.signal?.aborted) controller.abort();
    else control.signal?.addEventListener("abort", forwardAbort, { once: true });
    const promise = this.runIdentify(device, { ...control, signal: controller.signal });
    this.identifySessions.set(device.nativeUuid, { controller, promise });
    try {
      return await promise;
    } finally {
      control.signal?.removeEventListener("abort", forwardAbort);
      this.identifySessions.delete(device.nativeUuid);
    }
  }

  async stopIdentify(nativeId: string): Promise<void> {
    const device = this.resolveCachedDevice(nativeId);
    const session = this.identifySessions.get(device.nativeUuid);
    if (!session) {
      await this.restoreSensorMode(device);
      return;
    }
    session.controller.abort();
    try {
      await session.promise;
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }
  }

  /**
   * [확인됨] address ACK 성공/유실은 hardware 판정에 사용하지 않는다. 첫 write 뒤 항상
   * old/new scan을 먼저 수행하고, old-only가 확인된 경우에만 같은 command를 한 번 더 보낸다.
   * [미확인] Task 9 HIL 전까지 APK address serializer의 실장비 적용은 확인되지 않았다.
   */
  async assignAddress(nativeId: string, logicalAddress: number, control: BioOperationControl = {}): Promise<BioAddressAssignmentResult> {
    throwIfOperationStopped(control);
    validateLogicalAddress(logicalAddress);
    const device = this.resolveCachedDevice(nativeId);
    const operation: BioOperation = {
      kind: "assignAddress",
      target: { kind: "unicast", networkId: device.networkId, logicalAddress: device.logicalAddress },
      nativeUuid: device.nativeUuid,
      logicalAddress
    };
    await this.sendUncertainWrite(operation, control);
    let result = await this.reconcileAddress(device.nativeUuid, device.logicalAddress, logicalAddress, control);
    if (result.outcome !== "unchanged") return result;

    throwIfOperationStopped(control);
    await this.sendUncertainWrite(operation, control);
    result = await this.reconcileAddress(device.nativeUuid, device.logicalAddress, logicalAddress, control);
    return result;
  }

  async reconcileAddress(nativeId: string, oldAddress: number, newAddress: number, control: BioOperationControl = {}): Promise<BioAddressAssignmentResult> {
    throwIfOperationStopped(control);
    const nativeUuid = normalizeNativeUuid(nativeId);
    validateLogicalAddress(oldAddress);
    validateLogicalAddress(newAddress);
    await this.waitUntilReadyIfReconnecting(control);
    await this.scan(control);
    throwIfOperationStopped(control);
    const devices = this.lastScanObservations;
    const conflict = devices.find((device) => device.logicalAddress === newAddress && device.nativeUuid !== nativeUuid);
    if (conflict) throw new BioUsbError("BIO_ADDRESS_CONFLICT", "Requested BIO address is occupied by another UUID");
    const oldDevice = devices.find((device) => device.nativeUuid === nativeUuid && device.logicalAddress === oldAddress);
    const newDevice = devices.find((device) => device.nativeUuid === nativeUuid && device.logicalAddress === newAddress);
    if (newDevice && !oldDevice) return { outcome: "confirmed", device: { ...newDevice } };
    if (oldDevice && !newDevice) return { outcome: "unchanged", device: { ...oldDevice } };
    return { outcome: "unknown", code: "BIO_ADDRESS_STATE_UNKNOWN" };
  }

  async readBrightness(target: BioLampTarget | BioVerifiedLampTarget, control: BioOperationControl = {}) {
    const expected = this.resolveReadbackTarget(target);
    const report = await this.requestReadback({ kind: "readHighBrightness", target: expected.target }, expected, control);
    if (report.kind !== "high-brightness-report") {
      throw new BioUsbError("MALFORMED_FRAME", "BIO high-brightness report was not returned");
    }
    return report;
  }

  async readDeviceInfo(target: BioLampTarget | BioVerifiedLampTarget, control: BioOperationControl = {}) {
    const expected = this.resolveReadbackTarget(target);
    const report = await this.requestReadback({ kind: "readControlMode", target: expected.target }, expected, control);
    if (report.kind !== "control-mode-report") {
      throw new BioUsbError("MALFORMED_FRAME", "BIO control-mode report was not returned");
    }
    return report;
  }

  /**
   * [확인됨] 1..100은 APK exact table raw → force-on → high read → mode read 순서이며
   * 두 read-back이 모두 일치해야 applied 결과를 만든다. 0은 force-off와 mode read만 한다.
   * [미확인] 정적 APK 근거의 실제 밝기 적용은 Task 9 HIL에서 별도로 검증해야 한다.
   */
  async setOutput(target: BioVerifiedLampTarget, brightnessPercent: number, control: BioOperationControl = {}) {
    throwIfOperationStopped(control);
    const rawHighBrightness = percentToBioRaw(brightnessPercent);
    const expected = this.resolveReadbackTarget(target);
    if (brightnessPercent === 0) {
      await this.setControlMode(expected.target, "force-off", control);
      throwIfOperationStopped(control);
      const mode = await this.readDeviceInfo(target, control);
      throwIfOperationStopped(control);
      if (mode.mode !== "force-off") {
        throw Object.assign(
          new BioUsbError("BIO_CONTROL_MODE_STATE_MISMATCH", "BIO force-off read-back did not match"),
          { observedMode: mode.mode }
        );
      }
      return { brightnessPercent: 0, powerOn: false, mode: "force-off" as const };
    }

    await this.setBrightness(expected.target, { rawHighBrightness }, control);
    throwIfOperationStopped(control);
    await this.setControlMode(expected.target, "force-on", control);
    throwIfOperationStopped(control);
    const brightness = await this.readBrightness(target, control);
    throwIfOperationStopped(control);
    if (brightness.rawHighBrightness !== rawHighBrightness) {
      throw Object.assign(
        new BioUsbError("BIO_BRIGHTNESS_STATE_MISMATCH", "BIO high-brightness read-back did not match"),
        {
          observedRawHighBrightness: brightness.rawHighBrightness,
          observedBrightnessPercent: bioRawToPercent(brightness.rawHighBrightness)
        }
      );
    }
    const observedBrightnessPercent = bioRawToPercent(brightness.rawHighBrightness);
    const mode = await this.readDeviceInfo(target, control);
    throwIfOperationStopped(control);
    if (mode.mode !== "force-on") {
      throw Object.assign(
        new BioUsbError("BIO_CONTROL_MODE_STATE_MISMATCH", "BIO force-on read-back did not match"),
        {
          observedRawHighBrightness: brightness.rawHighBrightness,
          observedBrightnessPercent,
          observedMode: mode.mode
        }
      );
    }
    return { brightnessPercent: observedBrightnessPercent!, powerOn: true, rawHighBrightness, mode: "force-on" as const };
  }

  onEvent(listener: (event: BioClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private async runIdentify(device: BioDiscoveredDevice, control: BioOperationControl): Promise<BioDiscoveredDevice> {
    let primaryFailure: unknown;
    try {
      await this.setControlMode(toTarget(device), "force-on", control);
      await controlledDelay(2000, control);
    } catch (error) {
      primaryFailure = error;
    }
    try {
      // [확인됨] identify가 force-on을 시작했거나 queue에서 취소됐더라도 sensor 복귀는
      // 안전 상태를 위한 유일한 post-expiry physical write 예외다. 이 restore 자체는 새
      // caller deadline을 상속하지 않으며 UUID/address mode report까지 best-effort로 확인한다.
      await this.restoreSensorMode(device);
    } catch (cause) {
      throw new BioUsbError(
        "BIO_IDENTIFY_RESTORE_UNCONFIRMED",
        "BIO identify sensor-mode restoration was not confirmed",
        { cause }
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    return { ...device };
  }

  private async restoreSensorMode(device: BioDiscoveredDevice): Promise<void> {
    await this.waitUntilReadyIfReconnecting();
    const expected = { nativeUuid: device.nativeUuid, logicalAddress: device.logicalAddress, target: toTarget(device) };
    const report = await this.requestReadback({ kind: "setControlMode", target: expected.target, mode: "sensor" }, expected);
    if (report.kind !== "control-mode-report" || report.mode !== "sensor") {
      throw new BioUsbError("BIO_CONTROL_MODE_STATE_MISMATCH", "BIO sensor-mode read-back did not match");
    }
  }

  private requestReadback(
    operation: BioReadbackOperation,
    expected: { nativeUuid: string; logicalAddress: number },
    control: BioOperationControl = {}
  ): Promise<ReadbackEvent> {
    return this.operationQueue.run(() => {
      throwIfOperationStopped(control);
      return this.requestReadbackOwned(operation, expected, control);
    });
  }

  private async requestReadbackOwned(
    operation: BioReadbackOperation,
    expected: { nativeUuid: string; logicalAddress: number },
    control: BioOperationControl = {}
  ): Promise<ReadbackEvent> {
    throwIfOperationStopped(control);
    const expectedKind = operation.kind === "readHighBrightness"
      ? "high-brightness-report"
      : "control-mode-report";
    const waiting = this.waitForReadback(expected, expectedKind, control);
    try {
      // [확인됨] 캡처상 장치 0x12가 동글 outer 0x11보다 먼저 올 수 있으므로 listener를
      // wire write 전에 등록한다. waiter result에는 이 시점부터 rejection handler가 붙어 있다.
      await this.sendDirect(operation, control);
      const observed = await waiting.result;
      if (!observed.ok) throw observed.error;
      throwIfOperationStopped(control);
      return observed.value;
    } catch (error) {
      waiting.cancel();
      throw error;
    }
  }

  private waitForReadback(
    expected: { nativeUuid: string; logicalAddress: number },
    expectedKind: ReadbackEvent["kind"],
    control: BioOperationControl = {}
  ) {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait!: (error: unknown) => void;
    let settled = false;
    const cancelForControl = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectWait(abortError());
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      control.signal?.removeEventListener("abort", cancelForControl);
      unsubscribe();
    };
    const promise = new Promise<ReadbackEvent>((resolve, reject) => {
      rejectWait = reject;
      unsubscribe = this.onEvent((event) => {
        if (event.kind !== expectedKind
          || event.deviceUuid !== `bio:${expected.nativeUuid}`
          || event.logicalAddress !== expected.logicalAddress) return;
        settled = true;
        cleanup();
        resolve(event);
      });
      control.signal?.addEventListener("abort", cancelForControl, { once: true });
      const remaining = remainingOperationMs(control);
      timer = setTimeout(() => {
        settled = true;
        cleanup();
        reject(operationStopped(control)
          ? abortError()
          : new BioUsbError("TIMEOUT", "BIO matching device read-back timed out"));
      }, Math.min(this.observationTimeoutMs, remaining));
      if (operationStopped(control)) cancelForControl();
    });
    // [확인됨] native report에는 request transaction ID가 없다. UUID/address/DPID만으로
    // correlation하므로 global operation queue가 command write부터 matching report까지를
    // 독점한다. per-target 병렬화는 address 변경/지연 DPID를 안전하게 구분할 근거가 없다.
    // [추정] ACK보다 짧은 observation timeout도 가능하므로 raw rejection을 즉시 outcome으로
    // 변환해 process unhandledRejection을 막고, caller에는 하나의 통제된 실패만 전달한다.
    const result = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    return {
      result,
      cancel: () => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectWait(new BioUsbError("STOPPED", "BIO read-back wait was cancelled"));
      }
    };
  }

  private resolveCachedDevice(nativeId: string) {
    const nativeUuid = normalizeNativeUuid(nativeId);
    const device = this.scanCache.get(`bio:${nativeUuid}`);
    if (!device) throw new BioUsbError("BIO_DEVICE_NOT_FOUND", "BIO UUID is absent from the current scan cache");
    return { ...device };
  }

  private resolveReadbackTarget(target: BioLampTarget | BioVerifiedLampTarget) {
    if (target.kind !== "unicast") {
      throw new BioUsbError("BIO_DEVICE_NOT_FOUND", "BIO read-back requires one unicast device identity");
    }
    const suppliedUuid = "nativeUuid" in target && typeof target.nativeUuid === "string"
      ? normalizeNativeUuid(target.nativeUuid)
      : undefined;
    const cached = [...this.scanCache.values()].find((device) =>
      device.logicalAddress === target.logicalAddress && device.networkId === target.networkId
    );
    const nativeUuid = suppliedUuid ?? cached?.nativeUuid;
    if (!nativeUuid) throw new BioUsbError("BIO_DEVICE_NOT_FOUND", "BIO read-back UUID is unavailable");
    return {
      nativeUuid,
      logicalAddress: target.logicalAddress,
      target: { kind: "unicast", networkId: target.networkId, logicalAddress: target.logicalAddress } as const
    };
  }

  private async sendUncertainWrite(operation: BioOperation, control: BioOperationControl = {}): Promise<void> {
    try {
      await this.send(operation, control);
    } catch {
      throwIfOperationStopped(control);
      // [확인됨] ACK는 device state가 아니다. ACK 유실/거부/transport timeout 뒤에도
      // write를 즉시 반복하지 않고 reconnect readiness 뒤 scan evidence로만 판정한다.
    }
    await this.waitUntilReadyIfReconnecting(control);
    throwIfOperationStopped(control);
  }

  private async waitUntilReadyIfReconnecting(control: BioOperationControl = {}): Promise<void> {
    throwIfOperationStopped(control);
    const snapshot = this.transport.snapshot();
    if (snapshot.ready) return;
    if (snapshot.state === "stopped" || snapshot.state === "close-failed") {
      throw new BioUsbError("NOT_READY", "BIO transport cannot reconcile while stopped");
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const abort = () => finish(() => reject(abortError()));
      const finish = (settle: () => void) => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        control.signal?.removeEventListener("abort", abort);
        unsubscribe();
        settle();
      };
      unsubscribe = this.transport.onState((state) => {
        if (state.ready) {
          finish(resolve);
        } else if (state.state === "stopped" || state.state === "close-failed") {
          finish(() => reject(new BioUsbError("NOT_READY", "BIO transport did not recover for reconciliation")));
        }
      });
      control.signal?.addEventListener("abort", abort, { once: true });
      const remaining = remainingOperationMs(control);
      const timeoutMs = Math.min(this.reconnectReadyTimeoutMs, remaining);
      timer = setTimeout(() => {
        if (remaining <= this.reconnectReadyTimeoutMs) finish(() => reject(abortError()));
        else finish(() => reject(new BioUsbError("TIMEOUT", "BIO transport recovery timed out")));
      }, timeoutMs);
    });
    throwIfOperationStopped(control);
  }

  private send(operation: BioOperation, control: BioOperationControl = {}): Promise<BioCommandAcceptance> {
    return this.operationQueue.run(() => {
      // [확인됨] queue 대기 중 deadline/abort가 지나면 소유권을 얻은 직후 다시 검사해
      // expired command가 새 USB frame을 시작하지 못하게 한다.
      throwIfOperationStopped(control);
      return this.sendDirect(operation, control);
    });
  }

  private async sendDirect(operation: BioOperation, control: BioOperationControl = {}): Promise<BioCommandAcceptance> {
    throwIfOperationStopped(control);
    const request = encodeBioCommand(operation, this.sequence);
    this.sequence = (this.sequence + 1) & 0xff;
    const response = decodeBioResponse(await this.transport.request(request));
    throwIfOperationStopped(control);
    if (response.kind !== "outer-ack") throw new BioUsbError("MALFORMED_FRAME", "BIO outer ACK was not validated");
    if (!response.accepted) throw Object.assign(new Error("BIO dongle rejected the command"), { code: "BIO_DONGLE_REJECTED" });
    return { outcome: "dongle-accepted", deviceApplied: false };
  }
}

function toDiscoveredDevice(response: Extract<BioResponse, { kind: "discovery" }>): BioDiscoveredDevice {
  return {
    nativeUuid: parseBioDeviceUuid(response.deviceUuid),
    deviceUuid: response.deviceUuid,
    logicalAddress: response.logicalAddress,
    networkId: response.networkId,
    firmwareVersion: `${response.firmware.major}.${response.firmware.minor}.${response.firmware.revision}.${response.firmware.build}`,
    rssi: response.rssiDbm
  };
}

function toTarget(device: BioDiscoveredDevice): Extract<BioLampTarget, { kind: "unicast" }> {
  return { kind: "unicast", networkId: device.networkId, logicalAddress: device.logicalAddress };
}

function normalizeNativeUuid(nativeId: string) {
  return nativeId.startsWith("bio:")
    ? parseBioDeviceUuid(nativeId)
    : parseBioDeviceUuid(formatBioDeviceUuid(nativeId));
}

function validateLogicalAddress(value: number) {
  if (!Number.isInteger(value) || value < 0x0001 || value > 0x7fff) {
    throw new RangeError("Invalid BIO logical address");
  }
}

function positiveDuration(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new RangeError(`Invalid BIO ${label}`);
  return value;
}

function controlledDelay(milliseconds: number, control: BioOperationControl = {}) {
  return new Promise<void>((resolve, reject) => {
    if (operationStopped(control)) {
      reject(abortError());
      return;
    }
    const remaining = remainingOperationMs(control);
    const waitMs = Math.min(milliseconds, remaining);
    const timer = setTimeout(() => {
      control.signal?.removeEventListener("abort", cancel);
      if (operationStopped(control)) reject(abortError());
      else resolve();
    }, waitMs);
    const cancel = () => {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", cancel);
      reject(abortError());
    };
    control.signal?.addEventListener("abort", cancel, { once: true });
  });
}

function operationStopped(control: BioOperationControl) {
  return Boolean(control.signal?.aborted ||
    (control.deadlineAt !== undefined && Date.now() >= control.deadlineAt));
}

function throwIfOperationStopped(control: BioOperationControl) {
  if (operationStopped(control)) throw abortError();
}

function remainingOperationMs(control: BioOperationControl) {
  if (control.deadlineAt === undefined) return 2_147_483_647;
  return Math.max(0, control.deadlineAt - Date.now());
}

function abortError() {
  return new DOMException("BIO operation cancelled or expired", "AbortError");
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
