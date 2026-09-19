import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { open, writeFile, opendir, statfs, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { mapElementSchema, mapDocumentStateSchema, type MapElement } from "@led-control/shared";
import { buildCadScene, type BuiltMapDisplayScene } from "./cad-scene-builder";
import { cadScenePersistenceIdentity } from "./cad-scene-persistence";
import { CAD_MAP_MAX_METADATA_BYTES, createCadMapElementConverter, type CadMapConversionMetadata } from "./map-element-converter";
import type { NormalizedCadDocument } from "./cad-types";
import type { CadDetectedRegion } from "./cad-region-detector";
import { CAD_IMPORT_TEMP_FILESYSTEM_OVERHEAD_BYTES, CAD_IMPORT_TEMP_VOLUME_BYTES } from "./cad-resource-limits";

export const CANONICAL_SPOOL_MAX_BYTES = 512 * 1024 * 1024;
const ELEMENT_MAX_BYTES = 8 * 1024 * 1024 - 2;
const fileSchema = z.object({ filename: z.string().regex(/^[a-f0-9-]{36}\.(ndjson|json|bin)$/),
  byteSize: z.number().int().min(0).max(CANONICAL_SPOOL_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const canonicalArtifactSchema = z.object({ elements: fileSchema, metadata: fileSchema.extend({ byteSize: z.number().int().positive().max(CAD_MAP_MAX_METADATA_BYTES) }),
  elementCount: z.number().int().min(0).max(500_000) }).strict();
export type CadCanonicalArtifact = z.infer<typeof canonicalArtifactSchema>;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The builder callback is synchronous. Blocking bounded writes in the isolated
 * child provide backpressure without retaining another expanded geometry graph. */
export async function buildCanonicalCadScene(document: NormalizedCadDocument, region: CadDetectedRegion,
  jobId: string, directory: string, limits: { maxBytes?: number } = {}) {
  const maximum = limits.maxBytes ?? CANONICAL_SPOOL_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > CANONICAL_SPOOL_MAX_BYTES) throw new Error("invalid canonical byte limit");
  const filename = `${randomUUID()}.ndjson`;
  const fd = openSync(join(directory, filename), "wx", 0o600);
  const hash = createHash("sha256");
  let byteSize = 0;
  let count = 0;
  const converter = createCadMapElementConverter({ importJobId: jobId, regionBounds: region.bounds,
    unsupportedEntityCounts: document.unsupportedEntityCounts });
  const identity = cadScenePersistenceIdentity(jobId, region.regionId);
  let built: BuiltMapDisplayScene;
  try {
    built = buildCadScene(document, region, { displayVersion: 2, sceneId: identity.sceneId, manifestAssetId: identity.manifestAssetId,
      tileAssetId: identity.tileAssetId, onSemanticEntity: semantic => {
        const stored = converter.convertSemanticEntity(semantic);
        for (const element of stored) {
          if (++count > 500_000) throw new Error("canonical element count exceeded");
          const bytes = Buffer.from(`${JSON.stringify(element)}\n`);
          if (bytes.length - 1 > ELEMENT_MAX_BYTES || byteSize + bytes.length > maximum) throw new Error("canonical spool byte budget exceeded");
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
          hash.update(bytes); byteSize += bytes.length;
        }
        // Return the exact persisted IDs, not a void notification or a second conversion.
        return stored;
      } });
  } finally { closeSync(fd); }
  const metadata = converter.getMetadata();
  if (metadata.elementCount > 500_000) throw new Error("canonical element count exceeded");
  const payload = Buffer.from(JSON.stringify(metadata));
  const metadataFilename = `${randomUUID()}.json`;
  await writeFile(join(directory, metadataFilename), payload, { flag: "wx", mode: 0o600 });
  return { built, canonical: canonicalArtifactSchema.parse({ elements: { filename, byteSize, sha256: hash.digest("hex") },
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
  const file = await openArtifact(directory, artifact.elements, CANONICAL_SPOOL_MAX_BYTES);
  const stream = file.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
  let pending = Buffer.alloc(0), count = 0, total = 0;
  const hash = createHash("sha256");
  try {
    for await (const input of stream) {
      if (signal?.aborted) throw new Error("canonical spool aborted");
      const bytes = input as Buffer; total += bytes.length; hash.update(bytes);
      if (total > artifact.elements.byteSize) throw new Error("canonical spool size exceeded");
      pending = Buffer.concat([pending, bytes]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline > ELEMENT_MAX_BYTES) throw new Error("canonical element byte budget exceeded");
        if (++count > artifact.elementCount) throw new Error("canonical element count exceeded");
        const element = mapElementSchema.parse(JSON.parse(pending.subarray(0, newline).toString("utf8")));
        pending = pending.subarray(newline + 1);
        yield element;
      }
      if (pending.length > ELEMENT_MAX_BYTES) throw new Error("canonical element byte budget exceeded");
    }
    if (pending.length || total !== artifact.elements.byteSize || hash.digest("hex") !== artifact.elements.sha256) {
      throw new Error("canonical spool integrity mismatch");
    }
    if (count !== artifact.elementCount) throw new Error("canonical element count mismatch");
  } finally { stream.destroy(); await file.close(); }
}
