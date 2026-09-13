import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { BioDeviceMappingStore } from "../src/bio/bio-device-mapping-store";
import {
  BioAddressConflictError,
  BioDongleClient,
  type BioAddressAssignmentResult,
  type BioDiscoveredDevice,
  type BioVerifiedLampTarget
} from "../src/bio/bio-dongle-client";
import { BioDirectUsbConnection } from "../src/bio/bio-direct-usb-connection";
import { decodeBioResponse, type BioControlMode } from "../src/bio/bio-command-codec";
import type { BioFrame } from "../src/bio/bio-frame-codec";
import { BioUsbError } from "../src/bio/bio-usb-error";
import { BioUsbTransport } from "../src/bio/bio-usb-transport";

const DEFAULT_TIMEOUT_MS = 3_000;
const PASSIVE_DISCOVERY_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const OUTPUT_STEPS = [0, 20, 60, 90, 100] as const;

export interface HilDiscoveredDevice {
  nativeUuid: string;
  logicalAddress: number;
  networkId: number;
  firmwareVersion: string;
  rssi: number;
}

export interface HilReadOnlySession {
  discover(signal?: AbortSignal): Promise<HilDiscoveredDevice[]>;
  close(): Promise<void>;
}

export interface HilWritableSession {
  discoverFresh(signal?: AbortSignal): Promise<HilDiscoveredDevice[]>;
  reserveTemporaryMapping(device: HilDiscoveredDevice, newAddress: number): Promise<void>;
  assignAddressOnce(
    device: HilDiscoveredDevice,
    newAddress: number,
    control?: { signal?: AbortSignal; onWriteStarted?: () => void }
  ): Promise<BioAddressAssignmentResult>;
  confirmTemporaryMapping(device: HilDiscoveredDevice): Promise<void>;
  readState(device: HilDiscoveredDevice, signal?: AbortSignal): Promise<{ brightnessPercent: number | null; mode: BioControlMode }>;
  setOutput(
    device: HilDiscoveredDevice,
    percent: number,
    control?: { signal?: AbortSignal; onWriteStarted?: () => void }
  ): Promise<void>;
  restoreSensorMode(device: HilDiscoveredDevice, control?: { deadlineAt?: number }): Promise<void>;
  close(): Promise<void>;
}

export interface TemporaryMappingLocation { directory: string; path: string }

export interface BioRegistrationHilDependencies {
  createReadOnlySession?: () => HilReadOnlySession;
  createWritableSession?: (mappingPath: string) => Promise<HilWritableSession>;
  createTemporaryMapping?: () => Promise<TemporaryMappingLocation>;
  removeTemporaryMapping?: (location: TemporaryMappingLocation) => Promise<void>;
  confirmVisualStep?: (percent: number, signal: AbortSignal) => Promise<boolean>;
  cleanupTimeoutMs?: number;
  output?: (line: string) => void;
}

type HilOptions =
  | { mode: "dry-run"; newAddress?: number }
  | { mode: "execute"; fingerprint: string; oldAddress: number; newAddress: number; confirmation: string };

class HilSafetyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HilSafetyError";
  }
}

/**
 * UUID 자체 대신 안정적인 64-bit SHA-256 prefix만 사용자 확인값으로 노출한다.
 * [확인됨] 입력 UUID는 BIO packet의 6-byte identity다. [추정] 이 축약값은 사람이 한 번의
 * 단일 장치 HIL 대상을 재확인하기 위한 표시값이며 durable device identity를 대체하지 않는다.
 */
export function fingerprintBioUuid(nativeUuid: string): string {
  if (!/^[0-9a-f]{12}$/.test(nativeUuid)) throw new HilSafetyError("BIO_INVALID_IDENTITY");
  return `sha256:${createHash("sha256").update(Buffer.from(nativeUuid, "hex")).digest("hex").slice(0, 16)}`;
}

/**
 * Task 9 안전 관문.
 *
 * [확인됨] dry-run 기본 구현은 CH34x 고정 초기화, converter literal 두 개, GET_NWK와 이미
 * 들어오는 outer 0x12 알림만 소비한다. outer 0x10 encoder나 BioDongleClient를 만들지 않는다.
 * [확인됨] 주소/밝기/mode write 객체는 현 재검색값과 fingerprint/old/new/confirmation 전체가
 * 일치한 execute 경로에서만 생성된다. [미확인] 주소 및 getter의 실제 firmware 적용은 사용자가
 * 이 관문 뒤 별도로 승인한 write HIL 전까지 계속 미확인이다.
 */
export async function runBioRegistrationHil(
  args: string[],
  dependencies: BioRegistrationHilDependencies = {}
): Promise<number> {
  const output = dependencies.output ?? ((line: string) => console.log(line));
  let options: HilOptions;
  try {
    options = parseArguments(args);
  } catch {
    output(JSON.stringify({ status: "INVALID_ARGUMENTS" }));
    return 2;
  }

  const cancellation = new AbortController();
  const removeSignalHandlers = installSignalCancellation(cancellation);
  try {
    return await runBioRegistrationHilWithSignal(options, dependencies, output, cancellation.signal);
  } finally {
    removeSignalHandlers();
  }
}

async function runBioRegistrationHilWithSignal(
  options: HilOptions,
  dependencies: BioRegistrationHilDependencies,
  output: (line: string) => void,
  signal: AbortSignal
): Promise<number> {
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) {
    outputFailure(output, [new HilSafetyError("INVALID_CLEANUP_TIMEOUT")]);
    return 1;
  }
  let observed: HilDiscoveredDevice;
  try {
    observed = await discoverReadOnly(dependencies, signal, cleanupTimeoutMs);
    throwIfHilCancelled(signal);
  } catch (error) {
    outputFailure(output, [error]);
    return 1;
  }

  const fingerprint = fingerprintBioUuid(observed.nativeUuid);
  if (options.mode === "dry-run") {
    if (options.newAddress === undefined) {
      output(JSON.stringify({
        status: "NEW_ADDRESS_SELECTION_BLOCKED",
        fingerprint,
        oldAddress: formatAddress(observed.logicalAddress),
        requestedNewAddress: null,
        networkId: formatAddress(observed.networkId),
        reason: "API_RESERVED_ADDRESS_REQUIRED"
      }));
      return 3;
    }
    try { assertAvailableNewAddress(observed, options.newAddress); } catch (error) {
      outputFailure(output, [error]);
      return 1;
    }
    const oldAddress = formatAddress(observed.logicalAddress);
    const newAddress = formatAddress(options.newAddress);
    output(JSON.stringify({
      status: "AWAITING_USER_CONFIRMATION",
      fingerprint,
      oldAddress,
      requestedNewAddress: newAddress,
      networkId: formatAddress(observed.networkId),
      confirmation: confirmationLiteral(fingerprint, oldAddress, newAddress),
      newAddressSource: "CALLER_MUST_USE_API_RESERVED_ADDRESS"
    }));
    return 0;
  }

  try {
    verifyConfirmation(options, observed, fingerprint);
  } catch (error) {
    outputFailure(output, [error]);
    return 1;
  }
  return executeWriteHil(options, observed, fingerprint, dependencies, output, signal, cleanupTimeoutMs);
}

async function discoverReadOnly(
  dependencies: BioRegistrationHilDependencies,
  signal: AbortSignal,
  cleanupTimeoutMs: number
): Promise<HilDiscoveredDevice> {
  // 별도 factory가 dry-run capability 경계다. 이 블록에서는 write-capable session을 참조하지 않는다.
  const session = dependencies.createReadOnlySession?.() ?? new PassiveReadOnlySession();
  let primary: unknown;
  let result: HilDiscoveredDevice | undefined;
  try {
    result = selectExactlyOne(await session.discover(signal));
  } catch (error) {
    primary = error;
  }
  try {
    await boundedCleanup(() => session.close(), cleanupTimeoutMs, "CLOSE_TIMEOUT");
  } catch (error) {
    if (primary === undefined) primary = error;
    else primary = new AggregateError([primary, error], "BIO read-only discovery and cleanup failed");
  }
  if (primary !== undefined) throw primary;
  return result!;
}

async function executeWriteHil(
  options: Extract<HilOptions, { mode: "execute" }>,
  observed: HilDiscoveredDevice,
  fingerprint: string,
  dependencies: BioRegistrationHilDependencies,
  output: (line: string) => void,
  signal: AbortSignal,
  cleanupTimeoutMs: number
): Promise<number> {
  const createTemporaryMapping = dependencies.createTemporaryMapping ?? defaultCreateTemporaryMapping;
  const removeTemporaryMapping = dependencies.removeTemporaryMapping ?? defaultRemoveTemporaryMapping;
  const confirmVisualStep = dependencies.confirmVisualStep ?? defaultConfirmVisualStep;
  let location: TemporaryMappingLocation | undefined;
  let temporaryMappingState: "RETAINED" | "REMOVED" | undefined;
  let writer: HilWritableSession | undefined;
  const failures: unknown[] = [];
  let target: HilDiscoveredDevice = observed;
  let processRestartRequired = false;
  // [확인됨] read-only observation/fresh gate는 lamp state를 바꾸지 않는다. 실제 state/address
  // write 소유권을 얻기 전에는 sensor restore도 새로운 물리 write이므로 후보를 만들지 않는다.
  let finalRestoreTargets: HilDiscoveredDevice[] = [];

  try {
    const candidateLocation = await createTemporaryMapping();
    assertTemporaryMappingLocation(candidateLocation);
    location = candidateLocation;
    temporaryMappingState = "RETAINED";
    throwIfHilCancelled(signal);
    writer = await (dependencies.createWritableSession?.(location.path) ?? Promise.resolve(new ProductWritableSession(location.path)));
    throwIfHilCancelled(signal);
    const fresh = selectExactlyOne(await writer.discoverFresh(signal));
    throwIfHilCancelled(signal);
    assertSameFreshDevice(observed, fresh);
    assertAvailableNewAddress(fresh, options.newAddress);
    await writer.reserveTemporaryMapping(fresh, options.newAddress);
    throwIfHilCancelled(signal);

    // [확인됨] 이 API는 address outer 0x10을 정확히 한 번만 생성한다. ACK 성공/실패/timeout은
    // 적용 판정이 아니며 이어지는 old/new scan 결과만 사용한다. old-only/unknown에는 재시도 없다.
    // [확인됨] write 뒤 unknown/collision에서는 post-write scan이 같은 target UUID로 확인하고
    // 다른 UUID와 logical-address 충돌이 없었던 identity만 복귀 후보가 된다. 관측되지 않은
    // old/new 주소나 충돌 destination에는 sensor frame을 추정 전송하지 않는다.
    let addressWriteStarted = false;
    let assignment: BioAddressAssignmentResult;
    try {
      assignment = await writer.assignAddressOnce(fresh, options.newAddress, {
        signal,
        onWriteStarted: () => { addressWriteStarted = true; }
      });
    } catch (error) {
      // [확인됨] queue 취소 등으로 native write 소유권을 얻지 못했다면 restore도 전송하지
      // 않는다. write가 실제 시작된 뒤 reconciliation이 collision을 보고했다면 client가
      // 다른 UUID와 주소 충돌이 없는 target UUID 관측만 safeRestoreDevices로 전달한다.
      finalRestoreTargets = addressWriteStarted
        ? safeRestoreTargetsFromError(error, fresh, options.newAddress)
        : [];
      throw error;
    }
    if (!addressWriteStarted) throw new HilSafetyError("ADDRESS_WRITE_OWNERSHIP_MISSING");
    if (assignment.outcome === "unchanged") {
      finalRestoreTargets = addressWriteStarted ? [{ ...assignment.device }] : [];
      throw new HilSafetyError("BIO_ADDRESS_STATE_UNKNOWN");
    }
    if (assignment.outcome === "unknown") {
      finalRestoreTargets = addressWriteStarted
        ? validateSafeRestoreTargets(assignment.safeRestoreDevices, fresh, options.newAddress)
        : [];
      throw new HilSafetyError("BIO_ADDRESS_STATE_UNKNOWN");
    }
    target = { ...assignment.device };
    finalRestoreTargets = addressWriteStarted ? [target] : [];
    await writer.confirmTemporaryMapping(target);
    throwIfHilCancelled(signal);
    await writer.readState(target, signal);
    throwIfHilCancelled(signal);

    for (const percent of OUTPUT_STEPS) {
      let stateWriteStarted = false;
      await runPreservingPrimaryAndRestore(async () => {
        throwIfHilCancelled(signal);
        await writer.setOutput(target, percent, {
          signal,
          onWriteStarted: () => { stateWriteStarted = true; }
        });
        throwIfHilCancelled(signal);
        if (!await confirmVisualStep(percent, signal)) throw new HilSafetyError("VISUAL_CONFIRMATION_REJECTED");
        throwIfHilCancelled(signal);
      }, async () => {
        // [확인됨] setOutput이 queue에서 취소되어 native state write가 시작되지 않았다면 이 단계의
        // restore도 보내지 않는다. 하나라도 실제 write가 시작된 경우에만 검증된 target으로 복귀한다.
        if (stateWriteStarted) {
          // [확인됨] user cancellation signal은 이미 abort 상태이므로 복귀에 재사용하지 않는다.
          // 별도 deadline 안에서 transport recovery probe와 sensor read-back까지 확인한다.
          await writer.restoreSensorMode(target, { deadlineAt: Date.now() + cleanupTimeoutMs });
        }
      }, cleanupTimeoutMs);
    }
    // [확인됨] 같은 process 안에서 client instance만 다시 만드는 것은 Gateway process restart가
    // 아니다. integrity-bound handoff/re-invocation driver가 아직 없으므로 phase 1 이후 반드시
    // 중단한다. [미확인] 실제 process boundary 뒤 mapping 복구와 20%→sensor 검증은 Step 7로
    // 남으며, 이 CLI는 그 완료 상태를 만들지 않는다.
    processRestartRequired = true;
  } catch (error) {
    failures.push(error);
  } finally {
    if (writer) {
      for (const restoreTarget of finalRestoreTargets) {
        try {
          await boundedCleanup(
            () => writer!.restoreSensorMode(restoreTarget, { deadlineAt: Date.now() + cleanupTimeoutMs }),
            cleanupTimeoutMs,
            "RESTORE_TIMEOUT"
          );
        } catch (error) { failures.push(error); }
      }
      try { await boundedCleanup(() => writer!.close(), cleanupTimeoutMs, "CLOSE_TIMEOUT"); }
      catch (error) { failures.push(error); }
    }
    if (location) {
      try {
        await boundedCleanup(
          () => removeTemporaryMapping(location!),
          cleanupTimeoutMs,
          "TEMP_CLEANUP_FAILED"
        );
        temporaryMappingState = "REMOVED";
      } catch (error) {
        failures.push(asTemporaryCleanupFailure(error));
        temporaryMappingState = "RETAINED";
      }
    }
  }

  if (failures.length > 0) {
    outputFailure(output, failures, temporaryMappingState);
    return 1;
  }
  if (processRestartRequired) {
    output(JSON.stringify({
      status: "PROCESS_RESTART_DRIVER_REQUIRED",
      completedPhase: "ADDRESS_AND_OUTPUT_VALIDATION",
      fingerprint,
      oldAddress: formatAddress(observed.logicalAddress),
      newAddress: formatAddress(options.newAddress),
      networkId: formatAddress(observed.networkId),
      temporaryMapping: temporaryMappingState,
      step7: "INCOMPLETE",
      multiDeviceGroup: "DEFERRED_INSUFFICIENT_HARDWARE"
    }));
    return 4;
  }
  throw new HilSafetyError("PROCESS_RESTART_DRIVER_REQUIRED");
}

class PassiveReadOnlySession implements HilReadOnlySession {
  private readonly transport: BioUsbTransport;
  private readonly observations: HilDiscoveredDevice[] = [];
  private readonly unsubscribe: () => void;

  constructor() {
    this.transport = new BioUsbTransport({
      profile: "android-v1.2.0",
      protocol: "crc16",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      connectionFactory: () => new BioDirectUsbConnection(),
      validateReadiness: async (frame) => {
        if (decodeBioResponse(frame).kind !== "probe") throw new BioUsbError("READINESS", "BIO GET_NWK response was invalid");
      }
    });
    this.unsubscribe = this.transport.onNotification((frame) => {
      const observation = decodePassiveHilObservation(frame);
      if (observation) this.observations.push(observation);
    });
  }

  async discover(signal?: AbortSignal): Promise<HilDiscoveredDevice[]> {
    await this.transport.start();
    await controlledHilDelay(PASSIVE_DISCOVERY_MS, signal);
    return this.observations.map((device) => ({ ...device }));
  }

  async close(): Promise<void> {
    this.unsubscribe();
    await this.transport.stop();
  }
}

class ProductWritableSession implements HilWritableSession {
  private client: BioDongleClient;
  private readonly mappings: BioDeviceMappingStore;
  private reservedDeviceUuid?: string;

  constructor(mappingPath: string) {
    if (mappingPath === "/var/lib/led-control/bio-device-mappings.json") throw new HilSafetyError("PRODUCTION_MAPPING_FORBIDDEN");
    this.mappings = new BioDeviceMappingStore(mappingPath);
    this.client = this.createClient();
  }

  async discoverFresh(signal?: AbortSignal): Promise<HilDiscoveredDevice[]> {
    await this.client.probe();
    // [확인됨] HIL gate에서는 UUID별 마지막 report로 합쳐진 product scan을 쓰면 같은 UUID의
    // 상충 address/network가 사라진다. 성공한 한 scan window의 전체 검증 관측을 넘겨
    // selectExactlyOne이 dedupe 전에 duplicate/collision을 거부하게 한다.
    return (await this.client.scanObservations({ signal })).map(fromClientDevice);
  }

  async reserveTemporaryMapping(device: HilDiscoveredDevice, newAddress: number): Promise<void> {
    const deviceUuid = `bio:${device.nativeUuid}`;
    this.reservedDeviceUuid = deviceUuid;
    await this.mappings.reserve({
      fixtureId: randomUUID(), nodeId: randomUUID(), deviceUuid, nativeUuid: device.nativeUuid,
      logicalAddress: newAddress, observedLogicalAddressBeforeAssignment: device.logicalAddress,
      commandId: randomUUID(), firmware: device.firmwareVersion, protocol: "bio-direct-usb-v1"
    });
  }

  assignAddressOnce(
    device: HilDiscoveredDevice,
    newAddress: number,
    control: { signal?: AbortSignal; onWriteStarted?: () => void } = {}
  ): Promise<BioAddressAssignmentResult> {
    return this.client.assignAddressOnce(device.nativeUuid, newAddress, control);
  }

  async confirmTemporaryMapping(device: HilDiscoveredDevice): Promise<void> {
    if (!this.reservedDeviceUuid) throw new HilSafetyError("TEMP_MAPPING_NOT_RESERVED");
    await this.mappings.confirm(this.reservedDeviceUuid, device.logicalAddress);
  }

  async readState(device: HilDiscoveredDevice, signal?: AbortSignal): Promise<{ brightnessPercent: number | null; mode: BioControlMode }> {
    const target = verifiedTarget(device);
    const brightness = await this.client.readBrightness(target, { signal });
    const mode = await this.client.readDeviceInfo(target, { signal });
    return { brightnessPercent: brightness.brightnessPercent, mode: mode.mode };
  }

  async setOutput(
    device: HilDiscoveredDevice,
    percent: number,
    control: { signal?: AbortSignal; onWriteStarted?: () => void } = {}
  ): Promise<void> {
    await this.client.setOutput(verifiedTarget(device), percent, control);
  }

  async restoreSensorMode(device: HilDiscoveredDevice, control: { deadlineAt?: number } = {}): Promise<void> {
    // [확인됨] cancellation로 descriptor 세대가 폐기됐을 수 있으므로 public client 복귀 API가
    // fresh converter/GET_NWK readiness를 먼저 기다린다. 호출자 작업의 aborted signal은 넘기지
    // 않고 cleanup 전용 deadline만 사용한다. [미확인] recovery를 증명하지 못하면 sensor 상태나
    // USB driver 재부착을 성공으로 보고하지 않고 오류를 cleanup 결과에 보존한다.
    await this.client.restoreSensorMode(verifiedTarget(device), control);
  }

  close(): Promise<void> { return this.client.close(); }

  private createClient() {
    // [확인됨] CLI의 10초 cleanup gate보다 transport descriptor retirement를 먼저
    // terminal 상태로 만든다. 이 3초는 성공으로 간주하는 시간이 아니라, 미완료 시
    // CLOSE_FAILED/영구 write 차단으로 전환하는 상한이다. [미확인] timeout이 난 native
    // release/reattach 단계는 완료됐다고 기록하지 않는다.
    return new BioDongleClient({
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retirementTimeoutMs: DEFAULT_TIMEOUT_MS,
      scanDurationMs: PASSIVE_DISCOVERY_MS
    });
  }
}

function parseArguments(args: string[]): HilOptions {
  if (args.length === 0) throw new HilSafetyError("INVALID_ARGUMENTS");
  const mode = args[0] === "--dry-run" ? "dry-run" : args[0] === "--execute" ? "execute" : undefined;
  if (!mode) throw new HilSafetyError("INVALID_ARGUMENTS");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value || values.has(name)) throw new HilSafetyError("INVALID_ARGUMENTS");
    const allowed = mode === "dry-run"
      ? name === "--new-address"
      : ["--fingerprint", "--old-address", "--new-address", "--confirm-address-change"].includes(name);
    if (!allowed) throw new HilSafetyError("INVALID_ARGUMENTS");
    values.set(name, value);
  }
  if (mode === "dry-run") {
    return values.has("--new-address")
      ? { mode, newAddress: parseAddress(values.get("--new-address")!) }
      : { mode };
  }
  if (values.size !== 4) throw new HilSafetyError("INVALID_ARGUMENTS");
  const fingerprint = values.get("--fingerprint")!;
  if (!/^sha256:[0-9a-f]{16}$/.test(fingerprint)) throw new HilSafetyError("INVALID_ARGUMENTS");
  return {
    mode,
    fingerprint,
    oldAddress: parseAddress(values.get("--old-address")!),
    newAddress: parseAddress(values.get("--new-address")!),
    confirmation: values.get("--confirm-address-change")!
  };
}

function selectExactlyOne(observations: HilDiscoveredDevice[]): HilDiscoveredDevice {
  const byUuid = new Map<string, HilDiscoveredDevice>();
  for (const value of observations) {
    validateDevice(value);
    const previous = byUuid.get(value.nativeUuid);
    if (previous && (previous.logicalAddress !== value.logicalAddress || previous.networkId !== value.networkId)) {
      throw new HilSafetyError("BIO_DUPLICATE_UUID");
    }
    byUuid.set(value.nativeUuid, value);
  }
  const unique = [...byUuid.values()];
  const addresses = new Set<number>();
  for (const value of unique) {
    if (addresses.has(value.logicalAddress)) throw new HilSafetyError("BIO_ADDRESS_CONFLICT");
    addresses.add(value.logicalAddress);
  }
  if (unique.length === 0) throw new HilSafetyError("BIO_DEVICE_NOT_FOUND");
  if (unique.length !== 1) throw new HilSafetyError("BIO_MULTIPLE_DEVICES");
  return { ...unique[0] };
}

function verifyConfirmation(options: Extract<HilOptions, { mode: "execute" }>, observed: HilDiscoveredDevice, fingerprint: string) {
  const oldAddress = formatAddress(observed.logicalAddress);
  const newAddress = formatAddress(options.newAddress);
  if (options.fingerprint !== fingerprint || options.oldAddress !== observed.logicalAddress
    || options.confirmation !== confirmationLiteral(fingerprint, oldAddress, newAddress)) {
    throw new HilSafetyError("CONFIRMATION_MISMATCH");
  }
  assertAvailableNewAddress(observed, options.newAddress);
}

function assertSameFreshDevice(expected: HilDiscoveredDevice, fresh: HilDiscoveredDevice) {
  if (expected.nativeUuid !== fresh.nativeUuid || expected.logicalAddress !== fresh.logicalAddress
    || expected.networkId !== fresh.networkId) throw new HilSafetyError("FRESH_DISCOVERY_MISMATCH");
}

function assertAvailableNewAddress(device: HilDiscoveredDevice, newAddress: number) {
  if (newAddress === device.logicalAddress) throw new HilSafetyError("BIO_ADDRESS_CONFLICT");
}

function safeRestoreTargetsFromError(
  error: unknown,
  target: HilDiscoveredDevice,
  newAddress: number
): HilDiscoveredDevice[] {
  if (!(error instanceof BioAddressConflictError)) return [];
  return validateSafeRestoreTargets(error.safeRestoreDevices, target, newAddress);
}

function validateSafeRestoreTargets(
  candidates: unknown[],
  target: HilDiscoveredDevice,
  newAddress: number
): HilDiscoveredDevice[] {
  const unique = new Map<string, HilDiscoveredDevice>();
  for (const candidate of candidates) {
    if (!isHilDiscoveredDevice(candidate) || candidate.nativeUuid !== target.nativeUuid
      || (candidate.logicalAddress !== target.logicalAddress && candidate.logicalAddress !== newAddress)) continue;
    validateDevice(candidate);
    unique.set(`${candidate.logicalAddress}:${candidate.networkId}`, {
      nativeUuid: candidate.nativeUuid,
      logicalAddress: candidate.logicalAddress,
      networkId: candidate.networkId,
      firmwareVersion: candidate.firmwareVersion,
      rssi: candidate.rssi
    });
  }
  return [...unique.values()];
}

function isHilDiscoveredDevice(value: unknown): value is HilDiscoveredDevice {
  return Boolean(value && typeof value === "object"
    && "nativeUuid" in value && typeof value.nativeUuid === "string"
    && "logicalAddress" in value && typeof value.logicalAddress === "number"
    && "networkId" in value && typeof value.networkId === "number"
    && "firmwareVersion" in value && typeof value.firmwareVersion === "string"
    && "rssi" in value && typeof value.rssi === "number");
}

function validateDevice(value: HilDiscoveredDevice) {
  fingerprintBioUuid(value.nativeUuid);
  validateAddress(value.logicalAddress);
  if (!Number.isInteger(value.networkId) || value.networkId < 0 || value.networkId > 0xffff) {
    throw new HilSafetyError("BIO_INVALID_NETWORK");
  }
}

function parseAddress(value: string): number {
  if (!/^0x[0-7][0-9a-f]{3}$/.test(value)) throw new HilSafetyError("INVALID_ARGUMENTS");
  const address = Number.parseInt(value.slice(2), 16);
  validateAddress(address);
  return address;
}

function validateAddress(value: number) {
  if (!Number.isInteger(value) || value < 0x0001 || value > 0x7fff) throw new HilSafetyError("BIO_INVALID_ADDRESS");
}

function formatAddress(value: number) { return `0x${value.toString(16).padStart(4, "0")}`; }
function confirmationLiteral(fingerprint: string, oldAddress: string, newAddress: string) {
  return `CHANGE:${fingerprint}:${oldAddress}->${newAddress}`;
}

/**
 * [확인됨] transport가 여기까지 전달한 CRC16 frame은 outer checksum/길이를 이미 검증했다.
 * outer `0x12` 공통 LampHeader에서 byte 1..6은 UUID, 9..10은 source/current address,
 * 13..14는 network ID이고 두 16-bit 값은 big-endian이다. Task 3 실장비는 scan 명령 없이
 * payload 16-byte `0x12`를 반복 송신했으므로 이 공통 header만 passive identity로 사용한다.
 * [추정] byte 15 이후의 inner opcode가 discovery가 아니어도 header identity는 동일하다.
 * [미확인] 이 짧은 알림에는 firmware 의미가 확인되지 않았으므로 값을 만들지 않고
 * `unreported`로 둔다. raw UUID/header/payload 자체는 어떤 출력에도 전달하지 않는다.
 */
export function decodePassiveHilObservation(frame: BioFrame): HilDiscoveredDevice | null {
  if (frame.protocol !== "crc16" || frame.command !== 0x12 || frame.payload.length < 15) return null;
  const payload = frame.payload;
  return {
    nativeUuid: payload.subarray(1, 7).toString("hex"),
    logicalAddress: payload.readUInt16BE(9),
    networkId: payload.readUInt16BE(13),
    firmwareVersion: "unreported",
    rssi: payload.readInt8(0)
  };
}

function fromClientDevice(device: BioDiscoveredDevice): HilDiscoveredDevice {
  return {
    nativeUuid: device.nativeUuid, logicalAddress: device.logicalAddress, networkId: device.networkId,
    firmwareVersion: device.firmwareVersion, rssi: device.rssi
  };
}

function verifiedTarget(device: HilDiscoveredDevice): BioVerifiedLampTarget {
  return { kind: "unicast", nativeUuid: device.nativeUuid, logicalAddress: device.logicalAddress, networkId: device.networkId };
}

async function defaultCreateTemporaryMapping(): Promise<TemporaryMappingLocation> {
  const directory = await mkdtemp(join(tmpdir(), "bio-registration-hil-"));
  return { directory, path: join(directory, "mappings.json") };
}

async function defaultRemoveTemporaryMapping(location: TemporaryMappingLocation): Promise<void> {
  await rm(location.directory, { recursive: true, force: true });
}

function assertTemporaryMappingLocation(location: TemporaryMappingLocation) {
  const directory = resolve(location.directory);
  const path = resolve(location.path);
  if (!basename(directory).startsWith("bio-registration-hil-")
    || dirname(path) !== directory || basename(path) !== "mappings.json") {
    throw new HilSafetyError("TEMP_MAPPING_PATH_FORBIDDEN");
  }
}

async function defaultConfirmVisualStep(percent: number, signal: AbortSignal): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(`${percent}% 육안 반응을 확인했으면 YES를 입력하세요: `, { signal })) === "YES";
  } finally {
    prompt.close();
  }
}

function installSignalCancellation(controller: AbortController): () => void {
  // [확인됨] listener가 등록된 동안 Node의 기본 SIGINT/SIGTERM 즉시 종료는 비활성화된다.
  // 첫 signal은 새 작업/visual wait를 취소하고, 반복 signal도 같은 AbortController만 갱신해
  // sensor restore, client close, 임시 mapping cleanup의 finally를 건너뛰지 못한다.
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  return () => {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  };
}

function controlledHilDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("HIL cancelled", "AbortError")); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(new DOMException("HIL cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function throwIfHilCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("HIL cancelled", "AbortError");
}

function errorCode(error: unknown): string {
  if (error instanceof AggregateError) return "AGGREGATE_ERROR";
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "HIL_FAILED";
}

function flattenErrorCodes(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(flattenErrorCodes);
  return [errorCode(error)];
}

async function runPreservingPrimaryAndRestore(
  action: () => Promise<void>,
  restore: () => Promise<void>,
  cleanupTimeoutMs: number
): Promise<void> {
  let primary: unknown;
  try { await action(); } catch (error) { primary = error; }
  let restoreFailure: unknown;
  try { await boundedCleanup(restore, cleanupTimeoutMs, "RESTORE_TIMEOUT"); }
  catch (error) { restoreFailure = error; }
  if (primary !== undefined && restoreFailure !== undefined) {
    throw new AggregateError([primary, restoreFailure], "BIO action and sensor restore failed");
  }
  if (primary !== undefined) throw primary;
  if (restoreFailure !== undefined) throw restoreFailure;
}

async function boundedCleanup(
  action: () => Promise<void>,
  timeoutMs: number,
  timeoutCode: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HilSafetyError(timeoutCode)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asTemporaryCleanupFailure(error: unknown): unknown {
  if (errorCode(error) === "TEMP_CLEANUP_FAILED") return error;
  return Object.assign(new HilSafetyError("TEMP_CLEANUP_FAILED"), { cause: error });
}

function outputFailure(
  output: (line: string) => void,
  failures: unknown[],
  temporaryMapping?: "RETAINED" | "REMOVED"
) {
  const errors = failures.flatMap(flattenErrorCodes);
  output(JSON.stringify({ status: "FAILED", errors, ...(temporaryMapping ? { temporaryMapping } : {}) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBioRegistrationHil(process.argv.slice(2));
}
