import { Injectable } from "@nestjs/common";
import { FloorAsset, Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { gunzipSync } from "node:zlib";
import {
  Bounds, MapAssetRef, MapDocumentRef, MapElement, MapGroup, MapLayer,
  MAP_DOCUMENT_MAX_SELECTED_ELEMENTS, getMapElementBounds, mapBoundsSchema,
  mapAssetRefSchema, mapDocumentRefSchema, mapDocumentStateSchema, mapElementSchema
} from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { decodeMapPayload, encodeMapPayload, MAP_CHUNK_MAX_BYTES, MAP_DOCUMENT_MAX_BYTES, MAP_ENCODED_MAX_BYTES,
  parseMapJson, validateMapChunk } from "./map-document-codec";
import { MapElementLocator, MapIndexSpool, mapIdHash, parseMapIndex } from "./map-document-index";

const PREPARATION_LIFETIME_MS = 60 * 60 * 1000;
const MAX_DESCRIPTORS = 16_384;
const MIME = "application/octet-stream";
export interface PrepareMapGenerationOptions {
  width: number; height: number; gridSize: number;
  groups: MapGroup[]; layers: MapLayer[];
  /** Lower limits are useful for bounded worker jobs; raising hard limits is forbidden. */
  chunkBytes?: number; indexBytes?: number; documentBytes?: number;
}
type GenerationDescriptor = { ordinal: number; asset: MapAssetRef; elementCount: number; bounds: Bounds };
type IndexDescriptor = { prefix: string; asset: MapAssetRef; elementCount: number };
export interface MapGenerationManifest {
  formatVersion: 1; generationId: string; baseRevision: number;
  width: number; height: number; gridSize: number; elementCount: number;
  groups: MapGroup[]; layers: MapLayer[];
  chunks: GenerationDescriptor[]; indexes: IndexDescriptor[];
}
const displaySchema = z.object({ manifest: mapAssetRefSchema,
  tiles: z.array(z.object({ asset: mapAssetRefSchema, tileX: z.number().int().min(0).max(63), tileY: z.number().int().min(0).max(63),
    lod: z.number().int().min(0).max(2), part: z.number().int().min(0).max(127), bounds: mapBoundsSchema }).strict()).max(12_288)
}).strict();
export type MapDisplayAssets = z.infer<typeof displaySchema>;

export function needsMapCheckpoint(changes: number, decodedBytes: number | bigint) {
  return changes >= 100 || decodedBytes >= 32 * 1024 * 1024;
}

@Injectable()
export class MapDocumentStore {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService) {}

  prepareGeneration(floorId: string, elements: AsyncIterable<MapElement>, options: PrepareMapGenerationOptions): Promise<MapDocumentRef> {
    return this.prepare(floorId, elements, options);
  }

  async prepareCheckpoint(floorId: string, expected: MapDocumentRef, elements: AsyncIterable<MapElement>,
    options: Partial<PrepareMapGenerationOptions> = {}): Promise<MapDocumentRef> {
    const manifest = await this.readManifest(floorId, expected);
    return this.prepare(floorId, elements, { width: expected.width, height: expected.height, gridSize: expected.gridSize,
      groups: manifest.groups, layers: manifest.layers, ...options }, expected);
  }

  private async prepare(floorId: string, elements: AsyncIterable<MapElement>, options: PrepareMapGenerationOptions,
    checkpoint?: MapDocumentRef): Promise<MapDocumentRef> {
    const chunkLimit = boundedLimit(options.chunkBytes, MAP_CHUNK_MAX_BYTES);
    const indexLimit = boundedLimit(options.indexBytes, MAP_CHUNK_MAX_BYTES);
    const documentLimit = boundedLimit(options.documentBytes, MAP_DOCUMENT_MAX_BYTES);
    // Structure metadata must fit in the same bounded manifest as its descriptors.
    if (Buffer.byteLength(JSON.stringify({ groups: options.groups, layers: options.layers })) > MAP_CHUNK_MAX_BYTES) {
      throw new Error("map structure decoded byte budget exceeded");
    }
    const structure = mapDocumentStateSchema.parse({ elements: [], groups: options.groups, layers: options.layers });
    const groupIds = new Set(structure.groups.map(group => group.id));
    const layerIds = new Set(structure.layers.map(layer => layer.id));
    const floor = await this.prisma.floor.findUniqueOrThrow({ where: { id: floorId }, select: { mapRevision: true } });
    const id = randomUUID();
    const metadata = mapDocumentRefSchema.omit({ manifest: true }).parse({
      // Import/reset reserves a publication revision without changing the live
      // Floor. Only compaction preserves the current content revision.
      formatVersion: 1, generationId: id, revision: checkpoint?.revision ?? floor.mapRevision + 1,
      width: options.width, height: options.height, gridSize: options.gridSize, elementCount: 0
    });
    await this.prisma.floorMapGeneration.create({ data: {
      id, floorId, baseRevision: metadata.revision, width: metadata.width, height: metadata.height, gridSize: metadata.gridSize,
      sourceGenerationId: checkpoint?.generationId, sourceRevision: checkpoint?.revision,
      expiresAt: new Date(Date.now() + PREPARATION_LIFETIME_MS)
    } });
    const directory = await mkdtemp(join(tmpdir(), "led-map-document-"));
    try {
      const indexes = new MapIndexSpool(directory, indexLimit);
      const chunks: GenerationDescriptor[] = [];
      const shards: IndexDescriptor[] = [];
      let batch: string[] = [];
      let locators: MapElementLocator[] = [];
      let batchBytes = 2;
      let bounds: Bounds | null = null;
      let totalDecoded = 0;
      let count = 0;
      const account = (bytes: number) => {
        totalDecoded += bytes;
        if (totalDecoded > documentLimit) throw new Error("map document decoded byte budget exceeded");
      };
      const flush = async () => {
        if (!batch.length || !bounds) return;
        const decoded = Buffer.from(`[${batch.join(",")}]`);
        account(decoded.length);
        if (chunks.length >= MAX_DESCRIPTORS) throw new Error("map chunk descriptor budget exceeded");
        const ordinal = chunks.length;
        const chunkBounds = mapBoundsSchema.parse(bounds);
        const asset = await this.writeAsset(floorId, id, "map_chunk", decoded, directory, async (tx, assetId) => {
          // Prisma JSON numeric parameters can round a float8 by one ULP. Bind
          // shortest-roundtrip decimal strings, like the existing CAD writer.
          await tx.$executeRaw`INSERT INTO "FloorMapChunk"
            ("id", "floorId", "generationId", "ordinal", "assetId", "decodedBytes", "elementCount", "minX", "minY", "maxX", "maxY")
            VALUES (${randomUUID()}, ${floorId}, ${id}, ${ordinal}, ${assetId}, ${decoded.length}, ${batch.length},
              ${String(chunkBounds.minX)}::double precision, ${String(chunkBounds.minY)}::double precision,
              ${String(chunkBounds.maxX)}::double precision, ${String(chunkBounds.maxY)}::double precision)`;
        });
        await indexes.append(locators);
        chunks.push({ ordinal, asset, elementCount: batch.length, bounds: chunkBounds });
        batch = []; locators = []; batchBytes = 2; bounds = null;
      };
      for await (const input of elements) {
        if (++count > MAP_DOCUMENT_MAX_SELECTED_ELEMENTS) throw new Error("map selected element budget exceeded");
        // Never trust TypeScript's type at an IO boundary. This includes the U2
        // topology work budget and finite transformed bounds, not just JSON size.
        const element = mapElementSchema.parse(input);
        if (!layerIds.has(element.layerId) || (element.groupId !== null && !groupIds.has(element.groupId))) {
          throw new Error("map element references missing group/layer");
        }
        const serialized = JSON.stringify(element);
        const bytes = Buffer.byteLength(serialized);
        if (bytes + 2 > chunkLimit) throw new Error("map single element chunk byte budget exceeded");
        if (batchBytes + bytes + (batch.length ? 1 : 0) > chunkLimit) await flush();
        const elementBounds = getMapElementBounds(element);
        bounds = bounds ? { minX: Math.min(bounds.minX, elementBounds.minX), minY: Math.min(bounds.minY, elementBounds.minY),
          maxX: Math.max(bounds.maxX, elementBounds.maxX), maxY: Math.max(bounds.maxY, elementBounds.maxY) } : elementBounds;
        locators.push([element.id, chunks.length, batch.length]);
        batchBytes += bytes + (batch.length ? 1 : 0); batch.push(serialized);
      }
      await flush();
      for await (const shard of indexes.shards()) {
        account(shard.decoded.length);
        if (shards.length >= MAX_DESCRIPTORS) throw new Error("map index descriptor budget exceeded");
        const asset = await this.writeAsset(floorId, id, "map_index", shard.decoded, directory, async (tx, assetId) => {
          await tx.floorMapIndexShard.create({ data: { floorId, generationId: id, prefix: shard.prefix, assetId,
            decodedBytes: shard.decoded.length, elementCount: shard.elementCount } });
        });
        shards.push({ prefix: shard.prefix, asset, elementCount: shard.elementCount });
      }
      const manifest: MapGenerationManifest = { formatVersion: 1, generationId: id, baseRevision: metadata.revision,
        width: metadata.width, height: metadata.height, gridSize: metadata.gridSize, elementCount: count,
        groups: structure.groups, layers: structure.layers, chunks, indexes: shards };
      const decoded = Buffer.from(JSON.stringify(manifest));
      account(decoded.length);
      const asset = await this.writeAsset(floorId, id, "map_manifest", decoded, directory, async (tx, assetId) => {
        await tx.floorMapGeneration.update({ where: { id }, data: { manifestAssetId: assetId, manifestDecodedBytes: decoded.length } });
      });
      await this.prisma.$transaction(async tx => {
        await lockFloor(tx, floorId);
        await this.assertPreparing(tx, id);
        await tx.floorMapGeneration.update({ where: { id }, data: { status: "prepared", decodedBytes: totalDecoded, elementCount: count } });
      });
      return mapDocumentRefSchema.parse({ ...metadata, elementCount: count, manifest: asset });
    } catch (error) {
      // Uploaded-but-uncommitted objects stay in the FloorAsset ledger. Do not
      // eagerly DELETE after a lost PUT response; ordinary cleanup retries safely.
      await this.discardPreparedGeneration(floorId, id);
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async writeAsset(floorId: string, generationId: string, kind: "map_chunk" | "map_index" | "map_manifest",
    decoded: Buffer, directory: string, attach: (tx: Prisma.TransactionClient, id: string) => Promise<void>): Promise<MapAssetRef> {
    const encoded = encodeMapPayload(decoded);
    const assetId = randomUUID();
    const sha256 = createHash("sha256").update(encoded).digest("hex");
    const objectKey = `floors/${floorId}/${generationId}-${assetId}.mdc`;
    const path = join(directory, `${assetId}.mdc`);
    await writeFile(path, encoded, { flag: "wx", mode: 0o600 });
    await this.prisma.$transaction(async tx => {
      await lockFloor(tx, floorId);
      await this.assertPreparing(tx, generationId);
      await tx.floorAsset.create({ data: { id: assetId, floorId, kind, objectKey, mimeType: MIME,
        sizeBytes: encoded.length, sha256, uploadExpiresAt: new Date(Date.now() + PREPARATION_LIFETIME_MS) } });
      await attach(tx, assetId);
    });
    const expected = { sizeBytes: encoded.length, sha256, contentType: MIME };
    await this.storage.putCadSceneObjectFile(objectKey, path, expected);
    await this.storage.verifyCadSceneObject(objectKey, expected);
    await this.prisma.$transaction(async tx => {
      await lockFloor(tx, floorId);
      await this.assertPreparing(tx, generationId);
      await lockAssets(tx, floorId, [assetId], false);
      const updated = await tx.floorAsset.updateMany({ where: { id: assetId, status: "pending", cleanupStartedAt: null },
        data: { status: "ready", readyAt: new Date() } });
      if (updated.count !== 1) throw new Error("map asset cleanup conflict");
    });
    await rm(path);
    return { assetId, byteSize: encoded.length, decodedByteSize: decoded.length, sha256 };
  }

  private async assertPreparing(tx: Prisma.TransactionClient, id: string) {
    const generation = await tx.floorMapGeneration.findUniqueOrThrow({ where: { id } });
    if (generation.status !== "preparing" || generation.expiresAt.getTime() <= Date.now()) throw new Error("map preparation expired or fenced");
  }

  async discardPreparedGeneration(floorId: string, generationId: string): Promise<void> {
    await this.retirePreparation(floorId, generationId);
  }

  /** Invoke from the migrated worker, not module initialization. Crash leftovers
   * lose their references only after locking and rechecking their state/expiry.
   */
  async reapExpiredPreparations(now = new Date()): Promise<number> {
    const candidates = await this.prisma.floorMapGeneration.findMany({
      where: { status: { in: ["preparing", "prepared"] }, expiresAt: { lte: now },
        preparedImportJobs: { none: {} }, preparedStages: { none: {} } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }], take: 25, select: { floorId: true, id: true }
    });
    let retired = 0;
    for (const candidate of candidates) if (await this.retirePreparation(candidate.floorId, candidate.id, now)) retired++;
    return retired;
  }

  private retirePreparation(floorId: string, generationId: string, expiredBefore?: Date): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      await lockFloor(tx, floorId);
      const generation = await tx.floorMapGeneration.findFirstOrThrow({ where: { id: generationId, floorId } });
      if (expiredBefore && (generation.expiresAt > expiredBefore || !["preparing", "prepared"].includes(generation.status))) return false;
      if (!["preparing", "prepared", "failed"].includes(generation.status) ||
        // A review may last longer than the preparation TTL. The same-floor job
        // pointer pins canonical AND display relations until terminal release.
        await tx.floorImportJob.count({ where: { preparedMapGenerationId: generationId, floorId } }) ||
        await tx.floorMapRevisionAsset.count({ where: { generationId } }) ||
        await tx.floorMapDocument.count({ where: { activeGenerationId: generationId } }) ||
        await tx.floorMapStage.count({ where: { OR: [{ generationId }, { preparedGenerationId: generationId }] } }) ||
        await tx.floorMapChangeSet.count({ where: { generationId } })) {
        if (expiredBefore) return false;
        throw new Error("referenced map generation cannot be discarded");
      }
      await tx.floorMapChunk.deleteMany({ where: { generationId } });
      await tx.floorMapIndexShard.deleteMany({ where: { generationId } });
      await tx.floorMapDisplayAsset.deleteMany({ where: { generationId } });
      await tx.floorMapGeneration.update({ where: { id: generationId }, data: { status: "failed", manifestAssetId: null, manifestDecodedBytes: null } });
      return true;
    });
  }

  /** U4b supplies verified derived files after canonical preparation. This does
   * not build tiles, read all canonical geometry, or require a CAD import job.
   * Display publication is immutable and only allowed before generation activation.
   */
  async attachDisplayAssets(floorId: string, ref: MapDocumentRef, input: MapDisplayAssets): Promise<void> {
    const display = displaySchema.parse(input);
    const descriptors = [{ asset: display.manifest, role: "manifest" as const, bounds: undefined },
      ...display.tiles.map(tile => ({ ...tile, role: "tile" as const }))];
    if (new Set(descriptors.map(row => row.asset.assetId)).size !== descriptors.length) throw new Error("duplicate display asset");
    let decodedBytes = 0, encodedBytes = 0;
    for (const descriptor of descriptors) {
      const max = descriptor.role === "manifest" ? MAP_CHUNK_MAX_BYTES : 16 * 1024 * 1024;
      if (descriptor.asset.byteSize > max || descriptor.asset.decodedByteSize > max) throw new Error("display asset byte budget exceeded");
      decodedBytes += descriptor.asset.decodedByteSize; encodedBytes += descriptor.asset.byteSize;
    }
    if (decodedBytes > MAP_DOCUMENT_MAX_BYTES || encodedBytes > MAP_DOCUMENT_MAX_BYTES) throw new Error("display total byte budget exceeded");
    // S3 inspection stays outside transactions. Recheck the immutable ledger and
    // cleanup claim under Floor -> sorted FloorAsset locks before adding references.
    for (const descriptor of descriptors) {
      const asset = await this.prisma.floorAsset.findFirstOrThrow({ where: { id: descriptor.asset.assetId, floorId } });
      assertDisplayAsset(asset, descriptor.asset, descriptor.role);
      await this.storage.verifyCadSceneObject(asset.objectKey, { sizeBytes: descriptor.asset.byteSize, sha256: descriptor.asset.sha256,
        contentType: asset.mimeType, ...(asset.contentEncoding === "gzip" ? { contentEncoding: "gzip" as const } : {}), bounds: descriptor.bounds });
      const directory = await mkdtemp(join(tmpdir(), "led-map-display-"));
      try {
        const path = join(directory, "display.bin");
        await this.storage.downloadFloorAssetToFile(asset.objectKey, path, { maxBytes: 16 * 1024 * 1024,
          expectedBytes: descriptor.asset.byteSize, expectedSha256: descriptor.asset.sha256, expectedMimeType: asset.mimeType });
        const bytes = await readFile(path);
        if (bytes.length !== descriptor.asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== descriptor.asset.sha256) {
          throw new Error("display encoded integrity mismatch");
        }
        const decoded = asset.contentEncoding === "gzip" ? gunzipSync(bytes, { maxOutputLength: descriptor.asset.decodedByteSize }) : bytes;
        if (decoded.length !== descriptor.asset.decodedByteSize) throw new Error("display decoded byte budget mismatch");
        if (descriptor.role === "manifest") parseMapJson(decoded);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    await this.prisma.$transaction(async tx => {
      await lockFloor(tx, floorId);
      const generation = await this.getGeneration(tx, floorId, ref);
      if (generation.status !== "prepared" || await tx.floorMapDisplayAsset.count({ where: { generationId: ref.generationId } })) {
        throw new Error("display generation is already published or attached");
      }
      await lockAssets(tx, floorId, descriptors.map(row => row.asset.assetId));
      const assets = await tx.floorAsset.findMany({ where: { id: { in: descriptors.map(row => row.asset.assetId) }, floorId } });
      const byId = new Map(assets.map(asset => [asset.id, asset]));
      for (const descriptor of descriptors) assertDisplayAsset(byId.get(descriptor.asset.assetId)!, descriptor.asset, descriptor.role);
      const data: Prisma.FloorMapDisplayAssetCreateManyInput[] = [{ floorId, generationId: ref.generationId,
        assetId: display.manifest.assetId, role: "manifest", decodedBytes: display.manifest.decodedByteSize },
        ...display.tiles.map(tile => ({ floorId, generationId: ref.generationId, assetId: tile.asset.assetId, role: "tile",
          decodedBytes: tile.asset.decodedByteSize, tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part, ...tile.bounds }))];
      for (let start = 0; start < data.length; start += 500) {
        const values = data.slice(start, start + 500).map(row => Prisma.sql`(${randomUUID()}, ${row.floorId}, ${row.generationId},
          ${row.assetId}, ${row.role}, ${row.decodedBytes}, ${row.tileX ?? null}, ${row.tileY ?? null}, ${row.lod ?? null}, ${row.part ?? null},
          ${row.minX == null ? null : String(row.minX)}::double precision, ${row.minY == null ? null : String(row.minY)}::double precision,
          ${row.maxX == null ? null : String(row.maxX)}::double precision, ${row.maxY == null ? null : String(row.maxY)}::double precision)`);
        await tx.$executeRaw(Prisma.sql`INSERT INTO "FloorMapDisplayAsset"
          ("id", "floorId", "generationId", "assetId", "role", "decodedBytes", "tileX", "tileY", "lod", "part", "minX", "minY", "maxX", "maxY")
          VALUES ${Prisma.join(values)}`);
      }
    }, { timeout: 30_000 });
  }

  async readDisplayAssets(floorId: string, ref: MapDocumentRef): Promise<MapDisplayAssets | null> {
    await this.getGeneration(this.prisma, floorId, mapDocumentRefSchema.parse(ref));
    const rows = await this.prisma.floorMapDisplayAsset.findMany({ where: { generationId: ref.generationId }, include: { asset: true },
      orderBy: [{ lod: "asc" }, { tileY: "asc" }, { tileX: "asc" }, { part: "asc" }] });
    if (!rows.length) return null;
    const manifests = rows.filter(row => row.role === "manifest");
    if (manifests.length !== 1) throw new Error("display manifest missing");
    const bounds = await readExactMapBounds(this.prisma, "FloorMapDisplayAsset", ref.generationId);
    const refFor = (row: typeof rows[number]): MapAssetRef => {
      const reference = { assetId: row.assetId, byteSize: Number(row.asset.sizeBytes), decodedByteSize: row.decodedBytes, sha256: row.asset.sha256 };
      assertDisplayAsset(row.asset, reference, row.role);
      return reference;
    };
    return displaySchema.parse({ manifest: refFor(manifests[0]), tiles: rows.filter(row => row.role === "tile").map(row => ({
      asset: refFor(row), tileX: row.tileX, tileY: row.tileY, lod: row.lod, part: row.part,
      bounds: bounds.get(row.id)
    })) });
  }

  async readManifest(floorId: string, reference: MapDocumentRef): Promise<MapGenerationManifest> {
    const ref = mapDocumentRefSchema.parse(reference);
    const generation = await this.getGeneration(this.prisma, floorId, ref);
    const manifest = parseMapJson(await this.readAsset(generation.manifest!, ref.manifest)) as MapGenerationManifest;
    // A descriptor list is bounded by the decoded envelope before parsing. Compare
    // it with the relational ledger so untrusted manifests cannot redirect reads.
    if (manifest.formatVersion !== 1 || manifest.generationId !== ref.generationId || manifest.baseRevision !== generation.baseRevision ||
      manifest.width !== ref.width || manifest.height !== ref.height || manifest.gridSize !== ref.gridSize || manifest.elementCount !== generation.elementCount ||
      !Array.isArray(manifest.chunks) || !Array.isArray(manifest.indexes) || manifest.chunks.length > MAX_DESCRIPTORS || manifest.indexes.length > MAX_DESCRIPTORS) {
      throw new Error("map manifest identity mismatch");
    }
    mapDocumentStateSchema.parse({ elements: [], groups: manifest.groups, layers: manifest.layers });
    const chunks = await this.prisma.floorMapChunk.findMany({ where: { generationId: ref.generationId }, include: { asset: true }, orderBy: { ordinal: "asc" } });
    const bounds = await readExactMapBounds(this.prisma, "FloorMapChunk", ref.generationId);
    const indexes = await this.prisma.floorMapIndexShard.findMany({ where: { generationId: ref.generationId }, include: { asset: true }, orderBy: { prefix: "asc" } });
    if (chunks.length !== manifest.chunks.length || indexes.length !== manifest.indexes.length) throw new Error("map manifest ledger count mismatch");
    let count = 0;
    for (let i = 0; i < chunks.length; i++) {
      const row = chunks[i], descriptor = manifest.chunks[i];
      assertAssetRef(row.asset, descriptor.asset, row.decodedBytes);
      if (descriptor.ordinal !== i || row.ordinal !== i || descriptor.elementCount !== row.elementCount ||
        !descriptor.bounds || ["minX", "minY", "maxX", "maxY"].some(key => descriptor.bounds[key as keyof Bounds] !== bounds.get(row.id)?.[key as keyof Bounds])) {
        throw new Error("map chunk manifest mismatch");
      }
      count += row.elementCount;
    }
    for (let i = 0; i < indexes.length; i++) {
      const row = indexes[i], descriptor = manifest.indexes[i];
      assertAssetRef(row.asset, descriptor.asset, row.decodedBytes);
      if (descriptor.prefix !== row.prefix || descriptor.elementCount !== row.elementCount) throw new Error("map index manifest mismatch");
    }
    if (count !== generation.elementCount || indexes.reduce((sum, row) => sum + row.elementCount, 0) !== count) throw new Error("map element ledger count mismatch");
    return manifest;
  }

  /** Reads immutable base geometry only. U6 composes revision deltas separately. */
  async *iterateGeneration(floorId: string, ref: MapDocumentRef): AsyncGenerator<MapElement> {
    const manifest = await this.readManifest(floorId, ref);
    for (const chunk of manifest.chunks) {
      const asset = await this.prisma.floorAsset.findUniqueOrThrow({ where: { id: chunk.asset.assetId } });
      const elements = validateMapChunk(parseMapJson(await this.readAsset(asset, chunk.asset)));
      if (elements.length !== chunk.elementCount) throw new Error("map chunk element count mismatch");
      for (const element of elements) yield element;
    }
  }

  async getElement(floorId: string, ref: MapDocumentRef, id: string): Promise<MapElement | null> {
    const manifest = await this.readManifest(floorId, ref);
    const hash = mapIdHash(id);
    const matches = manifest.indexes.filter(shard => hash.startsWith(shard.prefix));
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error("overlapping map index prefixes");
    const shard = matches[0];
    const asset = await this.prisma.floorAsset.findUniqueOrThrow({ where: { id: shard.asset.assetId } });
    const entries = parseMapIndex(await this.readAsset(asset, shard.asset), shard.prefix);
    if (entries.length !== shard.elementCount) throw new Error("map index element count mismatch");
    const locator = entries.find(entry => entry[0] === id);
    if (!locator) return null;
    const chunk = manifest.chunks[locator[1]];
    if (!chunk) throw new Error("invalid map chunk locator");
    const chunkAsset = await this.prisma.floorAsset.findUniqueOrThrow({ where: { id: chunk.asset.assetId } });
    const elements = validateMapChunk(parseMapJson(await this.readAsset(chunkAsset, chunk.asset)));
    const element = elements[locator[2]];
    if (elements.length !== chunk.elementCount || element?.id !== id) throw new Error("invalid map element locator");
    return element;
  }

  private async readAsset(asset: FloorAsset, ref: MapAssetRef): Promise<Buffer> {
    assertAssetRef(asset, ref, ref.decodedByteSize);
    const directory = await mkdtemp(join(tmpdir(), "led-map-read-"));
    try {
      const path = join(directory, "asset.mdc");
      await this.storage.downloadFloorAssetToFile(asset.objectKey, path, { maxBytes: MAP_ENCODED_MAX_BYTES,
        expectedBytes: ref.byteSize, expectedMimeType: MIME, expectedSha256: ref.sha256 });
      return decodeMapPayload(await readFile(path), ref);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async getGeneration(tx: Prisma.TransactionClient, floorId: string, ref: MapDocumentRef) {
    const generation = await tx.floorMapGeneration.findFirstOrThrow({ where: { id: ref.generationId, floorId }, include: { manifest: true } });
    if (!["prepared", "active", "retired"].includes(generation.status) || !generation.manifest ||
      ref.revision < generation.baseRevision || ref.width !== generation.width || ref.height !== generation.height ||
      ref.gridSize !== generation.gridSize || (ref.revision === generation.baseRevision && ref.elementCount !== generation.elementCount)) {
      throw new Error("map generation identity mismatch");
    }
    assertAssetRef(generation.manifest, ref.manifest, generation.manifestDecodedBytes!);
    return generation;
  }

  async pinRevision(tx: Prisma.TransactionClient, floorId: string, revisionId: string, reference: MapDocumentRef): Promise<void> {
    const ref = mapDocumentRefSchema.parse(reference);
    await lockFloor(tx, floorId);
    await this.getGeneration(tx, floorId, ref);
    const revision = await tx.floorMapRevision.findFirstOrThrow({ where: { id: revisionId, floorId } });
    if (revision.revision !== ref.revision) throw new Error("map revision pin mismatch");
    const ids = await generationAssetIds(tx, ref.generationId, ref.revision);
    await lockAssets(tx, floorId, ids);
    for (let start = 0; start < ids.length; start += 500) {
      await tx.floorMapRevisionAsset.createMany({ data: ids.slice(start, start + 500).map(assetId => ({
        floorId, revisionId, generationId: ref.generationId, assetId })), skipDuplicates: true });
    }
  }

  /** Internal storage compaction only, no content revision increment and no HTTP
   * endpoint. Caller supplies the transaction so history/pointer updates roll back
   * together. U5/U6 own authorization, lease and ordinary publication.
   */
  async commitCheckpoint(tx: Prisma.TransactionClient, floorId: string, expected: MapDocumentRef, prepared: MapDocumentRef): Promise<void> {
    mapDocumentRefSchema.parse(expected); mapDocumentRefSchema.parse(prepared);
    await lockFloor(tx, floorId);
    const head = await tx.floorMapDocument.findUniqueOrThrow({ where: { floorId } });
    if (head.activeGenerationId !== expected.generationId || head.revision !== expected.revision ||
      !needsMapCheckpoint(head.changesSinceCheckpoint, head.deltaDecodedBytes)) throw new Error("map checkpoint conflict");
    const next = await this.getGeneration(tx, floorId, prepared);
    if (next.status !== "prepared" || next.sourceGenerationId !== expected.generationId || next.sourceRevision !== expected.revision ||
      prepared.revision !== expected.revision) throw new Error("map checkpoint preparation mismatch");
    await lockAssets(tx, floorId, await generationAssetIds(tx, prepared.generationId, prepared.revision));
    const swapped = await tx.floorMapDocument.updateMany({ where: { floorId, activeGenerationId: expected.generationId, revision: expected.revision },
      data: { activeGenerationId: prepared.generationId, changesSinceCheckpoint: 0, deltaDecodedBytes: 0 } });
    if (swapped.count !== 1) throw new Error("map checkpoint conflict");
    await tx.floorMapGeneration.update({ where: { id: expected.generationId }, data: { status: "retired" } });
    await tx.floorMapGeneration.update({ where: { id: prepared.generationId }, data: { status: "active" } });
  }
}

function boundedLimit(value: number | undefined, maximum: number) {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error("invalid map byte budget");
  return limit;
}
function assertAssetRef(asset: FloorAsset, ref: MapAssetRef, decoded: number) {
  if (!ref || asset.id !== ref.assetId || asset.status !== "ready" || asset.cleanupStartedAt || asset.mimeType !== MIME ||
    asset.contentEncoding !== null || Number(asset.sizeBytes) !== ref.byteSize || asset.sha256 !== ref.sha256 || decoded !== ref.decodedByteSize ||
    ref.byteSize < 1 || ref.byteSize > MAP_ENCODED_MAX_BYTES || decoded < 1 || decoded > MAP_CHUNK_MAX_BYTES) throw new Error("map asset ledger mismatch");
}
async function lockFloor(tx: Prisma.TransactionClient, floorId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`;
  if (!rows.length) throw new Error("map floor not found");
}
async function lockAssets(tx: Prisma.TransactionClient, floorId: string, ids: string[], ready = true) {
  const sorted = [...new Set(ids)].sort();
  for (let start = 0; start < sorted.length; start += 500) {
    const batch = sorted.slice(start, start + 500);
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; cleanupStartedAt: Date | null }>>(Prisma.sql`
      SELECT "id", "status", "cleanupStartedAt" FROM "FloorAsset" WHERE "floorId" = ${floorId} AND "id" IN (${Prisma.join(batch)}) ORDER BY "id" FOR UPDATE`);
    if (rows.length !== batch.length || rows.some(row => row.cleanupStartedAt || (ready && row.status !== "ready"))) throw new Error("map asset cleanup conflict");
  }
}
async function generationAssetIds(tx: Prisma.TransactionClient, generationId: string, revision: number) {
  const generation = await tx.floorMapGeneration.findUniqueOrThrow({ where: { id: generationId } });
  const chunks = await tx.floorMapChunk.findMany({ where: { generationId }, select: { assetId: true } });
  const indexes = await tx.floorMapIndexShard.findMany({ where: { generationId }, select: { assetId: true } });
  const display = await tx.floorMapDisplayAsset.findMany({ where: { generationId }, select: { assetId: true } });
  const changes = await tx.floorMapChangeSet.findMany({ where: { generationId, resultRevision: { lte: revision } },
    select: { payloadAssetId: true, inverseAssetId: true, requestId: true, baseRevision: true, resultRevision: true }, orderBy: { resultRevision: "asc" } });
  let current = generation.baseRevision;
  for (const change of changes) {
    if (change.baseRevision !== current || change.resultRevision !== current + 1) throw new Error("map revision delta chain is incomplete");
    current = change.resultRevision;
  }
  if (current !== revision) throw new Error("map revision delta chain is incomplete");
  const stages = await tx.floorMapStage.findMany({ where: { generationId, status: "committed", requestId: { in: changes.map(row => row.requestId) } },
    select: { parts: { select: { assetId: true } } } });
  if (!generation.manifestAssetId) throw new Error("map manifest missing");
  return [...new Set([generation.manifestAssetId, ...chunks.map(row => row.assetId), ...indexes.map(row => row.assetId),
    ...display.map(row => row.assetId),
    ...stages.flatMap(stage => stage.parts.map(part => part.assetId)),
    ...changes.flatMap(row => [row.payloadAssetId, row.inverseAssetId])])];
}

function assertDisplayAsset(asset: FloorAsset, ref: MapAssetRef, role: string) {
  if (!asset || asset.id !== ref.assetId || asset.status !== "ready" || asset.cleanupStartedAt || asset.sha256 !== ref.sha256 ||
    Number(asset.sizeBytes) !== ref.byteSize || asset.kind !== (role === "manifest" ? "map_display_manifest" : "map_display_tile") ||
    asset.mimeType !== (role === "manifest" ? "application/json" : "application/octet-stream") ||
    (asset.contentEncoding !== null && asset.contentEncoding !== "gzip")) throw new Error("display asset ledger mismatch");
}

async function readExactMapBounds(tx: Prisma.TransactionClient, table: "FloorMapChunk" | "FloorMapDisplayAsset", generationId: string) {
  // Decode decimal text in JS instead of Prisma's numeric JSON result path.
  // The relation identifier is a closed internal choice, never caller input.
  const relation = table === "FloorMapChunk" ? Prisma.sql`"FloorMapChunk"` : Prisma.sql`"FloorMapDisplayAsset"`;
  const rows = await tx.$queryRaw<Array<{ id: string; minX: string; minY: string; maxX: string; maxY: string }>>(Prisma.sql`
    SELECT "id", "minX"::text, "minY"::text, "maxX"::text, "maxY"::text FROM ${relation}
    WHERE "generationId" = ${generationId} AND "minX" IS NOT NULL`);
  return new Map(rows.map(row => [row.id, mapBoundsSchema.parse({ minX: Number(row.minX), minY: Number(row.minY), maxX: Number(row.maxX), maxY: Number(row.maxY) })]));
}
