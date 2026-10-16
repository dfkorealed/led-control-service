import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import { formatBioDeviceUuid, parseBioDeviceUuid } from "./bio-device-identity";
import { BioUsbError } from "./bio-usb-error";
import { bioSensorFingerprintV1Schema, fixtureRegistrationRemovalCommandSchema,
  fixtureRegistrationRemovalBindingIdentity, type FixtureRegistrationRemovalCommand, type BioSensorFingerprintV1 } from "@led-control/shared";
import { isDeepStrictEqual } from "node:util";
import { registrationRemovalHash } from "../state/fixture-registration-removal-journal";

export interface BioDeviceMapping {
  fingerprint?: BioSensorFingerprintV1;
  fixtureId: string;
  nodeId: string;
  deviceUuid: string;
  nativeUuid: string;
  logicalAddress: number;
  observedLogicalAddressBeforeAssignment?: number;
  commandId?: string;
  firmware: string;
  protocol: string;
  status: "reserved" | "confirmed";
  updatedAt: string;
}

export interface BioDeviceMappingInput {
  fingerprint?: BioSensorFingerprintV1;
  fixtureId: string;
  nodeId: string;
  deviceUuid: string;
  nativeUuid: string;
  logicalAddress: number;
  observedLogicalAddressBeforeAssignment: number;
  commandId: string;
  firmware: string;
  protocol: string;
}

interface StoredMappings {
  version: 2 | 3;
  mappings: BioDeviceMapping[];
  retirements?: Array<{ command: FixtureRegistrationRemovalCommand }>;
}

type BioMappingKeys = Pick<BioDeviceMappingInput,
  "fixtureId" | "nodeId" | "deviceUuid" | "nativeUuid" | "logicalAddress">;

/**
 * BIO hardware UUID와 논리 주소의 durable 관계를 보관한다.
 *
 * - [확인됨] logical address는 캡처된 packet의 big-endian 16-bit 값이며 유효 범위는
 *   unicast `0x0001..0x7fff`다. `0xffff` broadcast는 저장 가능한 장치 주소가 아니다.
 * - [추정] 예약은 동시 등록 충돌을 막기 위한 소프트웨어 상태일 뿐 hardware 적용 증거가
 *   아니다. 그래서 `reserved` row는 모든 control lookup에서 숨긴다.
 * - [확인됨] v2 reserved row는 commandId와 주소 변경 전 실제 관측 주소를 함께 저장한다.
 *   같은 command의 완전히 동일한 재처리만 idempotent하며 altered command/UUID/address는
 *   fail-closed한다. [추정] 이는 MQTT 중복 처리 안전장치이고 hardware 상태 증거가 아니다.
 * - [확인됨] v1 confirmed는 제어 mapping으로 안전하게 읽는다. 반면 v1 reserved에는 변경 전
 *   관측 주소가 없어 재조정할 수 없으므로 `BIO_ADDRESS_STATE_UNKNOWN`으로 중단한다.
 * - [확인됨] `confirm`은 예약 UUID와 장치가 반환했다고 caller가 전달한 address가 다르면
 *   거부하고, fixture/node/UUID/address 어느 key도 중복되면 fail-closed한다. [추정] caller는
 *   동일 UUID/new address의 scan 재관측을 마친 뒤에만 이 API를 호출해야 한다.
 * - [미확인] APK 정적 serializer 계약이 실제 장치에 적용되는지는 Task 9 HIL 전까지
 *   확인되지 않았다. 이 journal 또는 outer ACK를 hardware 등록 완료로 해석하면 안 된다.
 */
export class BioDeviceMappingStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly changeListeners = new Set<() => void>();
  private readonly retiredFixtures = new Set<string>();
  private readonly retiredNodes = new Set<string>();
  private readonly retiredCommands = new Set<string>();
  private readonly admissionFences = new Map<string, FixtureRegistrationRemovalCommand>();
  private unavailable = false;

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Local durable mutations only; external file changes are re-read by pulse intake. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      // Observers cannot turn an already durable provisioning write into a failure.
      try { listener(); } catch { /* Failures are confined to the observer. */ }
    }
  }

  /** Synchronous last-instruction guard; USB transport generations are unrelated. */
  isRegistrationCurrent(mapping: BioDeviceMapping): boolean {
    return !this.unavailable && !this.retiredFixtures.has(mapping.fixtureId) && !this.retiredNodes.has(mapping.nodeId)
      && (!mapping.commandId || !this.retiredCommands.has(mapping.commandId))
      && ![...this.admissionFences.values()].some(command => command.fixtureId === mapping.fixtureId || command.nodeId === mapping.nodeId);
  }

  isFixtureRetired(fixtureId: string): boolean {
    return this.unavailable || this.retiredFixtures.has(fixtureId)
      || [...this.admissionFences.values()].some(command => command.fixtureId === fixtureId);
  }

  fenceRegistration(command: FixtureRegistrationRemovalCommand): void {
    const previous = this.admissionFences.get(command.operationId);
    if (previous) {
      if (!isDeepStrictEqual(previous, command)) throw new Error("BIO removal operation conflict");
      return;
    }
    this.admissionFences.set(command.operationId, structuredClone(command));
    this.notifyChange();
  }

  releaseRegistrationFence(operationId: string): void {
    if (this.admissionFences.delete(operationId)) this.notifyChange();
  }

  async assertProvisioningAdmissible(command: { nodeId: string; deviceUuid: string; commandId?: string }) {
    return this.exclusive(async () => {
      await this.read();
      if (this.unavailable || this.retiredFixtures.has(command.nodeId) || this.retiredNodes.has(command.nodeId)
        || (command.commandId && this.retiredCommands.has(command.commandId))
        || [...this.admissionFences.values()].some(row => row.deviceUuid === command.deviceUuid || row.nodeId === command.nodeId)) {
        throw new Error("BIO_REGISTRATION_RETIRED");
      }
    });
  }

  async retirement(command: FixtureRegistrationRemovalCommand) {
    return this.exclusive(async () => {
      const state = await this.read();
      const previous = state.retirements?.find(row => row.command.operationId === command.operationId);
      if (previous && !isDeepStrictEqual(previous.command, command)) throw new Error("BIO removal operation conflict");
      return previous ? structuredClone(previous) : null;
    });
  }

  retireRegistration(input: FixtureRegistrationRemovalCommand, assertSafe: () => Promise<void> = async () => undefined) {
    return this.exclusive(async () => {
      const command = fixtureRegistrationRemovalCommandSchema.parse(input);
      if (registrationRemovalHash(fixtureRegistrationRemovalBindingIdentity(command)) !== command.bindingHash) throw new Error("BIO_REMOVAL_BINDING_MISMATCH");
      const state = await this.read();
      const previous = state.retirements?.find(row => row.command.operationId === command.operationId);
      if (previous) {
        if (!isDeepStrictEqual(previous.command, command)) throw new Error("BIO removal operation conflict");
        // Repeat the durability barrier after a rename-visible/uncertain commit.
        await writeJsonAtomic(this.path, state);
        return;
      }
      const mapping = state.mappings.find(row => row.fixtureId === command.fixtureId);
      if (!mapping || !matchesRemovalMapping(mapping, command) || [...this.admissionFences.values()].some(row =>
        row.operationId !== command.operationId && (row.fixtureId === command.fixtureId || row.deviceUuid === command.deviceUuid))) {
        throw new Error("BIO_REMOVAL_BINDING_MISMATCH");
      }
      // Fence captured/queued targets before awaiting any persistence. On write
      // uncertainty the fence remains until exact recovery, never timeout expiry.
      this.fenceRegistration(command);
      await assertSafe();
      const next: StoredMappings = { version: 3, mappings: state.mappings.filter(row => row !== mapping),
        retirements: [...state.retirements ?? [], { command }] };
      if (next.retirements!.length > 10_000 || Buffer.byteLength(JSON.stringify(next, null, 2)) > 16 * 1024 * 1024) throw new Error("BIO_RETIREMENT_CAPACITY");
      if (await readJsonFile(`${this.path}.retirement-manifest`) === null) {
        await writeJsonAtomic(`${this.path}.retirement-manifest`, { version: 1, firstRemoval: command });
      }
      await writeJsonAtomic(this.path, next);
      this.rememberRetirement(command);
      this.releaseRegistrationFence(command.operationId);
      this.notifyChange();
    });
  }

  private rememberRetirement(command: FixtureRegistrationRemovalCommand) {
    this.retiredFixtures.add(command.fixtureId); this.retiredNodes.add(command.nodeId);
    this.retiredCommands.add(command.originalProvisionCommandId);
  }

  reserve(input: BioDeviceMappingInput) {
    return this.exclusive(async () => {
      const mapping = normalizeInput(input);
      const state = await this.read();
      if (!this.isRegistrationCurrent({ ...mapping, status: "reserved", updatedAt: this.now().toISOString() })
        || [...this.admissionFences.values()].some(command => command.deviceUuid === mapping.deviceUuid)
        || state.retirements?.some(row => Number.parseInt(row.command.meshAddress, 16) === mapping.logicalAddress)) {
        throw new Error("BIO_REGISTRATION_RETIRED");
      }
      const repeated = state.mappings.find((row) => row.commandId === mapping.commandId);
      if (repeated) {
        if (sameReservation(repeated, mapping)) return { ...repeated };
        throw new Error("BIO mapping command conflict");
      }
      const existing = state.mappings.find((row) => sharesKey(row, mapping));
      if (existing) {
        if (sharesIdentityKey(existing, mapping)) throw new Error("BIO mapping identity conflict");
        throw new BioUsbError("BIO_ADDRESS_CONFLICT", "BIO mapping address conflict");
      }

      const reserved: BioDeviceMapping = {
        ...mapping,
        status: "reserved",
        updatedAt: this.now().toISOString()
      };
      state.mappings.push(reserved);
      await writeJsonAtomic(this.path, state);
      this.notifyChange();
      return { ...reserved };
    });
  }

  confirm(deviceUuid: string, logicalAddress: number) {
    return this.exclusive(async () => {
      const nativeUuid = parseBioDeviceUuid(deviceUuid);
      validateLogicalAddress(logicalAddress);
      const state = await this.read();
      const mapping = state.mappings.find((row) => row.deviceUuid === `bio:${nativeUuid}`);
      if (!mapping) throw new Error("BIO device mapping reservation not found");
      if (!this.isRegistrationCurrent(mapping)) throw new Error("BIO_REGISTRATION_RETIRED");
      if (mapping.logicalAddress !== logicalAddress) throw new Error("BIO device returned an address different from reserved address");
      if (mapping.status === "confirmed") return { ...mapping };

      mapping.status = "confirmed";
      mapping.updatedAt = this.now().toISOString();
      await writeJsonAtomic(this.path, state);
      this.notifyChange();
      return { ...mapping };
    });
  }

  async findByFixtureId(fixtureId: string) {
    return this.findConfirmed((mapping) => mapping.fixtureId === fixtureId);
  }

  async findByDeviceUuid(deviceUuid: string) {
    const nativeUuid = parseBioDeviceUuid(deviceUuid);
    return this.findConfirmed((mapping) => mapping.deviceUuid === `bio:${nativeUuid}`);
  }

  /**
   * [확인됨] durable provisioning accepted 복구만 reserved row를 볼 수 있다. 일반 제어
   * lookup은 계속 confirmed-only이며, caller는 old/new UUID reconciliation 없이 reserve를
   * hardware 적용 상태로 해석하면 안 된다.
   */
  async findByDeviceUuidIncludingReserved(deviceUuid: string) {
    const nativeUuid = parseBioDeviceUuid(deviceUuid);
    return this.exclusive(async () => {
      const state = await this.read();
      const mapping = state.mappings.find((row) => row.deviceUuid === `bio:${nativeUuid}`);
      return mapping ? { ...mapping } : null;
    });
  }

  async findByNativeUuid(nativeUuid: string) {
    const canonicalNativeUuid = parseBioDeviceUuid(formatBioDeviceUuid(nativeUuid));
    return this.findConfirmed((mapping) => mapping.nativeUuid === canonicalNativeUuid);
  }

  async findByLogicalAddress(logicalAddress: number) {
    validateLogicalAddress(logicalAddress);
    return this.findConfirmed((mapping) => mapping.logicalAddress === logicalAddress);
  }

  async listConfirmed() {
    return this.exclusive(async () => {
      const state = await this.read();
      return state.mappings
        .filter((mapping): mapping is BioDeviceMapping & { status: "confirmed" } => mapping.status === "confirmed" && this.isRegistrationCurrent(mapping))
        .map((mapping) => ({ ...mapping }));
    });
  }

  async validate() {
    await this.exclusive(() => this.read());
  }

  private async findConfirmed(predicate: (mapping: BioDeviceMapping) => boolean) {
    return this.exclusive(async () => {
      const state = await this.read();
      const mapping = state.mappings.find((row) => row.status === "confirmed" && this.isRegistrationCurrent(row) && predicate(row));
      return mapping ? { ...mapping } : null;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async read(): Promise<StoredMappings> {
    try { return await this.readState(); }
    catch (error) { this.unavailable = true; throw error; }
  }

  // Reads share the mutation queue: none may observe the manifest-first
  // transition between the V2 mapping file and its atomic V3 retirement commit.
  private async readState(): Promise<StoredMappings> {
    let value: unknown;
    let firstRemoval: FixtureRegistrationRemovalCommand | undefined;
    try {
      value = await readJsonFile(this.path, { maxBytes: 16 * 1024 * 1024 });
      const manifest = await readJsonFile(`${this.path}.retirement-manifest`);
      if (manifest !== null) {
        if (!manifest || typeof manifest !== "object" || Object.keys(manifest).sort().join() !== "firstRemoval,version"
          || !("version" in manifest) || manifest.version !== 1 || !("firstRemoval" in manifest) || value === null) throw invalidMappingFile();
        firstRemoval = fixtureRegistrationRemovalCommandSchema.parse(manifest.firstRemoval);
        if (registrationRemovalHash(fixtureRegistrationRemovalBindingIdentity(firstRemoval)) !== firstRemoval.bindingHash) throw invalidMappingFile();
      }
      if (value && typeof value === "object" && "version" in value && value.version === 3 && manifest === null) throw invalidMappingFile();
    } catch (error) {
      this.unavailable = true;
      throw invalidMappingFile(error);
    }
    if (value === null) return { version: 2, mappings: [] };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidMappingFile();
    const row = value as Record<string, unknown>;
    if ((row.version !== 1 && row.version !== 2 && row.version !== 3) || !Array.isArray(row.mappings)) throw invalidMappingFile();
    const version = row.version;

    // [확인됨] v1 reserved는 old address를 기록하지 않아 old/new scan matrix를 만들 수 없다.
    // 값을 추정하거나 현재 address를 새 address로 간주하지 않고 복구를 명시적으로 막는다.
    if (row.version === 1 && row.mappings.some((value) => isReservedRow(value))) {
      throw new BioUsbError("BIO_ADDRESS_STATE_UNKNOWN", "Legacy BIO reservation has unknown pre-assignment address");
    }

    let mappings: BioDeviceMapping[];
    try {
      mappings = row.mappings.map((mapping) => parseMapping(mapping, version === 3 ? 2 : version));
      for (let index = 0; index < mappings.length; index += 1) {
        if (mappings.slice(0, index).some((previous) => sharesKey(previous, mappings[index]))) {
          throw new Error("duplicate BIO mapping");
        }
      }
    } catch (error) {
      throw invalidMappingFile(error);
    }
    if (version !== 3) {
      if (firstRemoval) {
        // A crash can leave only the first manifest durable. Its exact original
        // registration stays fenced until the deletion journal reconciles it.
        if (!mappings.some(mapping => matchesRemovalMapping(mapping, firstRemoval!))) throw invalidMappingFile();
        this.fenceRegistration(firstRemoval);
      }
      return { version: 2, mappings };
    }
    if (!Array.isArray(row.retirements) || row.retirements.length === 0 || row.retirements.length > 10_000) throw invalidMappingFile();
    const retirements = row.retirements.map(value => {
      if (!value || typeof value !== "object" || Object.keys(value).join() !== "command") throw invalidMappingFile();
      return { command: fixtureRegistrationRemovalCommandSchema.parse(value.command) };
    });
    const operations = new Set<string>();
    for (const { command } of retirements) {
      if (registrationRemovalHash(fixtureRegistrationRemovalBindingIdentity(command)) !== command.bindingHash) throw invalidMappingFile();
      if (operations.has(command.operationId) || mappings.some(mapping => mapping.fixtureId === command.fixtureId
        || mapping.nodeId === command.nodeId || mapping.commandId === command.originalProvisionCommandId
        || mapping.logicalAddress === Number.parseInt(command.meshAddress, 16))) throw invalidMappingFile();
      operations.add(command.operationId); this.rememberRetirement(command);
    }
    if (!firstRemoval || !retirements.some(row => isDeepStrictEqual(row.command, firstRemoval))) throw invalidMappingFile();
    return { version: 3, mappings, retirements };
  }
}

function matchesRemovalMapping(mapping: BioDeviceMapping, command: FixtureRegistrationRemovalCommand) {
  return mapping.status === "confirmed" && mapping.fixtureId === command.fixtureId && mapping.nodeId === command.nodeId
    && mapping.deviceUuid === command.deviceUuid && mapping.nativeUuid === command.deviceUuid.slice(4)
    && mapping.logicalAddress === Number.parseInt(command.meshAddress, 16) && mapping.commandId === command.originalProvisionCommandId;
}

function normalizeInput(value: BioDeviceMappingInput): BioDeviceMappingInput {
  if (!value || typeof value !== "object") throw new Error("Invalid BIO device mapping");
  const nativeUuid = parseBioDeviceUuid(formatBioDeviceUuid(value.nativeUuid));
  if (parseBioDeviceUuid(value.deviceUuid) !== nativeUuid) throw new Error("BIO mapping identity conflict");
  validateText(value.fixtureId);
  validateText(value.nodeId);
  validateText(value.firmware);
  validateText(value.protocol);
  validateText(value.commandId);
  validateLogicalAddress(value.logicalAddress);
  validateLogicalAddress(value.observedLogicalAddressBeforeAssignment);
  return { ...value, ...(value.fingerprint ? { fingerprint: bioSensorFingerprintV1Schema.parse(value.fingerprint) } : {}), nativeUuid, deviceUuid: `bio:${nativeUuid}` };
}

function parseMapping(value: unknown, version: 1 | 2): BioDeviceMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid mapping row");
  const row = value as Record<string, unknown>;
  if (row.status !== "reserved" && row.status !== "confirmed" || typeof row.updatedAt !== "string" || !isIsoDate(row.updatedAt)) {
    throw new Error("invalid mapping state");
  }
  const core = {
    ...(row.fingerprint === undefined ? {} : { fingerprint: bioSensorFingerprintV1Schema.parse(row.fingerprint) }),
    fixtureId: expectString(row.fixtureId),
    nodeId: expectString(row.nodeId),
    deviceUuid: expectString(row.deviceUuid),
    nativeUuid: expectString(row.nativeUuid),
    logicalAddress: row.logicalAddress as number,
    firmware: expectString(row.firmware),
    protocol: expectString(row.protocol)
  };
  const migratedLegacyConfirmed = version === 2
    && row.status === "confirmed"
    && row.commandId === undefined
    && row.observedLogicalAddressBeforeAssignment === undefined;
  // [확인됨] v1 confirmed row는 이후 reserve가 envelope를 v2로 올려도 필드 그대로 남는다.
  // v2-only 필드 누락은 confirmed에만 허용하고 reserved에는 절대 허용하지 않는다.
  if (version === 1 || migratedLegacyConfirmed) {
    const mapping = normalizeLegacyConfirmed(core);
    return { ...mapping, status: "confirmed", updatedAt: row.updatedAt };
  }
  const mapping = normalizeInput({
    ...core,
    observedLogicalAddressBeforeAssignment: row.observedLogicalAddressBeforeAssignment as number,
    commandId: expectString(row.commandId)
  });
  return { ...mapping, status: row.status, updatedAt: row.updatedAt };
}

function normalizeLegacyConfirmed(value: Omit<BioDeviceMappingInput, "observedLogicalAddressBeforeAssignment" | "commandId">) {
  const nativeUuid = parseBioDeviceUuid(formatBioDeviceUuid(value.nativeUuid));
  if (parseBioDeviceUuid(value.deviceUuid) !== nativeUuid) throw new Error("BIO mapping identity conflict");
  validateText(value.fixtureId);
  validateText(value.nodeId);
  validateText(value.firmware);
  validateText(value.protocol);
  validateLogicalAddress(value.logicalAddress);
  return { ...value, nativeUuid, deviceUuid: `bio:${nativeUuid}` };
}

function sameReservation(row: BioDeviceMapping, input: BioDeviceMappingInput) {
  return row.fixtureId === input.fixtureId
    && row.nodeId === input.nodeId
    && row.deviceUuid === input.deviceUuid
    && row.nativeUuid === input.nativeUuid
    && row.logicalAddress === input.logicalAddress
    && row.observedLogicalAddressBeforeAssignment === input.observedLogicalAddressBeforeAssignment
    && row.commandId === input.commandId
    && row.firmware === input.firmware
    && row.protocol === input.protocol;
}

function isReservedRow(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).status === "reserved");
}

function sharesKey(a: BioMappingKeys, b: BioMappingKeys) {
  return sharesIdentityKey(a, b) || a.logicalAddress === b.logicalAddress;
}

function sharesIdentityKey(a: BioMappingKeys, b: BioMappingKeys) {
  return a.fixtureId === b.fixtureId || a.nodeId === b.nodeId || a.deviceUuid === b.deviceUuid || a.nativeUuid === b.nativeUuid;
}

function validateText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid BIO device mapping");
}

function expectString(value: unknown) {
  validateText(value);
  return value;
}

function validateLogicalAddress(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0x0001 || value > 0x7fff) {
    throw new Error("Invalid BIO logical address");
  }
}

function isIsoDate(value: string) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function invalidMappingFile(cause?: unknown) {
  return new Error("Invalid BIO device mapping file", cause === undefined ? undefined : { cause });
}
