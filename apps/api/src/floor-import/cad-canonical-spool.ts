import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { open, writeFile, opendir, statfs, lstat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { CAD_SCENE_MAX_TILE_PART_COUNT, mapElementSchema, mapDocumentStateSchema, type MapElement } from "@led-control/shared";
import { buildCadScene, type BuiltMapDisplayScene, type BuiltMapDisplayTile, type StreamedMapDisplayScene } from "./cad-scene-builder";
import { cadScenePersistenceIdentity } from "./cad-scene-persistence";
import { CAD_MAP_MAX_METADATA_BYTES, createCadMapElementConverter, type CadMapConversionMetadata } from "./map-element-converter";
import type { NormalizedCadDocument } from "./cad-types";
import type { CadDetectedRegion } from "./cad-region-detector";
import { CAD_IMPORT_TEMP_FILESYSTEM_OVERHEAD_BYTES, CAD_IMPORT_TEMP_VOLUME_BYTES } from "./cad-resource-limits";

export const CANONICAL_SPOOL_MAX_BYTES = 512 * 1024 * 1024;
const ELEMENT_MAX_BYTES = 8 * 1024 * 1024 - 2;
const FRAME_BYTES = 256 * 1024;
const FRAME_COMPRESSED_MAX_BYTES = FRAME_BYTES + 1024;
const fileSchema = z.object({ filename: z.string().regex(/^[a-f0-9-]{36}\.(ndjson\.gzf|json|bin|bin\.gz)$/),
  byteSize: z.number().int().min(0).max(CANONICAL_SPOOL_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const elementsSchema = fileSchema.extend({ filename: z.string().regex(/^[a-f0-9-]{36}\.ndjson\.gzf$/),
  codec: z.literal("gzip-frames"), version: z.literal(1),
  decodedByteSize: z.number().int().min(0).max(CANONICAL_SPOOL_MAX_BYTES),
  decodedSha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const cadDisplayTileSpoolArtifactSchema = fileSchema.extend({
  filename: z.string().regex(/^[a-f0-9-]{36}\.json$/), byteSize: z.number().int().positive().max(CAD_MAP_MAX_METADATA_BYTES),
  codec: z.literal("gzip"), version: z.literal(1),
  tileCount: z.number().int().nonnegative().max(CAD_SCENE_MAX_TILE_PART_COUNT),
  tileByteSize: z.number().int().nonnegative().max(CANONICAL_SPOOL_MAX_BYTES),
  decodedByteSize: z.number().int().nonnegative().max(CANONICAL_SPOOL_MAX_BYTES)
});
export type CadDisplayTileSpoolArtifact = z.infer<typeof cadDisplayTileSpoolArtifactSchema>;
export const canonicalArtifactSchema = z.object({ elements: elementsSchema, metadata: fileSchema.extend({ byteSize: z.number().int().positive().max(CAD_MAP_MAX_METADATA_BYTES) }),
  displayTiles: cadDisplayTileSpoolArtifactSchema.optional(),
  elementCount: z.number().int().min(0).max(500_000) }).strict();
export type CadCanonicalArtifact = z.infer<typeof canonicalArtifactSchema>;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The builder callback is synchronous. Blocking bounded writes in the isolated
 * child provide backpressure without retaining another expanded geometry graph. */
interface CanonicalBuildLimits {
  maxBytes?: number;
  onTile?: (tile: BuiltMapDisplayTile) => void;
  onPhysicalBytes?: (byteSize: number) => void;
}
export function buildCanonicalCadScene(document: NormalizedCadDocument, region: CadDetectedRegion,
  jobId: string, directory: string, limits: CanonicalBuildLimits & { onTile: (tile: BuiltMapDisplayTile) => void }):
  Promise<{ built: StreamedMapDisplayScene; canonical: CadCanonicalArtifact }>;
export function buildCanonicalCadScene(document: NormalizedCadDocument, region: CadDetectedRegion,
  jobId: string, directory: string, limits?: CanonicalBuildLimits & { onTile?: undefined }):
  Promise<{ built: BuiltMapDisplayScene; canonical: CadCanonicalArtifact }>;
export async function buildCanonicalCadScene(document: NormalizedCadDocument, region: CadDetectedRegion,
  jobId: string, directory: string, limits: CanonicalBuildLimits = {}) {
  const maximum = limits.maxBytes ?? CANONICAL_SPOOL_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > CANONICAL_SPOOL_MAX_BYTES) throw new Error("invalid canonical byte limit");
  const filename = `${randomUUID()}.ndjson.gzf`;
  const fd = openSync(join(directory, filename), "wx", 0o600);
  const hash = createHash("sha256");
  const decodedHash = createHash("sha256");
  let byteSize = 0, decodedByteSize = 0, pendingBytes = 0;
  const pending = Buffer.allocUnsafe(FRAME_BYTES);
  // Version 1: repeated uint32-LE compressed size / decoded size / one gzip
  // member. Independent bounded frames fit the synchronous semantic callback
  // without queuing asynchronous compression of an entire expanded drawing.
  const flush = () => {
    if (!pendingBytes) return;
    const compressed = gzipSync(pending.subarray(0, pendingBytes), { level: 1 });
    if (compressed.length > FRAME_COMPRESSED_MAX_BYTES || byteSize + 8 + compressed.length > maximum) {
      throw new Error("canonical spool physical byte budget exceeded");
    }
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32LE(compressed.length, 0); header.writeUInt32LE(pendingBytes, 4);
    limits.onPhysicalBytes?.(header.length + compressed.length);
    for (const bytes of [header, compressed]) {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      hash.update(bytes); byteSize += bytes.length;
    }
    pendingBytes = 0;
  };
  let count = 0;
  const converter = createCadMapElementConverter({ importJobId: jobId, regionBounds: region.bounds,
    unsupportedEntityCounts: document.unsupportedEntityCounts });
  const identity = cadScenePersistenceIdentity(jobId, region.regionId);
  let built: StreamedMapDisplayScene;
  try {
    built = buildCadScene(document, region, { displayVersion: 2, sceneId: identity.sceneId, manifestAssetId: identity.manifestAssetId,
      orderedPageDirectory: directory, onPageSpoolBytes: limits.onPhysicalBytes,
      tileAssetId: identity.tileAssetId, onTile: limits.onTile, onSemanticEntity: semantic => {
        const stored = converter.convertSemanticEntity(semantic);
        for (const element of stored) {
          if (++count > 500_000) throw new Error("canonical element count exceeded");
          const bytes = Buffer.from(`${JSON.stringify(element)}\n`);
          if (bytes.length - 1 > ELEMENT_MAX_BYTES) throw new Error("canonical element byte budget exceeded");
          if (decodedByteSize + bytes.length > CANONICAL_SPOOL_MAX_BYTES) throw new Error("canonical spool decoded byte budget exceeded");
          decodedHash.update(bytes); decodedByteSize += bytes.length;
          let offset = 0;
          while (offset < bytes.length) {
            const copied = bytes.copy(pending, pendingBytes, offset, offset + FRAME_BYTES - pendingBytes);
            offset += copied; pendingBytes += copied;
            if (pendingBytes === FRAME_BYTES) flush();
          }
        }
        // Return the exact persisted IDs, not a void notification or a second conversion.
        return stored;
      } });
    flush();
  } finally { closeSync(fd); }
  const metadata = converter.getMetadata();
  if (metadata.elementCount > 500_000) throw new Error("canonical element count exceeded");
  const payload = Buffer.from(JSON.stringify(metadata));
  const metadataFilename = `${randomUUID()}.json`;
  await writeFile(join(directory, metadataFilename), payload, { flag: "wx", mode: 0o600 });
  return { built, canonical: canonicalArtifactSchema.parse({ elements: { filename, byteSize, sha256: hash.digest("hex"),
    codec: "gzip-frames", version: 1, decodedByteSize, decodedSha256: decodedHash.digest("hex") },
    metadata: { filename: metadataFilename, byteSize: payload.length, sha256: digest(payload) }, elementCount: metadata.elementCount }) };
}

async function openArtifact(directory: string, descriptor: z.infer<typeof fileSchema>, maximum: number) {
  if (!fileSchema.safeParse(descriptor).success || descriptor.byteSize > maximum) throw new Error("invalid canonical artifact descriptor");
  const file = await open(join(directory, descriptor.filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== descriptor.byteSize) throw new Error("canonical artifact size mismatch");
    return file;
  } catch (error) { await file.close(); throw error; }
}

export async function readCanonicalMetadata(directory: string, artifact: CadCanonicalArtifact): Promise<CadMapConversionMetadata> {
  canonicalArtifactSchema.parse(artifact);
  const bytes = await readVerifiedCadArtifact(directory, artifact.metadata, CAD_MAP_MAX_METADATA_BYTES);
  const metadata = JSON.parse(bytes.toString("utf8")) as CadMapConversionMetadata;
  mapDocumentStateSchema.parse({ elements: [], groups: metadata.groups, layers: metadata.layers });
  const layerIds = new Set(metadata.layers.map(layer => layer.id));
  if (metadata.elementCount !== artifact.elementCount || !Array.isArray(metadata.displayLayerBindings) ||
    metadata.displayLayerBindings.length !== metadata.layers.length ||
    new Set(metadata.displayLayerBindings.map(binding => binding.layerName)).size !== metadata.layers.length ||
    new Set(metadata.displayLayerBindings.map(binding => binding.layerId)).size !== metadata.layers.length ||
    metadata.displayLayerBindings.some(binding => typeof binding.layerName !== "string" ||
      !layerIds.has(binding.layerId))) throw new Error("invalid canonical metadata bindings/count");
  return metadata;
}

export async function readVerifiedCadArtifact(directory: string, descriptor: z.infer<typeof fileSchema>, maximum: number): Promise<Buffer> {
  const file = await openArtifact(directory, descriptor, maximum);
  try {
    // Allocate from the validated descriptor, never from a file that may have
    // grown after stat. The extra byte detects growth without an unbounded read.
    const bytes = Buffer.alloc(descriptor.byteSize + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const result = bytes.subarray(0, offset);
    if (offset !== descriptor.byteSize || digest(result) !== descriptor.sha256) throw new Error("canonical artifact integrity mismatch");
    return result;
  } finally { await file.close(); }
}

export async function remainingCadArtifactBytes(directory: string): Promise<number> {
  let retained = 0;
  for await (const entry of await opendir(directory)) {
    const info = await lstat(join(directory, entry.name));
    if (!info.isFile()) throw new Error("invalid CAD temporary artifact");
    retained += info.size;
  }
  const stats = await statfs(directory, { bigint: true });
  const available = stats.bsize * stats.bavail;
  return Math.min(CAD_IMPORT_TEMP_VOLUME_BYTES - retained, Number(available > BigInt(CAD_IMPORT_TEMP_VOLUME_BYTES)
    ? BigInt(CAD_IMPORT_TEMP_VOLUME_BYTES) : available)) - CAD_IMPORT_TEMP_FILESYSTEM_OVERHEAD_BYTES;
}

export async function* readCanonicalElements(directory: string, artifact: CadCanonicalArtifact, signal?: AbortSignal): AsyncGenerator<MapElement> {
  if (signal?.aborted) throw new Error("canonical spool aborted");
  if (!canonicalArtifactSchema.safeParse(artifact).success) throw new Error("invalid canonical artifact");
  const { filename, byteSize, sha256 } = artifact.elements;
  const file = await openArtifact(directory, { filename, byteSize, sha256 }, CANONICAL_SPOOL_MAX_BYTES);
  let pending = Buffer.alloc(0), count = 0, total = 0, decodedTotal = 0;
  const hash = createHash("sha256");
  const decodedHash = createHash("sha256");
  const read = async (bytes: Buffer) => {
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted) throw new Error("canonical spool aborted");
      const result = await file.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    total += offset; hash.update(bytes.subarray(0, offset));
    if (total > byteSize) throw new Error("canonical spool physical size exceeded");
    return offset;
  };
  try {
    while (true) {
      if (signal?.aborted) throw new Error("canonical spool aborted");
      const header = Buffer.allocUnsafe(8);
      const headerSize = await read(header);
      if (!headerSize) break;
      if (headerSize !== 8) throw new Error("truncated canonical gzip frame header");
      const compressedSize = header.readUInt32LE(0), decodedSize = header.readUInt32LE(4);
      if (compressedSize < 20 || compressedSize > FRAME_COMPRESSED_MAX_BYTES ||
          decodedSize < 1 || decodedSize > FRAME_BYTES || compressedSize > byteSize - total) {
        throw new Error("invalid canonical gzip frame size");
      }
      if (decodedTotal + decodedSize > artifact.elements.decodedByteSize) throw new Error("canonical spool decoded size exceeded");
      const compressed = Buffer.allocUnsafe(compressedSize);
      if (await read(compressed) !== compressedSize) throw new Error("truncated canonical gzip frame");
      // Our versioned codec permits only the fixed gzip header emitted by zlib.
      // Raw consumed-byte validation forbids a second member or ignored padding;
      // gunzip additionally verifies the member CRC and ISIZE trailer.
      if (compressed[0] !== 31 || compressed[1] !== 139 || compressed[2] !== 8 || compressed[3] !== 0) {
        throw new Error("invalid canonical gzip frame header");
      }
      // Node's types omit the documented info:true return shape.
      const inflated = inflateRawSync(compressed.subarray(10, -8), { info: true, maxOutputLength: decodedSize }) as unknown as
        { buffer: Buffer; engine: { bytesWritten: number } };
      if (inflated.engine.bytesWritten !== compressedSize - 18) throw new Error("trailing canonical gzip member data");
      const bytes = gunzipSync(compressed, { maxOutputLength: decodedSize });
      if (bytes.length !== decodedSize) throw new Error("canonical gzip frame decoded size mismatch");
      decodedTotal += bytes.length; decodedHash.update(bytes);
      pending = Buffer.concat([pending, bytes]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (signal?.aborted) throw new Error("canonical spool aborted");
        if (newline > ELEMENT_MAX_BYTES) throw new Error("canonical element byte budget exceeded");
        if (++count > artifact.elementCount) throw new Error("canonical element count exceeded");
        const element = mapElementSchema.parse(JSON.parse(pending.subarray(0, newline).toString("utf8")));
        pending = pending.subarray(newline + 1);
        yield element;
      }
      if (pending.length > ELEMENT_MAX_BYTES) throw new Error("canonical element byte budget exceeded");
    }
    if (pending.length || total !== byteSize || hash.digest("hex") !== sha256 ||
        decodedTotal !== artifact.elements.decodedByteSize || decodedHash.digest("hex") !== artifact.elements.decodedSha256) {
      throw new Error("canonical spool integrity mismatch");
    }
    if (count !== artifact.elementCount) throw new Error("canonical element count mismatch");
  } finally { await file.close(); }
}
