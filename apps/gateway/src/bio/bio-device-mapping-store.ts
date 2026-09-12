import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import { formatBioDeviceUuid, parseBioDeviceUuid } from "./bio-device-identity";

export interface BioDeviceMapping {
  fixtureId: string;
  nodeId: string;
  deviceUuid: string;
  nativeUuid: string;
  logicalAddress: number;
  firmware: string;
  protocol: string;
  status: "reserved" | "confirmed";
  updatedAt: string;
}

export interface BioDeviceMappingInput {
  fixtureId: string;
  nodeId: string;
  deviceUuid: string;
  nativeUuid: string;
  logicalAddress: number;
  firmware: string;
  protocol: string;
}

interface StoredMappings {
  version: 1;
  mappings: BioDeviceMapping[];
}

/**
 * Keeps the BIO adapter's hardware identity/address relationship durable. A
 * reservation is intentionally invisible to all lookup methods: callers must
 * complete device read-back before a mapping can drive control or recovery.
 */
export class BioDeviceMappingStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  reserve(input: BioDeviceMappingInput) {
    return this.exclusive(async () => {
      const mapping = normalizeInput(input);
      const state = await this.read();
      const existing = state.mappings.find((row) => sharesKey(row, mapping));
      if (existing) {
        if (sharesIdentityKey(existing, mapping)) throw new Error("BIO mapping identity conflict");
        throw new Error("BIO mapping address conflict");
      }

      const reserved: BioDeviceMapping = {
        ...mapping,
        status: "reserved",
        updatedAt: this.now().toISOString()
      };
      state.mappings.push(reserved);
      await writeJsonAtomic(this.path, state);
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
      if (mapping.logicalAddress !== logicalAddress) throw new Error("BIO device returned an address different from reserved address");
      if (mapping.status === "confirmed") return { ...mapping };

      mapping.status = "confirmed";
      mapping.updatedAt = this.now().toISOString();
      await writeJsonAtomic(this.path, state);
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

  async findByNativeUuid(nativeUuid: string) {
    const canonicalNativeUuid = parseBioDeviceUuid(formatBioDeviceUuid(nativeUuid));
    return this.findConfirmed((mapping) => mapping.nativeUuid === canonicalNativeUuid);
  }

  async findByLogicalAddress(logicalAddress: number) {
    validateLogicalAddress(logicalAddress);
    return this.findConfirmed((mapping) => mapping.logicalAddress === logicalAddress);
  }

  async listConfirmed() {
    const state = await this.read();
    return state.mappings
      .filter((mapping): mapping is BioDeviceMapping & { status: "confirmed" } => mapping.status === "confirmed")
      .map((mapping) => ({ ...mapping }));
  }

  async validate() {
    await this.read();
  }

  private async findConfirmed(predicate: (mapping: BioDeviceMapping) => boolean) {
    const state = await this.read();
    const mapping = state.mappings.find((row) => row.status === "confirmed" && predicate(row));
    return mapping ? { ...mapping } : null;
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
    let value: unknown;
    try {
      value = await readJsonFile(this.path);
    } catch (error) {
      throw invalidMappingFile(error);
    }
    if (value === null) return { version: 1, mappings: [] };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidMappingFile();
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || !Array.isArray(row.mappings)) throw invalidMappingFile();

    let mappings: BioDeviceMapping[];
    try {
      mappings = row.mappings.map(parseMapping);
      for (let index = 0; index < mappings.length; index += 1) {
        if (mappings.slice(0, index).some((previous) => sharesKey(previous, mappings[index]))) {
          throw new Error("duplicate BIO mapping");
        }
      }
    } catch (error) {
      throw invalidMappingFile(error);
    }
    return { version: 1, mappings };
  }
}

function normalizeInput(value: BioDeviceMappingInput): BioDeviceMappingInput {
  if (!value || typeof value !== "object") throw new Error("Invalid BIO device mapping");
  const nativeUuid = parseBioDeviceUuid(formatBioDeviceUuid(value.nativeUuid));
  if (parseBioDeviceUuid(value.deviceUuid) !== nativeUuid) throw new Error("BIO mapping identity conflict");
  validateText(value.fixtureId);
  validateText(value.nodeId);
  validateText(value.firmware);
  validateText(value.protocol);
  validateLogicalAddress(value.logicalAddress);
  return { ...value, nativeUuid, deviceUuid: `bio:${nativeUuid}` };
}

function parseMapping(value: unknown): BioDeviceMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid mapping row");
  const row = value as Record<string, unknown>;
  if (row.status !== "reserved" && row.status !== "confirmed" || typeof row.updatedAt !== "string" || !isIsoDate(row.updatedAt)) {
    throw new Error("invalid mapping state");
  }
  const mapping = normalizeInput({
    fixtureId: expectString(row.fixtureId),
    nodeId: expectString(row.nodeId),
    deviceUuid: expectString(row.deviceUuid),
    nativeUuid: expectString(row.nativeUuid),
    logicalAddress: row.logicalAddress as number,
    firmware: expectString(row.firmware),
    protocol: expectString(row.protocol)
  });
  return { ...mapping, status: row.status, updatedAt: row.updatedAt };
}

function sharesKey(a: BioDeviceMappingInput, b: BioDeviceMappingInput) {
  return sharesIdentityKey(a, b) || a.logicalAddress === b.logicalAddress;
}

function sharesIdentityKey(a: BioDeviceMappingInput, b: BioDeviceMappingInput) {
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
