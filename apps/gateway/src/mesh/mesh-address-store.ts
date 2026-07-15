import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";

export interface MeshAddressReservation {
  fixtureId: string;
  nodeId: string;
  deviceUuid: string;
  primaryUnicast: number;
  elementCount: number;
  status: "reserved" | "confirmed";
}

interface StoredMappings {
  version: 1;
  mappings: MeshAddressReservation[];
}

export class MeshAddressStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  reserve(input: { nodeId: string; deviceUuid: string; meshAddress: string }) {
    return this.exclusive(async () => {
      const state = await this.read();
      const existing = state.mappings.find(
        (row) => row.nodeId === input.nodeId || row.deviceUuid.toLowerCase() === input.deviceUuid.toLowerCase()
      );
      const primaryUnicast = parseUnicast(input.meshAddress);
      if (existing) {
        if (
          existing.nodeId !== input.nodeId ||
          existing.deviceUuid.toLowerCase() !== input.deviceUuid.toLowerCase() ||
          existing.primaryUnicast !== primaryUnicast
        ) {
          throw new Error("Mesh reservation identity conflict");
        }
        return { ...existing };
      }
      assertRangeAvailable(state.mappings, primaryUnicast, 1);
      const reservation: MeshAddressReservation = {
        fixtureId: input.nodeId,
        nodeId: input.nodeId,
        deviceUuid: input.deviceUuid,
        primaryUnicast,
        elementCount: 1,
        status: "reserved"
      };
      state.mappings.push(reservation);
      await writeJsonAtomic(this.path, state);
      return { ...reservation };
    });
  }

  confirm(deviceUuid: string, primaryUnicast: number, elementCount: number) {
    return this.exclusive(async () => {
      const state = await this.read();
      const mapping = state.mappings.find((row) => row.deviceUuid.toLowerCase() === deviceUuid.toLowerCase());
      if (!mapping) throw new Error("Mesh address reservation not found");
      if (mapping.primaryUnicast !== primaryUnicast) throw new Error("BlueZ returned an address different from reserved address");
      validateRange(primaryUnicast, elementCount);
      assertRangeAvailable(
        state.mappings.filter((row) => row !== mapping),
        primaryUnicast,
        elementCount
      );
      mapping.elementCount = elementCount;
      mapping.status = "confirmed";
      await writeJsonAtomic(this.path, state);
      return { ...mapping };
    });
  }

  prepareElementRange(deviceUuid: string, elementCount: number) {
    return this.exclusive(async () => {
      const state = await this.read();
      const mapping = state.mappings.find((row) => row.deviceUuid.toLowerCase() === deviceUuid.toLowerCase());
      if (!mapping || mapping.status !== "reserved") throw new Error("Mesh address reservation not found");
      validateRange(mapping.primaryUnicast, elementCount);
      assertRangeAvailable(
        state.mappings.filter((row) => row !== mapping),
        mapping.primaryUnicast,
        elementCount
      );
      mapping.elementCount = elementCount;
      await writeJsonAtomic(this.path, state);
      return { ...mapping };
    });
  }

  release(deviceUuid: string) {
    return this.exclusive(async () => {
      const state = await this.read();
      const normalizedUuid = deviceUuid.toLowerCase();
      const next = state.mappings.filter(
        (row) => row.status === "confirmed" || row.deviceUuid.toLowerCase() !== normalizedUuid
      );
      if (next.length !== state.mappings.length) {
        await writeJsonAtomic(this.path, { version: 1, mappings: next } satisfies StoredMappings);
      }
    });
  }

  async findByFixtureId(fixtureId: string) {
    const state = await this.read();
    const mapping = state.mappings.find((row) => row.fixtureId === fixtureId);
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
      throw new Error("Invalid mesh address mapping file", { cause: error });
    }
    if (value === null) return { version: 1, mappings: [] };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mesh address mapping file");
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || !Array.isArray(row.mappings)) throw new Error("Invalid mesh address mapping file");
    const mappings = row.mappings.map(parseMapping);
    for (let index = 0; index < mappings.length; index += 1) {
      assertRangeAvailable(mappings.slice(0, index), mappings[index].primaryUnicast, mappings[index].elementCount);
    }
    return { version: 1, mappings };
  }
}

function parseMapping(value: unknown): MeshAddressReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mesh address mapping file");
  const row = value as Record<string, unknown>;
  if (
    typeof row.fixtureId !== "string" ||
    typeof row.nodeId !== "string" ||
    typeof row.deviceUuid !== "string" ||
    typeof row.primaryUnicast !== "number" ||
    typeof row.elementCount !== "number" ||
    (row.status !== "reserved" && row.status !== "confirmed")
  ) {
    throw new Error("Invalid mesh address mapping file");
  }
  validateRange(row.primaryUnicast, row.elementCount);
  return row as unknown as MeshAddressReservation;
}

function parseUnicast(value: string) {
  if (!/^0x[0-9a-f]{1,4}$/i.test(value)) throw new Error("Invalid mesh unicast address");
  const address = Number.parseInt(value.slice(2), 16);
  validateRange(address, 1);
  return address;
}

function validateRange(start: number, count: number) {
  if (!Number.isInteger(start) || !Number.isInteger(count) || count < 1 || start < 1 || start + count - 1 > 0x7fff) {
    throw new Error("Invalid mesh unicast address range");
  }
}

function assertRangeAvailable(mappings: MeshAddressReservation[], start: number, count: number) {
  validateRange(start, count);
  const end = start + count - 1;
  for (const mapping of mappings) {
    const mappingEnd = mapping.primaryUnicast + mapping.elementCount - 1;
    if (start <= mappingEnd && mapping.primaryUnicast <= end) throw new Error("Mesh address conflict");
  }
}
