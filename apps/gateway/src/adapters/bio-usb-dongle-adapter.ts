import type {
  IdentifyDevicePayload,
  MeshGroupSubscriptionResultPayload,
  MeshGroupSubscriptionSyncPayload,
  ProvisionDevicePayload,
  ProvisioningCompletedPayload,
  ProvisioningScanFoundDevice,
  ProvisioningScanStartPayload
} from "@led-control/shared";
import type {
  BleMeshAdapter,
  BleMeshCommandReport,
  BleMeshFixtureStatus,
  BleMeshGroupSnapshot,
  BleMeshLightingObservation,
  BleMeshResyncReport,
  ProvisioningAdapter,
  ProvisioningScannerAdapter
} from "../gateway";
import type {
  BioAddressAssignmentResult,
  BioDiscoveredDevice,
  BioDongleClient,
  BioVerifiedLampTarget
} from "../bio/bio-dongle-client";
import type {
  BioDeviceMapping,
  BioDeviceMappingInput,
  BioDeviceMappingStore
} from "../bio/bio-device-mapping-store";
import { BioUsbError } from "../bio/bio-usb-error";
import { SerialTaskQueue } from "../runtime/serial-task-queue";

const BIO_DEVICE_UUID = /^bio:[0-9a-f]{12}$/;
const BIO_GROUP_UNICAST_CONCURRENCY = 4;

type BioClientPort = Pick<BioDongleClient,
  "scan" | "startIdentify" | "stopIdentify" | "assignAddress" | "reconcileAddress" | "setOutput">;
type BioMappingPort = Pick<BioDeviceMappingStore,
  "findByDeviceUuidIncludingReserved" | "reserve" | "confirm" | "findByFixtureId" |
  "findByLogicalAddress" | "listConfirmed">;
type DurableProvisioningCommand = ProvisionDevicePayload & { commandId: string };

/**
 * BIO direct-USB client를 기존 등록/조명 제어 port에 연결한다.
 *
 * - [확인됨] adapter identity는 canonical lowercase `bio:<12-hex>`만 소유한다. DFK UUID
 *   판정은 BlueZ adapter에 남겨 서로의 장치를 전역 규칙으로 위장하지 않는다.
 * - [확인됨] 새 등록은 scan cache target의 2초 identify와 sensor 복귀가 끝난 뒤에만
 *   reservation → UUID address write → same UUID/new address 재관측 → confirm 순서로 간다.
 * - [추정] durable accepted 재시작에서 confirmed row는 write 없이 수렴하고 reserved row는
 *   저장된 old/new 주소 reconciliation으로만 판단한다. 불명 상태를 새 write로 추정하지 않는다.
 * - [확인됨] BIO group은 native RF subscription/broadcast가 아니라 confirmed mapping의 local
 *   virtual membership이다. group 제어는 hard limit 4의 unicast이고 native group 성공을 말하지 않는다.
 * - [확인됨] outer ACK는 fixture state가 아니다. `setOutput`이 UUID/address read-back까지
 *   검증한 경우만 acknowledged/applied이고 mismatch는 실제 brightness/raw/mode만 보존한다.
 *   BIO power는 exact force-on/off에서만 확정하며 sensor/누락 mode를 brightness로 추정하지 않는다.
 * - [미확인] 이 software integration의 실제 주소/밝기 동작은 Task 9 HIL 전까지 미확인이다.
 */
export class BioUsbDongleAdapter implements BleMeshAdapter, ProvisioningScannerAdapter, ProvisioningAdapter {
  readonly vehicleSensorCloudSupported = false;
  private readonly now: () => Date;
  private readonly discoveredByUuid = new Map<string, BioDiscoveredDevice>();
  private readonly virtualGroups = new Map<number, Set<string>>();
  private readonly discoveryQueue = new SerialTaskQueue();

  constructor(
    private readonly client: BioClientPort,
    private readonly mappings: BioMappingPort,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  acceptsDeviceUuid(deviceUuid: string) {
    return BIO_DEVICE_UUID.test(deviceUuid);
  }

  async scan(_command: ProvisioningScanStartPayload): Promise<ProvisioningScanFoundDevice[]> {
    const devices = await this.refreshDiscovery();
    return devices
      .filter((device) => this.acceptsDeviceUuid(device.deviceUuid))
      .map((device) => ({
        deviceUuid: device.deviceUuid,
        serialNumber: device.deviceUuid,
        rssi: device.rssi,
        oobCapability: "none" as const,
        firmwareVersion: device.firmwareVersion
      }));
  }

  async identify(command: IdentifyDevicePayload) {
    requireBioUuid(command.deviceUuid);
    await this.client.startIdentify(command.deviceUuid);
  }

  async provision(command: ProvisionDevicePayload): Promise<ProvisioningCompletedPayload> {
    const durable = requireDurableCommand(command);
    const logicalAddress = parseBioMeshAddress(command.meshAddress);
    requireBioUuid(command.deviceUuid);
    const existing = await this.mappings.findByDeviceUuidIncludingReserved(command.deviceUuid);
    if (existing) return this.recoverProvisioning(durable);

    // identify의 성공 반환은 정확히 2초 force-on 뒤 sensor-mode report까지 확인됐다는 client 계약이다.
    const identified = await this.client.startIdentify(command.deviceUuid);
    await this.mappings.reserve({
      fixtureId: command.nodeId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      nativeUuid: identified.nativeUuid,
      logicalAddress,
      observedLogicalAddressBeforeAssignment: identified.logicalAddress,
      commandId: durable.commandId,
      firmware: identified.firmwareVersion,
      protocol: "crc16"
    });
    const assigned = await this.client.assignAddress(identified.nativeUuid, logicalAddress);
    const confirmed = requireConfirmedAssignment(assigned);
    assertSameDeviceAtAddress(command.deviceUuid, logicalAddress, confirmed);
    await this.mappings.confirm(command.deviceUuid, logicalAddress);
    this.remember(confirmed);
    return completed(command, confirmed.firmwareVersion, confirmed.rssi, this.now());
  }

  async recoverProvisioning(command: ProvisionDevicePayload): Promise<ProvisioningCompletedPayload> {
    const durable = requireDurableCommand(command);
    const logicalAddress = parseBioMeshAddress(command.meshAddress);
    requireBioUuid(command.deviceUuid);
    const mapping = await this.mappings.findByDeviceUuidIncludingReserved(command.deviceUuid);
    assertSameMapping(durable, logicalAddress, mapping);
    if (mapping.status === "confirmed") {
      return completed(command, mapping.firmware, null, this.now());
    }

    const reconciled = await this.client.reconcileAddress(
      mapping.nativeUuid,
      requireOldAddress(mapping),
      logicalAddress
    );
    const confirmed = requireConfirmedAssignment(reconciled);
    assertSameDeviceAtAddress(command.deviceUuid, logicalAddress, confirmed);
    await this.mappings.confirm(command.deviceUuid, logicalAddress);
    this.remember(confirmed);
    return completed(command, confirmed.firmwareVersion, confirmed.rssi, this.now());
  }

  async setAttention(fixtureId: string, expiresAt: number, action: "start" | "stop", signal?: AbortSignal) {
    const control = { signal, deadlineAt: expiresAt };
    throwIfExpired(control);
    const mapping = await this.mappings.findByFixtureId(fixtureId);
    throwIfExpired(control);
    if (!mapping) throw new Error("fixture_not_registered");
    await this.requireDiscovered(mapping, control);
    throwIfExpired(control);
    if (action === "start") await this.client.startIdentify(mapping.deviceUuid, { signal, deadlineAt: expiresAt });
    else await this.client.stopIdentify(mapping.deviceUuid);
    return action === "start" ? 2 : 0;
  }

  async setBrightness(fixtureIds: string[], brightness: number) {
    return mapWithConcurrency(fixtureIds, 1, (fixtureId) => this.applyUnicast(fixtureId, brightness));
  }

  async applyUnicast(
    fixtureId: string,
    brightness: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<BleMeshCommandReport> {
    if (expired(signal, deadlineAt)) return failed(fixtureId, undefined, "command_expired", "timed_out");
    const mapping = await this.mappings.findByFixtureId(fixtureId);
    if (!mapping) return failed(fixtureId, undefined, "fixture_not_registered");
    let device: BioDiscoveredDevice | undefined;
    try {
      device = await this.requireDiscovered(mapping, { signal, deadlineAt });
      if (expired(signal, deadlineAt)) return failed(fixtureId, undefined, "command_expired", "timed_out", device.rssi);
      const outputTarget = target(device, mapping.logicalAddress);
      const observed = signal || deadlineAt !== undefined
        ? await this.client.setOutput(outputTarget, brightness, { signal, deadlineAt })
        : await this.client.setOutput(outputTarget, brightness);
      if (expired(signal, deadlineAt)) {
        return failed(fixtureId, undefined, "command_expired", "timed_out", device.rssi);
      }
      return {
        fixtureId,
        acknowledged: true,
        outcome: "applied",
        brightness: observed.brightnessPercent,
        mode: observed.mode,
        rssi: device.rssi,
        hopCount: null
      };
    } catch (error) {
      if (expired(signal, deadlineAt)) {
        return failed(fixtureId, undefined, "command_expired", "timed_out", device?.rssi ?? null);
      }
      const observation = readbackObservation(error);
      return {
        ...failed(fixtureId, observation.brightness, errorCode(error), "failed", device?.rssi ?? null),
        ...(observation.rawBrightness === undefined ? {} : { rawBrightness: observation.rawBrightness }),
        ...(observation.mode ? { mode: observation.mode } : {})
      };
    }
  }

  async applyParallelUnicast(
    fixtureIds: string[],
    brightness: number,
    concurrency = BIO_GROUP_UNICAST_CONCURRENCY,
    signal?: AbortSignal,
    deadlineAt?: number
  ) {
    // [확인됨] 상위 handler가 8을 요청해도 BIO wire는 global correlation 제약이 있으므로
    // 모든 multi-unicast 진입점에서 hard maximum 4를 다시 강제한다.
    return mapWithConcurrency(fixtureIds, Math.min(positiveConcurrency(concurrency), BIO_GROUP_UNICAST_CONCURRENCY),
      (fixtureId) => this.applyUnicast(fixtureId, brightness, signal, deadlineAt));
  }

  async applyMeshGroup(
    groupAddress: number,
    fixtureIds: string[],
    brightness: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ) {
    requireGroupAddress(groupAddress);
    const members = this.virtualGroups.get(groupAddress);
    if (!members || fixtureIds.some((fixtureId) => !members.has(fixtureId))) {
      return fixtureIds.map((fixtureId) => failed(fixtureId, undefined, "bio_virtual_group_not_ready"));
    }
    // BIO firmware native group 적용을 가장하지 않는다. local membership의 각 confirmed fixture만
    // 정확히 4개 worker에서 개별 UUID/address read-back 제어한다.
    return mapWithConcurrency(fixtureIds, BIO_GROUP_UNICAST_CONCURRENCY,
      (fixtureId) => this.applyUnicast(fixtureId, brightness, signal, deadlineAt));
  }

  async syncGroupSubscriptions(
    command: MeshGroupSubscriptionSyncPayload,
    appliedMembers?: MeshGroupSubscriptionSyncPayload["desiredMembers"]
  ): Promise<MeshGroupSubscriptionResultPayload> {
    const groupAddress = parseGroupAddress(command.groupAddress);
    const current = appliedMembers === undefined
      ? new Set(this.virtualGroups.get(groupAddress) ?? [])
      : await this.confirmedFixtureSet(appliedMembers);
    const operations: MeshGroupSubscriptionResultPayload["operations"] = [];
    for (const operation of command.expectedOperations) {
      const address = parseBioMeshAddress(operation.meshAddress);
      const mapping = await this.mappings.findByLogicalAddress(address);
      if (!mapping || mapping.nodeId !== operation.meshNodeId) {
        operations.push({ ...operation, status: "failed", error: "bio_mapping_not_confirmed" });
        continue;
      }
      if (operation.action === "add") current.add(mapping.fixtureId);
      else current.delete(mapping.fixtureId);
      operations.push({ ...operation, status: "ready" });
    }
    this.virtualGroups.set(groupAddress, current);
    return {
      siteId: command.siteId,
      gatewayId: command.gatewayId,
      groupId: command.groupId,
      version: command.version,
      groupAddress: command.groupAddress,
      operations,
      occurredAt: this.now().toISOString()
    };
  }

  async hydrateGroupSubscriptions(snapshots: BleMeshGroupSnapshot[]) {
    // [확인됨] restart hydration은 durable ready snapshot을 local virtual membership으로만
    // 복원한다. native subscription을 보내거나 성공으로 가장하지 않고 confirmed mapping만 남긴다.
    this.virtualGroups.clear();
    for (const snapshot of snapshots) {
      const groupAddress = parseGroupAddress(snapshot.groupAddress);
      this.virtualGroups.set(groupAddress, await this.confirmedFixtureSet(snapshot.members));
    }
  }

  onFixtureStatus(_listener: (status: BleMeshFixtureStatus) => void) { return () => undefined; }
  onLightingObservation(_listener: (observation: BleMeshLightingObservation) => void) { return () => undefined; }

  async resyncFixtureStates(_signal?: AbortSignal): Promise<BleMeshResyncReport> {
    const mappings = await this.mappings.listConfirmed();
    return unobservedResync(mappings.length);
  }

  async resyncLightingFixtures(fixtureIds: string[], _signal?: AbortSignal): Promise<BleMeshResyncReport> {
    return unobservedResync(fixtureIds.length);
  }

  private refreshDiscovery(control: { signal?: AbortSignal; deadlineAt?: number } = {}) {
    // [확인됨] discovery refresh를 caller 간 공유하지 않는다. 각 caller는 serial queue에서
    // 자기 cancellation/deadline을 다시 검사하고 자기 scan만 소유하므로 한 caller 취소가
    // 독립 caller의 refresh를 함께 실패시키지 않는다.
    return this.discoveryQueue.run(async () => {
      throwIfExpired(control);
      const devices = await this.client.scan(control);
      throwIfExpired(control);
      this.discoveredByUuid.clear();
      for (const device of devices) if (this.acceptsDeviceUuid(device.deviceUuid)) this.remember(device);
      return devices.map((device) => ({ ...device }));
    });
  }

  private async requireDiscovered(
    mapping: BioDeviceMapping,
    control: { signal?: AbortSignal; deadlineAt?: number } = {}
  ) {
    throwIfExpired(control);
    let device = this.discoveredByUuid.get(mapping.deviceUuid);
    if (!device || device.logicalAddress !== mapping.logicalAddress) {
      await this.refreshDiscovery(control);
      throwIfExpired(control);
      device = this.discoveredByUuid.get(mapping.deviceUuid);
    }
    if (!device || device.logicalAddress !== mapping.logicalAddress) {
      throw new BioUsbError("BIO_DEVICE_NOT_FOUND", "Confirmed BIO UUID/address was not rediscovered");
    }
    return { ...device };
  }

  private remember(device: BioDiscoveredDevice) {
    this.discoveredByUuid.set(device.deviceUuid, { ...device });
  }

  private async confirmedFixtureSet(members: MeshGroupSubscriptionSyncPayload["desiredMembers"]) {
    const fixtures = new Set<string>();
    for (const member of members) {
      const mapping = await this.mappings.findByLogicalAddress(parseBioMeshAddress(member.meshAddress));
      if (mapping?.nodeId === member.meshNodeId) fixtures.add(mapping.fixtureId);
    }
    return fixtures;
  }
}

function requireDurableCommand(command: ProvisionDevicePayload): DurableProvisioningCommand {
  if (!("commandId" in command) || typeof command.commandId !== "string" || command.commandId.length === 0) {
    throw new Error("BIO provisioning requires a durable commandId");
  }
  return command as DurableProvisioningCommand;
}

function requireBioUuid(deviceUuid: string) {
  if (!BIO_DEVICE_UUID.test(deviceUuid)) throw new Error("Invalid BIO device UUID");
}

function parseBioMeshAddress(value: string) {
  if (!/^0x[0-7][0-9a-f]{3}$/i.test(value)) throw new RangeError("Invalid BIO mesh address");
  const address = Number.parseInt(value.slice(2), 16);
  if (address < 0x0001 || address > 0x7fff) throw new RangeError("Invalid BIO mesh address");
  return address;
}

function parseGroupAddress(value: string) {
  if (!/^0x[0-9a-f]{4}$/i.test(value)) throw new RangeError("Invalid BIO virtual group address");
  const address = Number.parseInt(value.slice(2), 16);
  requireGroupAddress(address);
  return address;
}

function requireGroupAddress(value: number) {
  if (!Number.isInteger(value) || value < 0xc000 || value > 0xfeff) throw new RangeError("Invalid BIO virtual group address");
}

function assertSameMapping(command: DurableProvisioningCommand, address: number, mapping: BioDeviceMapping | null): asserts mapping is BioDeviceMapping {
  if (!mapping || mapping.fixtureId !== command.nodeId || mapping.nodeId !== command.nodeId ||
    mapping.deviceUuid !== command.deviceUuid || mapping.logicalAddress !== address ||
    (mapping.commandId !== undefined && mapping.commandId !== command.commandId)) {
    throw new Error("BIO provisioning mapping identity conflict");
  }
}

function requireOldAddress(mapping: BioDeviceMapping) {
  const address = mapping.observedLogicalAddressBeforeAssignment;
  if (!Number.isInteger(address) || address! < 1 || address! > 0x7fff) {
    throw new BioUsbError("BIO_ADDRESS_STATE_UNKNOWN", "BIO reservation has no safe old address");
  }
  return address!;
}

function requireConfirmedAssignment(result: BioAddressAssignmentResult) {
  if (result.outcome !== "confirmed") {
    throw new BioUsbError("BIO_ADDRESS_STATE_UNKNOWN", "BIO address assignment was not confirmed at the requested address");
  }
  return result.device;
}

function assertSameDeviceAtAddress(deviceUuid: string, address: number, device: BioDiscoveredDevice) {
  if (device.deviceUuid !== deviceUuid || device.logicalAddress !== address) {
    throw new BioUsbError("BIO_ADDRESS_STATE_UNKNOWN", "BIO UUID/address reconciliation did not match the reservation");
  }
}

function completed(command: ProvisionDevicePayload, firmwareVersion: string, rssi: number | null, now: Date): ProvisioningCompletedPayload {
  return {
    sessionId: command.sessionId,
    nodeId: command.nodeId,
    deviceUuid: command.deviceUuid,
    meshAddress: command.meshAddress,
    firmwareVersion,
    rssi,
    hopCount: null,
    completedAt: now.toISOString()
  };
}

function target(device: BioDiscoveredDevice, logicalAddress: number): BioVerifiedLampTarget {
  return { kind: "unicast", nativeUuid: device.nativeUuid, networkId: device.networkId, logicalAddress };
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "bio_control_failed";
}

function readbackObservation(error: unknown): {
  brightness?: number;
  rawBrightness?: number;
  mode?: "sensor" | "force-off" | "force-on";
} {
  if (!error || typeof error !== "object") return {};
  const row = error as { observedBrightnessPercent?: unknown; observedRawHighBrightness?: unknown; observedMode?: unknown };
  // [확인됨] table 밖 raw 또는 mode-only report는 실제 percent를 말하지 않는다. 요청값을
  // 관측값으로 대체하지 않고 brightness를 생략하며, 독립적으로 확인된 mode만 보존한다.
  const brightness = typeof row.observedBrightnessPercent === "number" ? row.observedBrightnessPercent : undefined;
  const rawBrightness = typeof row.observedRawHighBrightness === "number" ? row.observedRawHighBrightness : undefined;
  const mode = row.observedMode === "sensor" || row.observedMode === "force-off" || row.observedMode === "force-on"
    ? row.observedMode
    : undefined;
  return { brightness, rawBrightness, mode };
}

function failed(
  fixtureId: string,
  brightness: number | undefined,
  faultCode: string,
  outcome: "failed" | "timed_out" = "failed",
  rssi: number | null = null
): BleMeshCommandReport {
  return {
    fixtureId,
    acknowledged: false,
    outcome,
    ...(brightness === undefined ? {} : { brightness }),
    faultCode,
    rssi,
    hopCount: null
  };
}

function expired(signal?: AbortSignal, deadlineAt?: number) {
  return Boolean(signal?.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt));
}

function throwIfExpired(control: { signal?: AbortSignal; deadlineAt?: number }) {
  if (expired(control.signal, control.deadlineAt)) throw new Error("command_expired");
}

function positiveConcurrency(value: number) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError("Invalid BIO unicast concurrency");
  return value;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, run: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await run(values[index]!);
    }
  }));
  return results;
}

function unobservedResync(total: number): BleMeshResyncReport {
  return { total, configured: total, observed: 0, healthPending: 0, timedOut: 0, failed: total };
}
