import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";

interface StoredIdentity {
  version: 1;
  uuidHex: string;
  tokenHex?: string;
}

export interface MeshIdentity {
  uuid: Uint8Array;
  token?: bigint;
}

export class MeshIdentityStore {
  constructor(private readonly path: string) {}

  async loadOrCreate(): Promise<MeshIdentity> {
    let raw: unknown;
    try {
      raw = await readJsonFile(this.path);
    } catch (error) {
      throw new Error("Invalid mesh identity file", { cause: error });
    }
    if (raw === null) {
      const stored: StoredIdentity = { version: 1, uuidHex: randomUUID().replaceAll("-", "") };
      await writeJsonAtomic(this.path, stored);
      return decode(stored);
    }
    return decode(parse(raw));
  }

  async saveToken(token: bigint) {
    if (token < 0n || token > 0xffff_ffff_ffff_ffffn) throw new Error("Invalid mesh token");
    const current = await this.loadOrCreate();
    await writeJsonAtomic(this.path, {
      version: 1,
      uuidHex: Buffer.from(current.uuid).toString("hex"),
      tokenHex: token.toString(16).padStart(16, "0")
    } satisfies StoredIdentity);
  }
}

function parse(value: unknown): StoredIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mesh identity file");
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.uuidHex !== "string" || !/^[0-9a-f]{32}$/i.test(row.uuidHex)) {
    throw new Error("Invalid mesh identity file");
  }
  if (row.tokenHex !== undefined && (typeof row.tokenHex !== "string" || !/^[0-9a-f]{16}$/i.test(row.tokenHex))) {
    throw new Error("Invalid mesh identity file");
  }
  return { version: 1, uuidHex: row.uuidHex.toLowerCase(), ...(row.tokenHex ? { tokenHex: row.tokenHex.toLowerCase() } : {}) };
}

function decode(stored: StoredIdentity): MeshIdentity {
  return {
    uuid: Uint8Array.from(Buffer.from(stored.uuidHex, "hex")),
    ...(stored.tokenHex ? { token: BigInt(`0x${stored.tokenHex}`) } : {})
  };
}
