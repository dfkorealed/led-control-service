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
  BleMeshFixturePresence,
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
  "scan" | "startIdentify" | "stopIdentify" | "restoreSensorMode" | "assignAddressOnce" |
  "reconcileAddress" | "setOutput"> &
  Partial<Pick<BioDongleClient, "readBrightness" | "readDeviceInfo">>;
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
  private readonly lightingObservationListeners = new Set<(observation: BleMeshLightingObservation) => void>();
  private readonly fixturePresenceListeners = new Set<(presence: BleMeshFixturePresence) => Promise<void> | void>();

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

  /**
   * Gateway가 identify의 `force-on` 전송과 2초 뒤 `sensor` 복귀 사이에서 죽었을 때만
   * 사용하는 안전 복구 경로다.
   *
   * BIO의 제어 모드 패킷(명령 0x10)은 지속 상태를 바꾸므로 프로세스가 죽었다고 자동으로
   * sensor 모드로 돌아오지 않는다. 그렇다고 startIdentify를 다시 호출하면 사용자가 누르지
   * 않은 2초 점등이 한 번 더 발생한다. 따라서 새 scan(명령 0x01/응답 0x12)으로 동일한
   * `bio:<12-hex>` UUID의 현재 network/address를 다시 확인한 뒤, `sensor` 값(0x00)의
   * 제어 모드 패킷만 한 번 보내고 같은 UUID/address의 report까지 확인한다.
   *
   * scan에서 정확한 UUID를 찾지 못하면 다른 주소를 추측해 쓰지 않는다. 호출자는 이 복구의
   * 성공 여부와 무관하게 원래 identify 결과를 outcome-unknown으로 남겨야 한다. sensor 복귀는
   * 안전 조치이지, 중단된 식별 명령이 성공했다는 증거가 아니기 때문이다.
   */
  async recoverIdentifySafety(command: IdentifyDevicePayload): Promise<void> {
    requireBioUuid(command.deviceUuid);
    await this.refreshDiscovery();
    const device = this.discoveredByUuid.get(command.deviceUuid);
    if (!device) throw new BioUsbError("BIO_DEVICE_NOT_FOUND", "BIO identify recovery UUID was not rediscovered");
    await this.client.restoreSensorMode({ ...device });
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
    // 주소는 장치의 지속 식별자이므로 ACK 유실이나 old-address 재관측만으로 같은 write를
    // 자동 반복하지 않는다. assignAddressOnce는 실제 address frame을 최대 1회만 만들고,
    // 이어지는 UUID old/new scan 결과가 confirmed일 때만 mapping을 활성화한다. unchanged와
    // unknown은 상위 등록을 reconcile_required로 닫아 운영자가 현 상태를 다시 판단하게 한다.
    // 제조사 모듈이 allocator의 목표 주소를 이미 사용 중이면 주소 SET은 상태를 바꾸지
    // 않으며, 기존 old/new 배타 판정에서는 성공 증거도 만들 수 없다. 이 경우에는 같은
    // 주소를 다시 쓰지 않고 fresh scan 기반 reconciliation만 수행한다. client는 정확한
    // UUID가 목표 주소를 단독 점유하는 경우에만 confirmed를 반환하므로, DB 초기화 뒤
    // 재등록도 안전하게 수렴하면서 불필요한 비휘발성 주소 write를 피한다.
    const assigned = identified.logicalAddress === logicalAddress
      ? await this.client.reconcileAddress(identified.nativeUuid, logicalAddress, logicalAddress)
      : await this.client.assignAddressOnce(identified.nativeUuid, logicalAddress);
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
  onLightingObservation(listener: (observation: BleMeshLightingObservation) => void) {
    this.lightingObservationListeners.add(listener);
    return () => this.lightingObservationListeners.delete(listener);
  }

  onFixturePresence(listener: (presence: BleMeshFixturePresence) => Promise<void> | void) {
    this.fixturePresenceListeners.add(listener);
    return () => this.fixturePresenceListeners.delete(listener);
  }

  async resyncFixtureStates(signal?: AbortSignal): Promise<BleMeshResyncReport> {
    const mappings = await this.mappings.listConfirmed();
    return this.resyncConfirmedMappings(mappings, signal, false);
  }

  async resyncLightingFixtures(fixtureIds: string[], signal?: AbortSignal): Promise<BleMeshResyncReport> {
    const requested = new Set(fixtureIds);
    const mappings = (await this.mappings.listConfirmed()).filter((mapping) => requested.has(mapping.fixtureId));
    return this.resyncConfirmedMappings(mappings, signal, true);
  }

  private async resyncConfirmedMappings(
    mappings: BioDeviceMapping[],
    signal: AbortSignal | undefined,
    emitLightingObservation: boolean
  ): Promise<BleMeshResyncReport> {
    const report: BleMeshResyncReport = {
      total: mappings.length,
      configured: mappings.length,
      observed: 0,
      healthPending: 0,
      timedOut: 0,
      failed: 0
    };
    const failureCodes: Record<string, number> = {};
    if (signal?.aborted || mappings.length === 0) return report;

    try {
      await this.refreshDiscovery({ signal });
    } catch (error) {
      if (signal?.aborted) return report;
      if (isBioTimeout(error)) report.timedOut = mappings.length;
      else report.failed = mappings.length;
      addFailureCodes(failureCodes, error, mappings.length);
      return withFailureCodes(report, failureCodes);
    }

    // [확인됨] BIO 동글은 command별 독립 correlation ID가 아니라 전역 단일 response slot을 쓴다.
    // 따라서 다음 fixture의 GET을 먼저 보내면 직전 fixture의 늦은 0x12 report가 잘못 결합될 수 있다.
    // mapping마다 brightness GET → mode GET → durable listener 전달까지 반드시 완료한 뒤 다음 fixture로 진행한다.
    for (const mapping of mappings) {
      if (signal?.aborted) break;
      try {
        const device = this.requireExactDiscoveredMapping(mapping);
        const verifiedTarget = target(device, mapping.logicalAddress);
        const control = { signal };
        const client = this.requireReadOnlyClient();
        const brightness = await client.readBrightness(verifiedTarget, control);
        const mode = await client.readDeviceInfo(verifiedTarget, control);
        assertExactReadbackIdentity(mapping, device, brightness);
        assertExactReadbackIdentity(mapping, device, mode);
        const presence: BleMeshFixturePresence = {
          fixtureId: mapping.fixtureId,
          controlMode: mode.mode,
          rawHighBrightness: brightness.rawHighBrightness,
          configuredBrightness: brightness.brightnessPercent,
          rssi: device.rssi,
          hopCount: null,
          observedAt: this.now().toISOString()
        };

        // [확인됨] sensor mode의 high-brightness 값은 장치에 저장된 설정값이며 현재 LED 출력이 아니다.
        // sensor의 감지 결과로 실제 점등/소등이 달라질 수 있으므로 presence에는 보존하되 brightness/powerOn
        // 상태 관측으로 변환하지 않는다. force-on도 codec table에 없는 raw 값은 percent를 증명하지 못한다.
        await this.deliverPresence(presence);
        if (emitLightingObservation) await this.deliverLightingObservation(presence);
        report.observed += 1;
      } catch (error) {
        if (signal?.aborted) break;
        if (isBioTimeout(error)) report.timedOut += 1;
        else report.failed += 1;
        // resync report는 동일 실패가 여러 fixture에서 반복돼도 code별 횟수만 남긴다.
        // exception message에는 USB path/packet 값이 들어갈 수 있으므로 상위 health/log로
        // 전달하지 않는다. `errorCode`가 승인된 BioUsbError code 또는 일반 fallback만 만든다.
        addFailureCodes(failureCodes, error);
      }
    }
    return withFailureCodes(report, failureCodes);
  }

  private requireExactDiscoveredMapping(mapping: BioDeviceMapping) {
    const device = this.discoveredByUuid.get(mapping.deviceUuid);
    // [확인됨] confirmed mapping의 canonical BIO UUID, native UUID, logical address는 모두 동일한
    // 물리 lamp를 가리켜야 한다. UUID만 또는 address만 일치하는 discovery/readback은 주소 재사용·
    // stale scan·다른 lamp report일 수 있으므로 GET을 보내거나 presence로 승격하지 않는다.
    if (!device || device.deviceUuid !== mapping.deviceUuid || device.nativeUuid !== mapping.nativeUuid ||
      device.logicalAddress !== mapping.logicalAddress) {
      throw new BioUsbError("BIO_DEVICE_NOT_FOUND", "Confirmed BIO UUID/native UUID/address was not rediscovered");
    }
    return { ...device };
  }

  private requireReadOnlyClient(): Required<Pick<BioDongleClient, "readBrightness" | "readDeviceInfo">> {
    if (!this.client.readBrightness || !this.client.readDeviceInfo) {
      throw new BioUsbError("BIO_DEVICE_NOT_FOUND", "BIO client does not support read-only fixture observation");
    }
    return { readBrightness: this.client.readBrightness, readDeviceInfo: this.client.readDeviceInfo };
  }

  private async deliverPresence(presence: BleMeshFixturePresence) {
    for (const listener of this.fixturePresenceListeners) {
      try {
        await listener({ ...presence });
      } catch {
        // [확인됨] durable outbox consumer의 일시 오류는 USB transport 관측 실패가 아니다. 한 listener가
        // throw/reject해도 같은 fixture의 verified GET 결과와 다음 fixture의 serial polling을 무효화하지 않는다.
      }
    }
  }

  private async deliverLightingObservation(presence: BleMeshFixturePresence) {
    const observation = lightingObservationFromPresence(presence);
    if (!observation) return;
    for (const listener of this.lightingObservationListeners) {
      try {
        await listener({ ...observation });
      } catch {
        // [확인됨] legacy lighting observer도 transport observation과 분리된다. 수신자 예외가 GET 성공을
        // 실패로 바꾸면 retry가 write 없는 polling이라도 event 순서와 durable intake의 원인을 흐리게 한다.
      }
    }
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

function assertExactReadbackIdentity(
  mapping: BioDeviceMapping,
  device: BioDiscoveredDevice,
  report: { deviceUuid: string; networkId: number; logicalAddress: number }
) {
  if (report.deviceUuid !== mapping.deviceUuid || report.deviceUuid !== device.deviceUuid ||
    report.networkId !== device.networkId || report.logicalAddress !== mapping.logicalAddress) {
    throw new BioUsbError("BIO_DEVICE_NOT_FOUND", "BIO GET report identity did not match confirmed UUID/native UUID/address");
  }
}

function isBioTimeout(error: unknown) {
  return bioFailureCodes(error).includes("TIMEOUT");
}

function lightingObservationFromPresence(presence: BleMeshFixturePresence): BleMeshLightingObservation | undefined {
  if (presence.controlMode === "force-off") {
    return { fixtureId: presence.fixtureId, brightness: 0, powerOn: false, observedAt: presence.observedAt };
  }
  if (presence.controlMode === "force-on" && presence.configuredBrightness !== null) {
    return {
      fixtureId: presence.fixtureId,
      brightness: presence.configuredBrightness,
      powerOn: true,
      observedAt: presence.observedAt
    };
  }
  return undefined;
}

function bioFailureCodes(error: unknown): string[] {
  if (error instanceof AggregateError) {
    // [확인됨] BIO GET은 장치 report timeout 뒤 늦은 패킷이 다음 명령과 섞이지 않도록
    // 현재 USB transport를 폐기한다. 이때 원래 GET 실패와 transport 폐기 실패가 함께 나면
    // AggregateError가 된다. 바깥 AggregateError에는 code가 없으므로 기존 구현은 실제
    // TIMEOUT/CLOSE_FAILED를 `bio_control_failed` 하나로 가렸다. message/stack/UUID/raw packet은
    // 로그에 싣지 않고, 내부 오류가 이미 제공하는 안정된 code만 재귀적으로 추출한다.
    const nested = error.errors.flatMap((failure) => bioFailureCodes(failure));
    return nested.length > 0 ? nested : ["bio_control_failed"];
  }
  return [error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "bio_control_failed"];
}

function errorCode(error: unknown) {
  return bioFailureCodes(error)[0] ?? "bio_control_failed";
}

function addFailureCodes(codes: Record<string, number>, error: unknown, count = 1) {
  for (const code of bioFailureCodes(error)) codes[code] = (codes[code] ?? 0) + count;
}

function withFailureCodes(report: BleMeshResyncReport, codes: Record<string, number>): BleMeshResyncReport {
  return Object.keys(codes).length === 0 ? report : { ...report, failureCodes: { ...codes } };
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
