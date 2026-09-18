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
import { BioDeviceReadTimeoutError, BioUsbError } from "./bio-usb-error";

export type BioClientEvent = Exclude<BioResponse, { kind: "probe" | "outer-ack" }> | { kind: "invalid-notification" };
export type BioDongleClientOptions = Pick<BioTransportOptions, "timeoutMs" | "retirementTimeoutMs"> & {
  connectionFactory?: BioTransportOptions["connectionFactory"];
  initialSequence?: number;
  scanDurationMs?: number;
  observationTimeoutMs?: number;
  reconnectReadyTimeoutMs?: number;
};
export interface BioOperationControl {
  signal?: AbortSignal;
  deadlineAt?: number;
  onWriteStarted?: () => void;
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
  | { outcome: "unknown"; code: "BIO_ADDRESS_STATE_UNKNOWN"; safeRestoreDevices: BioDiscoveredDevice[] };
/**
 * [확인됨] address reconciliation scan이 다른 UUID의 destination 점유를 확인한 실패다.
 * safeRestoreDevices에는 같은 scan에서 target UUID가 확인되고 다른 UUID와 logical address를
 * 공유하지 않은 관측만 담는다. [미확인] 목록에 없는 주소는 안전하다고 추정하지 않는다.
 */
export class BioAddressConflictError extends BioUsbError {
  readonly safeRestoreDevices: BioDiscoveredDevice[];

  constructor(devices: BioDiscoveredDevice[]) {
    super("BIO_ADDRESS_CONFLICT", "Requested BIO address is occupied by another UUID");
    this.name = "BioAddressConflictError";
    this.safeRestoreDevices = devices.map((device) => ({ ...device }));
  }
}
export type BioVerifiedLampTarget = Extract<BioLampTarget, { kind: "unicast" }> & { nativeUuid: string };

type ReadbackEvent = Extract<BioResponse, { kind: "high-brightness-report" | "control-mode-report" }>;
type BioReadbackOperation = Extract<BioOperation,
  { kind: "readHighBrightness" | "readControlMode" | "setControlMode" }>;

/**
 * BIO direct-USB 상위 lifecycle client.
 *
 * - [확인됨] 외부 0x11 status 0은 동글의 TX 수락일 뿐이며 `deviceApplied`는 항상 false다.
 *   주소는 UUID/old/new scan 증거, 제어는 동일 UUID/address의 0x12 read-back으로만 확정한다.
 * - [확인됨] scan cache는 한 scan window에서 UUID별 마지막 report의 address/RSSI를 보관한다.
 *   정상 종료·일반 오류는 stop ACK까지 확인하고, cancellation/deadline은 새 stop write 대신
 *   connection generation을 폐기한 경우에만 실패로 반환해 같은 stream의 후속 사용을 막는다.
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
      retirementTimeoutMs: options.retirementTimeoutMs,
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

  /** [확인됨] health에는 USB identity나 payload가 아닌 transport readiness boolean만 전달한다. */
  transportSnapshot() {
    const { transportConnected, protocolReady } = this.transport.snapshot();
    return { transportConnected, protocolReady };
  }

  async close(): Promise<void> {
    for (const session of this.identifySessions.values()) session.controller.abort();
    await Promise.allSettled([...this.identifySessions.values()].map((session) => session.promise));
    await this.transport.stop();
  }

  /**
   * [확인됨] scan 성공은 start ACK만이 아니라 fixed window 뒤 stop ACK까지 필요하다.
   * 취소 시에는 stop을 새로 쓰지 않고 connection generation을 폐기하며, 어느 실패에서도
   * 수집 목록을 cache/성공으로 공개하지 않아 동글의 scan 상태를 추정하지 않는다.
   */
  scan(control: BioOperationControl = {}): Promise<BioDiscoveredDevice[]> {
    // 동글은 scan 시작 ACK 뒤 일정 시간 동안 0x12 discovery를 비동기로 내보낸다.
    // start/stop frame만 각각 queue에 넣고 수집 window 동안 소유권을 풀면 다른 GET이
    // 그 사이에 끼어들어 transaction ID 없는 0x12를 서로의 응답으로 오인하거나 동글이
    // 명령을 거부한다. scan 호출 순간 global queue 자리를 먼저 예약하고, stop ACK까지
    // 하나의 operation으로 유지한다. queue 안에서는 재진입 deadlock을 피하려고 아래
    // owned 구현이 sendDirect를 사용한다.
    return this.operationQueue.run(() => this.scanOwned(control));
  }

  private async scanOwned(control: BioOperationControl): Promise<BioDiscoveredDevice[]> {
    throwIfOperationStopped(control);
    await this.waitUntilReadyIfReconnecting(control);
    throwIfOperationStopped(control);
    if (this.activeScan) throw new Error("BIO scan is already active");
    const collected = new Map<string, BioDiscoveredDevice>();
    const observations: BioDiscoveredDevice[] = [];
    this.activeScan = collected;
    this.activeScanObservations = observations;
    let failure: unknown;
    let scanAccepted = false;
    try {
      await this.sendDirect({ kind: "scan" }, control, () => { scanAccepted = true; });
      await controlledDelay(this.scanDurationMs, control);
    } catch (error) {
      failure = error;
    } finally {
      try {
        // [확인됨] accepted ACK는 sendDirect의 첫 await continuation에서 exact status를 decode한
        // 직후, post-ACK abort 검사보다 먼저 표시한다. ACK 직후 caller가 동기적으로 abort했어도
        // scan ownership을 잃지 않는다. expiry 뒤 stop은 새 physical write이므로 보내지 않고,
        // accepted scan은 generation을 폐기한다. reject status는 accepted로 표시하지 않으며
        // start write 중 취소는 transport가 이미 폐기한다.
        if (operationStopped(control)) {
          if (scanAccepted) await this.transport.retireCancelledOperation();
        } else await this.sendDirect({ kind: "stopScan" }, control);
      } catch (stopError) {
        // stop ACK/descriptor retirement는 성공 list의 필수 gate다. start/window 취소와
        // cleanup 실패는 서로 다른 사실이므로 후자를 앞선 primary 위에 덮지 않는다.
        // [확인됨] AggregateError 순서는 primary → retirement이며 HIL redacted error 배열도
        // 이 순서를 유지한다. [미확인] CLOSE_FAILED 뒤 native USB release/reattach는 성공으로
        // 추정하지 않는다.
        failure = failure === undefined
          ? stopError
          : new AggregateError([failure, stopError], "BIO scan and transport retirement failed");
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

  /**
   * [확인됨] HIL safety gate는 UUID별 마지막 값으로 합쳐진 product scan보다 먼저, 같은 scan
   * window의 checksum-validated `0x12` 관측을 전부 검사해야 duplicate UUID/address collision을
   * 숨기지 않는다. 이 API도 start/stop ACK가 모두 끝난 성공 scan만 반환하며 raw packet은
   * 노출하지 않는다. [추정] 반복된 동일 관측은 RF 재전송일 수 있으므로 호출자가 exact
   * identity/address/network 중복과 상충을 구분한다.
   */
  async scanObservations(control: BioOperationControl = {}): Promise<BioDiscoveredDevice[]> {
    await this.scan(control);
    return this.lastScanObservations.map((device) => ({ ...device }));
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
    let result = await this.assignAddressOnce(nativeId, logicalAddress, control);
    if (result.outcome !== "unchanged") return result;

    const device = result.device;
    const operation: BioOperation = {
      kind: "assignAddress",
      target: { kind: "unicast", networkId: device.networkId, logicalAddress: device.logicalAddress },
      nativeUuid: device.nativeUuid,
      logicalAddress
    };
    throwIfOperationStopped(control);
    await this.sendUncertainWrite(operation, control);
    result = await this.reconcileAddress(device.nativeUuid, device.logicalAddress, logicalAddress, control);
    return result;
  }

  /**
   * [확인됨] Task 9의 승인 관문은 주소 frame을 정확히 한 번만 보낸 뒤 ACK 상태와 무관하게
   * old/new scan으로 판정한다. old-only도 자동 재전송하지 않고 호출자에게 그대로 반환한다.
   * [미확인] 실제 모듈의 주소 적용 여부는 guarded HIL 전까지 확인되지 않았다.
   */
  async assignAddressOnce(nativeId: string, logicalAddress: number, control: BioOperationControl = {}): Promise<BioAddressAssignmentResult> {
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
    return this.reconcileAddress(device.nativeUuid, device.logicalAddress, logicalAddress, control);
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
    const safeRestoreDevices = collectCollisionFreeTargetObservations(devices, nativeUuid);
    // [확인됨] reconciliation 결과는 후속 제어뿐 아니라 sensor 복귀 목적지의 권한 증거다.
    // 따라서 새 주소만이 아니라 "변경되지 않음"으로 반환할 old 주소도 다른 UUID와 공유하면
    // target에게 쓴다고 보장할 수 없다. [미확인] 충돌 시 어느 물리 lamp가 frame을 적용할지는
    // 추정하지 않고, 두 restoration 후보 모두 collision-free일 때만 상위 계층에 넘긴다.
    const conflict = devices.find((device) =>
      (device.logicalAddress === oldAddress || device.logicalAddress === newAddress)
      && device.nativeUuid !== nativeUuid
    );
    if (conflict) {
      throw new BioAddressConflictError(safeRestoreDevices);
    }
    const oldDevice = devices.find((device) => device.nativeUuid === nativeUuid && device.logicalAddress === oldAddress);
    const newDevice = devices.find((device) => device.nativeUuid === nativeUuid && device.logicalAddress === newAddress);
    // 초기 설치 DB의 allocator가 장치에 이미 저장된 주소와 같은 값을 배정할 수 있다.
    // 이때 oldDevice와 newDevice는 같은 관측 하나를 가리키므로 아래의 일반 old/new
    // 배타 판정만으로는 항상 unknown이 된다. 위 충돌 검사까지 통과했다면 fresh scan에서
    // 정확한 UUID가 목표 주소를 단독 점유한다는 충분한 증거가 있으므로, 물리 주소 변경이
    // 필요 없는 정상 수렴으로 확정한다. 장치가 없거나 다른 UUID가 주소를 공유하면 이
    // 분기에 도달해도 성공하지 않으며 각각 unknown/충돌로 유지된다.
    if (oldAddress === newAddress) {
      return newDevice
        ? { outcome: "confirmed", device: { ...newDevice } }
        : { outcome: "unknown", code: "BIO_ADDRESS_STATE_UNKNOWN", safeRestoreDevices };
    }
    if (newDevice && !oldDevice) return { outcome: "confirmed", device: { ...newDevice } };
    if (oldDevice && !newDevice) return { outcome: "unchanged", device: { ...oldDevice } };
    return { outcome: "unknown", code: "BIO_ADDRESS_STATE_UNKNOWN", safeRestoreDevices };
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
    const observedBrightnessPercent = bioRawToPercent(brightness.rawHighBrightness);
    let mode: Awaited<ReturnType<BioDongleClient["readDeviceInfo"]>>;
    try {
      // [확인됨] power truth는 brightness로 유도할 수 없다. brightness mismatch여도 안전하게
      // 가능한 경우 mode GET까지 수집해 force-on/off/sensor 관측을 같은 failure에 보존한다.
      mode = await this.readDeviceInfo(target, control);
    } catch (cause) {
      throwIfOperationStopped(control);
      if (brightness.rawHighBrightness !== rawHighBrightness) {
        throw Object.assign(
          new BioUsbError("BIO_BRIGHTNESS_STATE_MISMATCH", "BIO high-brightness read-back did not match", { cause }),
          {
            observedRawHighBrightness: brightness.rawHighBrightness,
            observedBrightnessPercent
          }
        );
      }
      throw cause;
    }
    throwIfOperationStopped(control);
    if (brightness.rawHighBrightness !== rawHighBrightness) {
      throw Object.assign(
        new BioUsbError("BIO_BRIGHTNESS_STATE_MISMATCH", "BIO high-brightness read-back did not match"),
        {
          observedRawHighBrightness: brightness.rawHighBrightness,
          observedBrightnessPercent,
          observedMode: mode.mode
        }
      );
    }
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

  /**
   * 취소된 write가 descriptor 세대를 폐기한 뒤 사용하는 검증형 sensor 복귀 API다.
   * [확인됨] 호출자의 취소 signal을 재사용하지 않고 별도의 cleanup deadline을 넘길 수 있으며,
   * fresh converter/GET_NWK probe로 transport ready가 다시 확인되기 전에는 0x10 sensor frame을
   * 만들지 않는다. [미확인] recovery가 실패한 descriptor의 release/driver 재부착 상태는
   * 성공으로 추정하지 않고 NOT_READY/CLOSE_FAILED/AbortError로 호출자에게 보존한다.
   */
  async restoreSensorMode(
    device: Pick<BioDiscoveredDevice, "nativeUuid" | "logicalAddress" | "networkId">,
    control: BioOperationControl = {}
  ): Promise<void> {
    await this.waitUntilReadyIfReconnecting(control);
    throwIfOperationStopped(control);
    const expected = { nativeUuid: device.nativeUuid, logicalAddress: device.logicalAddress, target: toTarget(device) };
    const report = await this.requestReadback(
      { kind: "setControlMode", target: expected.target, mode: "sensor" },
      expected,
      control
    );
    if (report.kind !== "control-mode-report" || report.mode !== "sensor") {
      throw new BioUsbError("BIO_CONTROL_MODE_STATE_MISMATCH", "BIO sensor-mode read-back did not match");
    }
  }

  private requestReadback(
    operation: BioReadbackOperation,
    expected: { nativeUuid: string; logicalAddress: number },
    control: BioOperationControl = {}
  ): Promise<ReadbackEvent> {
    return this.operationQueue.run(async () => {
      throwIfOperationStopped(control);
      await this.waitUntilReadyIfReconnecting(control);
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
    let requestAccepted = false;
    try {
      // [확인됨] 캡처상 장치 0x12가 동글 outer 0x11보다 먼저 올 수 있으므로 listener를
      // wire write 전에 등록한다. waiter result에는 이 시점부터 rejection handler가 붙어 있다.
      await this.sendDirect(operation, control, () => { requestAccepted = true; });
      const observed = await waiting.result;
      if (!observed.ok) throw observed.error;
      throwIfOperationStopped(control);
      return observed.value;
    } catch (error) {
      const reportMatched = waiting.hasMatched();
      waiting.cancel();
      if (requestAccepted && !reportMatched) {
        // [확인됨] GET ACK 뒤 아직 matching 0x12가 없으면 UUID/address/DPID만으로 늦은
        // report와 다음 GET을 구분할 수 없다. caller abort/deadline뿐 아니라 observation timeout도
        // waiter 제거만으로는 부족하므로 같은 generation을 폐기하고 close가 확인된 뒤 queue를
        // 넘긴다. ACK보다 먼저 이미 matching report를 확보한 경우에는 남은 late report
        // ownership이 없으므로 불필요한 retirement를 피한다.
        try {
          await this.transport.retireCancelledOperation();
        } catch (retirementError) {
          throw new AggregateError(
            [error, retirementError],
            "BIO read-back and transport retirement failed"
          );
        }
      }
      throw error;
    }
  }

  private waitForReadback(
    expected: { nativeUuid: string; logicalAddress: number },
    expectedKind: ReadbackEvent["kind"],
    control: BioOperationControl = {}
  ) {
    let unsubscribe = () => {};
    let unsubscribeTransport = () => {};
    const generation = this.transport.snapshot().generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait!: (error: unknown) => void;
    let settled = false;
    let matched = false;
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
      unsubscribeTransport();
    };
    const checkTransport = () => {
      const snapshot = this.transport.snapshot();
      if (settled || (snapshot.ready && snapshot.generation === generation)) return;
      // ACK는 USB TX 수락일 뿐이다. 관측 대기 중 연결/세대가 바뀌면 장치 무응답을
      // 증명할 수 없고, 재연결된 stream의 report도 이전 GET의 응답으로 사용할 수 없다.
      settled = true;
      cleanup();
      rejectWait(new BioUsbError(snapshot.lastError ?? "DISCONNECTED", "BIO transport changed during read-back"));
    };
    const promise = new Promise<ReadbackEvent>((resolve, reject) => {
      rejectWait = reject;
      unsubscribe = this.onEvent((event) => {
        checkTransport();
        if (settled) return;
        if (event.kind !== expectedKind
          || event.deviceUuid !== `bio:${expected.nativeUuid}`
          || event.logicalAddress !== expected.logicalAddress) return;
        matched = true;
        settled = true;
        cleanup();
        resolve(event);
      });
      unsubscribeTransport = this.transport.onState(checkTransport);
      control.signal?.addEventListener("abort", cancelForControl, { once: true });
      const remaining = remainingOperationMs(control);
      timer = setTimeout(() => {
        checkTransport();
        if (settled) return;
        settled = true;
        cleanup();
        reject(operationStopped(control)
          ? abortError()
          : new BioDeviceReadTimeoutError());
      }, Math.min(this.observationTimeoutMs, remaining));
      if (operationStopped(control)) cancelForControl();
      else checkTransport();
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
      hasMatched: () => matched,
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

  private send(
    operation: BioOperation,
    control: BioOperationControl = {},
    onAccepted?: () => void
  ): Promise<BioCommandAcceptance> {
    return this.operationQueue.run(() => {
      // [확인됨] queue 대기 중 deadline/abort가 지나면 소유권을 얻은 직후 다시 검사해
      // expired command가 새 USB frame을 시작하지 못하게 한다.
      throwIfOperationStopped(control);
      return this.sendDirect(operation, control, onAccepted);
    });
  }

  private async sendDirect(
    operation: BioOperation,
    control: BioOperationControl = {},
    onAccepted?: () => void
  ): Promise<BioCommandAcceptance> {
    throwIfOperationStopped(control);
    const request = encodeBioCommand(operation, this.sequence);
    this.sequence = (this.sequence + 1) & 0xff;
    const response = decodeBioResponse(await this.transport.request(request, control));
    if (response.kind !== "outer-ack") throw new BioUsbError("MALFORMED_FRAME", "BIO outer ACK was not validated");
    if (!response.accepted) throw Object.assign(new Error("BIO dongle rejected the command"), { code: "BIO_DONGLE_REJECTED" });
    // [확인됨] accepted ownership은 ACK decode 직후 post-ACK abort 검사보다 먼저 기록한다.
    // transport가 ACK를 resolve한 직후 signal이 바뀌어도 이 continuation은 exact status를 먼저
    // 분류하므로 상위 scan/GET이 generation을 폐기할 근거를 잃지 않는다. reject status에는
    // 이 callback을 호출하지 않는다.
    onAccepted?.();
    throwIfOperationStopped(control);
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

function toTarget(device: Pick<BioDiscoveredDevice, "logicalAddress" | "networkId">): Extract<BioLampTarget, { kind: "unicast" }> {
  return { kind: "unicast", networkId: device.networkId, logicalAddress: device.logicalAddress };
}

/**
 * [확인됨] sensor restore는 UUID가 target과 일치하고, 같은 logical address에 다른 UUID가
 * 한 번도 관측되지 않은 identity에만 허용한다. 같은 UUID의 old/new 동시 관측은 주소 적용이
 * 불명확하다는 증거이므로 둘 다 보존할 수 있지만, 다른 UUID와 충돌한 destination은 제외한다.
 * [미확인] 관측되지 않은 주소의 현재 점유 상태는 증명할 수 없으므로 restore 후보로 만들지 않는다.
 */
function collectCollisionFreeTargetObservations(
  devices: BioDiscoveredDevice[],
  nativeUuid: string
): BioDiscoveredDevice[] {
  const conflictingAddresses = new Set(devices
    .filter((device) => device.nativeUuid !== nativeUuid)
    .map((device) => device.logicalAddress));
  const unique = new Map<string, BioDiscoveredDevice>();
  for (const device of devices) {
    if (device.nativeUuid !== nativeUuid || conflictingAddresses.has(device.logicalAddress)) continue;
    unique.set(`${device.logicalAddress}:${device.networkId}`, device);
  }
  return [...unique.values()].map((device) => ({ ...device }));
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
