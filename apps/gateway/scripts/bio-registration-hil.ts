import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { BioDeviceMappingStore } from "../src/bio/bio-device-mapping-store";
import {
  BioDongleClient,
  type BioAddressAssignmentResult,
  type BioDiscoveredDevice,
  type BioVerifiedLampTarget
} from "../src/bio/bio-dongle-client";
import { BioDirectUsbConnection } from "../src/bio/bio-direct-usb-connection";
import { decodeBioResponse, type BioControlMode } from "../src/bio/bio-command-codec";
import { BioUsbError } from "../src/bio/bio-usb-error";
import { BioUsbTransport } from "../src/bio/bio-usb-transport";

const DEFAULT_TIMEOUT_MS = 3_000;
const PASSIVE_DISCOVERY_MS = 5_000;
const OUTPUT_STEPS = [0, 20, 60, 90, 100] as const;

export interface HilDiscoveredDevice {
  nativeUuid: string;
  logicalAddress: number;
  networkId: number;
  firmwareVersion: string;
  rssi: number;
}

export interface HilReadOnlySession {
  discover(): Promise<HilDiscoveredDevice[]>;
  close(): Promise<void>;
}

export interface HilWritableSession {
  discoverFresh(): Promise<HilDiscoveredDevice[]>;
  reserveTemporaryMapping(device: HilDiscoveredDevice, newAddress: number): Promise<void>;
  assignAddressOnce(device: HilDiscoveredDevice, newAddress: number): Promise<BioAddressAssignmentResult>;
  confirmTemporaryMapping(device: HilDiscoveredDevice): Promise<void>;
  readState(device: HilDiscoveredDevice): Promise<{ brightnessPercent: number | null; mode: BioControlMode }>;
  setOutput(device: HilDiscoveredDevice, percent: number): Promise<void>;
  restoreSensorMode(device: HilDiscoveredDevice): Promise<void>;
  restartAndRecover(device: HilDiscoveredDevice): Promise<void>;
  close(): Promise<void>;
}

export interface TemporaryMappingLocation { directory: string; path: string }

export interface BioRegistrationHilDependencies {
  createReadOnlySession?: () => HilReadOnlySession;
  createWritableSession?: (mappingPath: string) => Promise<HilWritableSession>;
  createTemporaryMapping?: () => Promise<TemporaryMappingLocation>;
  removeTemporaryMapping?: (location: TemporaryMappingLocation) => Promise<void>;
  confirmVisualStep?: (percent: number) => Promise<boolean>;
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

  let observed: HilDiscoveredDevice;
  try {
    observed = await discoverReadOnly(dependencies);
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
  return executeWriteHil(options, observed, fingerprint, dependencies, output);
}

async function discoverReadOnly(dependencies: BioRegistrationHilDependencies): Promise<HilDiscoveredDevice> {
  // 별도 factory가 dry-run capability 경계다. 이 블록에서는 write-capable session을 참조하지 않는다.
  const session = dependencies.createReadOnlySession?.() ?? new PassiveReadOnlySession();
  let primary: unknown;
  let result: HilDiscoveredDevice | undefined;
  try {
    result = selectExactlyOne(await session.discover());
  } catch (error) {
    primary = error;
  }
  try {
    await session.close();
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
  output: (line: string) => void
): Promise<number> {
  const createTemporaryMapping = dependencies.createTemporaryMapping ?? defaultCreateTemporaryMapping;
  const removeTemporaryMapping = dependencies.removeTemporaryMapping ?? defaultRemoveTemporaryMapping;
  const confirmVisualStep = dependencies.confirmVisualStep ?? defaultConfirmVisualStep;
  let location: TemporaryMappingLocation | undefined;
  let writer: HilWritableSession | undefined;
  const failures: unknown[] = [];
  let target: HilDiscoveredDevice = observed;
  let finalRestoreTargets: HilDiscoveredDevice[] = [observed];

  try {
    const candidateLocation = await createTemporaryMapping();
    assertTemporaryMappingLocation(candidateLocation);
    location = candidateLocation;
    writer = await (dependencies.createWritableSession?.(location.path) ?? Promise.resolve(new ProductWritableSession(location.path)));
    const fresh = selectExactlyOne(await writer.discoverFresh());
    assertSameFreshDevice(observed, fresh);
    assertAvailableNewAddress(fresh, options.newAddress);
    await writer.reserveTemporaryMapping(fresh, options.newAddress);

    // [확인됨] 이 API는 address outer 0x10을 정확히 한 번만 생성한다. ACK 성공/실패/timeout은
    // 적용 판정이 아니며 이어지는 old/new scan 결과만 사용한다. old-only/unknown에는 재시도 없다.
    // [추정] write 뒤 판정 자체가 throw/unknown이면 실제 주소는 old/new 어느 쪽일 수도 있으므로
    // 종료 안전 복귀는 두 주소 모두 시도한다. 한 쪽 실패가 다른 후보 복귀를 막지 않는다.
    finalRestoreTargets = [fresh, { ...fresh, logicalAddress: options.newAddress }];
    const assignment = await writer.assignAddressOnce(fresh, options.newAddress);
    if (assignment.outcome === "unchanged") {
      finalRestoreTargets = [{ ...assignment.device }];
      throw new HilSafetyError("BIO_ADDRESS_STATE_UNKNOWN");
    }
    if (assignment.outcome === "unknown") throw new HilSafetyError("BIO_ADDRESS_STATE_UNKNOWN");
    target = { ...assignment.device };
    finalRestoreTargets = [target];
    await writer.confirmTemporaryMapping(target);
    await writer.readState(target);

    for (const percent of OUTPUT_STEPS) {
      try {
        await writer.setOutput(target, percent);
        if (!await confirmVisualStep(percent)) throw new HilSafetyError("VISUAL_CONFIRMATION_REJECTED");
      } finally {
        await writer.restoreSensorMode(target);
      }
    }
    await writer.restartAndRecover(target);
    try {
      await writer.setOutput(target, 20);
      if (!await confirmVisualStep(20)) throw new HilSafetyError("VISUAL_CONFIRMATION_REJECTED");
    } finally {
      await writer.restoreSensorMode(target);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (writer) {
      for (const restoreTarget of finalRestoreTargets) {
        try { await writer.restoreSensorMode(restoreTarget); } catch (error) { failures.push(error); }
      }
      try { await writer.close(); } catch (error) { failures.push(error); }
    }
    if (location) {
      try { await removeTemporaryMapping(location); } catch (error) { failures.push(error); }
    }
  }

  if (failures.length > 0) {
    outputFailure(output, failures, location ? "CLEANUP_UNCONFIRMED" : undefined,
      location && !failures.some((error) => errorCode(error) === "TEMP_CLEANUP_FAILED") ? "REMOVED" : undefined);
    return 1;
  }
  output(JSON.stringify({
    status: "HIL_WRITE_SEQUENCE_COMPLETED",
    fingerprint,
    oldAddress: formatAddress(observed.logicalAddress),
    newAddress: formatAddress(options.newAddress),
    networkId: formatAddress(observed.networkId),
    temporaryMapping: "REMOVED",
    multiDeviceGroup: "DEFERRED_INSUFFICIENT_HARDWARE"
  }));
  return 0;
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
      try {
        const response = decodeBioResponse(frame);
        if (response.kind === "discovery") this.observations.push(toHilDevice(response));
      } catch {
        // [확인됨] 손상되거나 미지원인 비동기 알림은 identity 후보가 아니다. payload를 기록하지 않는다.
      }
    });
  }

  async discover(): Promise<HilDiscoveredDevice[]> {
    await this.transport.start();
    await delay(PASSIVE_DISCOVERY_MS);
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

  async discoverFresh(): Promise<HilDiscoveredDevice[]> {
    await this.client.probe();
    return (await this.client.scan()).map(fromClientDevice);
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

  assignAddressOnce(device: HilDiscoveredDevice, newAddress: number): Promise<BioAddressAssignmentResult> {
    return this.client.assignAddressOnce(device.nativeUuid, newAddress);
  }

  async confirmTemporaryMapping(device: HilDiscoveredDevice): Promise<void> {
    if (!this.reservedDeviceUuid) throw new HilSafetyError("TEMP_MAPPING_NOT_RESERVED");
    await this.mappings.confirm(this.reservedDeviceUuid, device.logicalAddress);
  }

  async readState(device: HilDiscoveredDevice): Promise<{ brightnessPercent: number | null; mode: BioControlMode }> {
    const target = verifiedTarget(device);
    const brightness = await this.client.readBrightness(target);
    const mode = await this.client.readDeviceInfo(target);
    return { brightnessPercent: brightness.brightnessPercent, mode: mode.mode };
  }

  async setOutput(device: HilDiscoveredDevice, percent: number): Promise<void> {
    await this.client.setOutput(verifiedTarget(device), percent);
  }

  async restoreSensorMode(device: HilDiscoveredDevice): Promise<void> {
    const target = verifiedTarget(device);
    await this.client.setControlMode(target, "sensor");
    const report = await this.client.readDeviceInfo(target);
    if (report.mode !== "sensor") throw new BioUsbError("BIO_CONTROL_MODE_STATE_MISMATCH", "BIO sensor restore was not confirmed");
  }

  async restartAndRecover(device: HilDiscoveredDevice): Promise<void> {
    await this.client.close();
    this.client = this.createClient();
    const stored = await this.mappings.findByNativeUuid(device.nativeUuid);
    if (!stored || stored.logicalAddress !== device.logicalAddress) throw new HilSafetyError("TEMP_MAPPING_RECOVERY_FAILED");
    const fresh = selectExactlyOne(await this.discoverFresh());
    assertSameFreshDevice(device, fresh);
  }

  close(): Promise<void> { return this.client.close(); }

  private createClient() {
    return new BioDongleClient({ timeoutMs: DEFAULT_TIMEOUT_MS, scanDurationMs: PASSIVE_DISCOVERY_MS });
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

function toHilDevice(response: Extract<ReturnType<typeof decodeBioResponse>, { kind: "discovery" }>): HilDiscoveredDevice {
  return {
    nativeUuid: response.deviceUuid.slice(4), logicalAddress: response.logicalAddress,
    networkId: response.networkId,
    firmwareVersion: `${response.firmware.major}.${response.firmware.minor}.${response.firmware.revision}.${response.firmware.build}`,
    rssi: response.rssiDbm
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

async function defaultConfirmVisualStep(percent: number): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(`${percent}% 육안 반응을 확인했으면 YES를 입력하세요: `)) === "YES";
  } finally {
    prompt.close();
  }
}

function delay(milliseconds: number) { return new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }

function errorCode(error: unknown): string {
  if (error instanceof AggregateError) return "AGGREGATE_ERROR";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "HIL_FAILED";
}

function flattenErrorCodes(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(flattenErrorCodes);
  return [errorCode(error)];
}

function outputFailure(
  output: (line: string) => void,
  failures: unknown[],
  cleanupUnconfirmed?: "CLEANUP_UNCONFIRMED",
  cleanupConfirmed?: "REMOVED"
) {
  const errors = failures.flatMap(flattenErrorCodes);
  const temporaryMapping = errors.includes("TEMP_CLEANUP_FAILED") ? cleanupUnconfirmed : cleanupConfirmed;
  output(JSON.stringify({ status: "FAILED", errors, ...(temporaryMapping ? { temporaryMapping } : {}) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBioRegistrationHil(process.argv.slice(2));
}
