import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { CAD_SCENE_MAX_TILE_BYTE_SIZE, CAD_SCENE_MAX_TOTAL_TILE_BYTES, CAD_SCENE_MAX_TILE_PART_COUNT,
  mapDisplayTileSchema, type MapDisplayManifest, type MapDisplayTile } from "@led-control/shared";
import { cadDisplayTileSpoolArtifactSchema, readVerifiedCadArtifact, remainingCadArtifactBytes,
  type CadDisplayTileSpoolArtifact } from "./cad-canonical-spool";
import type { BuiltMapDisplayTile } from "./cad-scene-builder";
import { CAD_MAP_MAX_METADATA_BYTES } from "./map-element-converter";

// zlib's worst-case overhead for a <=16 MiB tile fits in this allowance. This
// bounds physical input only; decoded/public tiles keep their existing 16 MiB cap.
const COMPRESSED_MAX_BYTES = CAD_SCENE_MAX_TILE_BYTE_SIZE + 64 * 1024;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({ assetId: z.string().uuid(), filename: z.string().regex(/^[a-f0-9-]{36}\.bin\.gz$/),
  byteSize: z.number().int().min(20).max(COMPRESSED_MAX_BYTES), sha256: sha,
  decodedByteSize: z.number().int().positive().max(CAD_SCENE_MAX_TILE_BYTE_SIZE), decodedSha256: sha }).strict();
const indexSchema = z.object({ codec: z.literal("gzip"), version: z.literal(1),
  tiles: z.array(entrySchema).max(CAD_SCENE_MAX_TILE_PART_COUNT) }).strict();
export type CadDisplayTileIndex = Map<string, z.infer<typeof entrySchema>>;

/** Called by the synchronous tile encoder: compress, charge, write, then release
 * each raw tile. The small index is the only retained scene-level spool state. */
export function createCadDisplayTileSpool(directory: string, claimBytes: (bytes: number) => void) {
  const entries: z.infer<typeof entrySchema>[] = [];
  const ids = new Set<string>();
  let rawByteSize = 0, physicalByteSize = 0, indexBytes = 0, finished = false;
  return {
    get rawByteSize() { return rawByteSize; },
    get physicalByteSize() { return physicalByteSize; },
    write({ descriptor, payload }: BuiltMapDisplayTile) {
      if (finished) throw new Error("display tile spool already finished");
      mapDisplayTileSchema.parse(descriptor);
      if (ids.has(descriptor.assetId) || entries.length >= CAD_SCENE_MAX_TILE_PART_COUNT) throw new Error("display tile spool identity/count mismatch");
      if (payload.length !== descriptor.byteSize || hash(payload) !== descriptor.sha256) throw new Error("display tile spool decoded integrity mismatch");
      if (rawByteSize + payload.length > CAD_SCENE_MAX_TOTAL_TILE_BYTES) throw new Error("display tile spool decoded budget exceeded");
      const compressed = gzipSync(payload, { level: 1 });
      const entry = entrySchema.parse({ assetId: descriptor.assetId, filename: `${descriptor.assetId}.bin.gz`,
        byteSize: compressed.length, sha256: hash(compressed), decodedByteSize: payload.length, decodedSha256: descriptor.sha256 });
      indexBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (indexBytes + 64 > CAD_MAP_MAX_METADATA_BYTES) throw new Error("display tile spool index byte budget exceeded");
      claimBytes(compressed.length);
      writeFileSync(join(directory, entry.filename), compressed, { flag: "wx", mode: 0o600 });
      physicalByteSize += compressed.length; rawByteSize += payload.length;
      ids.add(entry.assetId); entries.push(entry);
    },
    finish(): CadDisplayTileSpoolArtifact {
      if (finished) throw new Error("display tile spool already finished");
      const payload = Buffer.from(JSON.stringify({ codec: "gzip", version: 1, tiles: entries }));
      const artifact = cadDisplayTileSpoolArtifactSchema.parse({ codec: "gzip", version: 1,
        filename: `${randomUUID()}.json`, byteSize: payload.length, sha256: hash(payload),
        tileCount: entries.length, tileByteSize: physicalByteSize, decodedByteSize: rawByteSize });
      claimBytes(payload.length);
      writeFileSync(join(directory, artifact.filename), payload, { flag: "wx", mode: 0o600 });
      physicalByteSize += payload.length; finished = true;
      return artifact;
    }
  };
}

export async function readCadDisplayTileIndex(directory: string, artifact: CadDisplayTileSpoolArtifact | undefined,
  manifest: MapDisplayManifest): Promise<CadDisplayTileIndex | undefined> {
  // Existing in-memory producers explicitly omit this internal descriptor and
  // keep raw files. A declared compressed spool must never fall back to raw.
  if (!artifact) return undefined;
  cadDisplayTileSpoolArtifactSchema.parse(artifact);
  const { filename, byteSize, sha256 } = artifact;
  const bytes = await readVerifiedCadArtifact(directory, { filename, byteSize, sha256 }, CAD_MAP_MAX_METADATA_BYTES);
  const data = indexSchema.parse(JSON.parse(bytes.toString("utf8")));
  const index = new Map(data.tiles.map(tile => [tile.assetId, tile]));
  if (index.size !== data.tiles.length || index.size !== manifest.tiles.length || index.size !== artifact.tileCount ||
    data.tiles.reduce((n, tile) => n + tile.byteSize, 0) !== artifact.tileByteSize ||
    data.tiles.reduce((n, tile) => n + tile.decodedByteSize, 0) !== artifact.decodedByteSize || manifest.tiles.some(tile => {
    const entry = index.get(tile.assetId);
    return !entry || entry.filename !== `${tile.assetId}.bin.gz` || entry.decodedByteSize !== tile.byteSize || entry.decodedSha256 !== tile.sha256;
  }) || data.tiles.reduce((n, tile) => n + tile.decodedByteSize, 0) > CAD_SCENE_MAX_TOTAL_TILE_BYTES) {
    throw new Error("display tile spool membership/decoded integrity mismatch");
  }
  return index;
}

export async function withCadDisplayTileFile<T>(directory: string, tile: MapDisplayTile,
  index: CadDisplayTileIndex | undefined, consume: (path: string, bytes: Buffer) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  mapDisplayTileSchema.parse(tile);
  if (!index) {
    const bytes = await readVerifiedCadArtifact(directory,
      { filename: `${tile.assetId}.bin`, byteSize: tile.byteSize, sha256: tile.sha256 }, CAD_SCENE_MAX_TILE_BYTE_SIZE);
    signal?.throwIfAborted();
    return consume(join(directory, `${tile.assetId}.bin`), bytes);
  }
  const entry = entrySchema.parse(index.get(tile.assetId));
  if (entry.assetId !== tile.assetId || entry.filename !== `${tile.assetId}.bin.gz` ||
    entry.decodedByteSize !== tile.byteSize || entry.decodedSha256 !== tile.sha256) throw new Error("display tile spool decoded descriptor mismatch");
  const { filename, byteSize, sha256 } = entry;
  const compressed = await readVerifiedCadArtifact(directory, { filename, byteSize, sha256 }, COMPRESSED_MAX_BYTES);
  if (compressed[0] !== 31 || compressed[1] !== 139 || compressed[2] !== 8 || compressed[3] !== 0) throw new Error("invalid display tile gzip header");
  // info:true consumed bytes rejects trailing padding and concatenated gzip
  // members. gunzip additionally validates CRC/ISIZE, bounded by the raw tile.
  const inflated = inflateRawSync(compressed.subarray(10, -8), { info: true, maxOutputLength: tile.byteSize }) as unknown as
    { buffer: Buffer; engine: { bytesWritten: number } };
  if (inflated.engine.bytesWritten !== compressed.length - 18) throw new Error("trailing display tile gzip member data");
  const bytes = gunzipSync(compressed, { maxOutputLength: tile.byteSize });
  if (bytes.length !== tile.byteSize || hash(bytes) !== tile.sha256) throw new Error("display tile decoded integrity mismatch");
  signal?.throwIfAborted();
  if (bytes.length > await remainingCadArtifactBytes(directory)) throw new Error("CAD import temporary disk budget exceeded");
  const path = join(directory, `${randomUUID()}.bin`);
  // Exclusive creation plus finally cleanup keeps at most one <=16 MiB raw tile
  // for a sequential upload; compressed files remain reusable by preparation.
  const file = await open(path, "wx", 0o600);
  try {
    try { await file.writeFile(bytes); } finally { await file.close(); }
    signal?.throwIfAborted();
    return await consume(path, bytes);
  }
  finally { await rm(path, { force: true }); }
}
