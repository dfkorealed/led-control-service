import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Bounds, MapDisplayManifest, MAP_DISPLAY_VERSION, MapAssetRef, MapDocumentRef, MapElement, MapElementOp, MapGroup, MapLayer,
  getMapElementBounds, mapAssetRefSchema, mapBoundsSchema, mapDisplayManifestSchema, mapDocumentRefSchema, MAP_ELEMENT_MAX_ID_LENGTH } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { cadMapDisplayManifestSchema } from "../floor-import/cad-map-preparation.service";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { decodeMapPayload, MAP_CHUNK_MAX_BYTES, MAP_ENCODED_MAX_BYTES, parseMapJson, validateMapChunk } from "./map-document-codec";
import { mapIdHash, parseMapIndex } from "./map-document-index";
import { MapDisplayAssets, MapDocumentStore, MapGenerationManifest } from "./map-document-store";

export const MAP_QUERY_REVISION_READER = Symbol("MAP_QUERY_REVISION_READER");
export const MAP_QUERY_STAGE_PREVIEW_READER = Symbol("MAP_QUERY_STAGE_PREVIEW_READER");
/** A string retains the existing import-job scope; stages are a distinct namespace. */
export type MapQueryScope = string | { stageId: string };
export interface MapQueryStagePreviewReader {
  resolvePreview(floorId: string, stageId: string, user: AuthenticatedUser): Promise<MapDocumentRef>;
}
/** U6 supplies this adapter after its commit/gate; no authorization is cached. */
export interface MapQueryRevisionReader {
  currentRef?(floorId: string): Promise<MapDocumentRef | null>;
  readRevision(floorId: string, ref: MapDocumentRef): Promise<{
    document: MapDocumentRef; groups: MapGroup[]; layers: MapLayer[]; overlay: MapElement[]; deletedIds: string[];
  }>;
}
export interface MapSceneQueryManifest {
  generationId: string; revision: number; canonical: MapAssetRef; display: MapDisplayManifest;
  displayLayerBindings: Array<{ layerName: string; layerId: string }>;
  groups: MapGroup[]; layers: MapLayer[];
}
export interface MapChangesPage {
  generationId: string; revision: number; operations: MapElementOp[]; nextCursor: string | null;
}
export interface MapSelectionPage {
  generationId: string; revision: number; ids: string[]; nextCursor: string | null;
}
const MAX_IDS = 128;
const READ_BYTES = 64 * 1024 * 1024;
const displayEnvelopeSchema = cadMapDisplayManifestSchema.extend({ scene: mapDisplayManifestSchema });
const idSchema = z.string().min(1).max(MAP_ELEMENT_MAX_ID_LENGTH);
const idsSchema = z.object({ ids: z.array(idSchema).max(MAX_IDS) }).strict();
const selectionSchema = z.object({ groupId: idSchema.optional(), layerId: idSchema.optional(), bounds: mapBoundsSchema.optional(),
  limit: z.number().int().min(1).max(MAX_IDS).default(MAX_IDS), cursor: z.string().max(2048).optional() }).strict();
const cursorSchema = z.object({ phase: z.number().int().min(0).max(2), chunk: z.number().int().min(0).max(16_384),
  index: z.number().int().min(0).max(500_000) }).strict();
type Position = z.infer<typeof cursorSchema>;
const cursorEnvelopeSchema = z.object({ version: z.literal(1), binding: z.string().regex(/^[a-f0-9]{64}$/),
  position: cursorSchema }).strict();
type Ledger = { base: MapGenerationManifest; display: MapDisplayAssets | null };
type Revision = Awaited<ReturnType<MapQueryRevisionReader["readRevision"]>>;

/** Only verified immutable data is retained. Size is decoded serialized bytes,
 * not a promise of JS heap size; in-flight distinct loads also have a hard cap. */
export class MapQueryLedgerCache {
  private readonly entries = new Map<string, { value: unknown; size: number }>();
  private readonly flights = new Map<string, Promise<unknown>>();
  private bytes = 0;
  async get<T>(key: string, load: () => Promise<{ value: T; size: number }>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) { this.entries.delete(key); this.entries.set(key, hit); return hit.value as T; }
    const flight = this.flights.get(key); if (flight) return flight as Promise<T>;
    if (this.flights.size >= 4) throw new ServiceUnavailableException("map query capacity exceeded");
    const promise = Promise.resolve().then(load).then(({ value, size }) => {
      if (!Number.isSafeInteger(size) || size < 0 || size > MAP_CHUNK_MAX_BYTES) throw new Error("map cache entry exceeds decoded limit");
      while (this.bytes + size > 32 * 1024 * 1024 && this.entries.size) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.size; this.entries.delete(oldest);
      }
      freeze(value); this.entries.set(key, { value, size }); this.bytes += size;
      return value;
    }).finally(() => { this.flights.delete(key); });
    this.flights.set(key, promise); return promise;
  }
}

@Injectable()
export class MapDocumentReader {
  private readonly cache = new MapQueryLedgerCache();
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly storage: ObjectStorageService, private readonly store: MapDocumentStore,
    @Optional() @Inject(MAP_QUERY_REVISION_READER) private readonly revisions?: MapQueryRevisionReader,
    @Optional() @Inject(MAP_QUERY_STAGE_PREVIEW_READER) private readonly stages?: MapQueryStagePreviewReader) {}

  async getDocument(user: AuthenticatedUser, floorId: string, scope?: MapQueryScope): Promise<MapDocumentRef | null> {
    await this.authorize(user, floorId, scope);
    const ref = await this.reference(user, floorId, scope);
    if (ref) { await this.verifyAsset(floorId, ref.manifest, "map_manifest"); await this.fresh(user, floorId, ref, scope); }
    return ref;
  }

  async getManifest(user: AuthenticatedUser, floorId: string, expected: Pick<MapDocumentRef, "generationId" | "revision">,
    scope?: MapQueryScope): Promise<MapSceneQueryManifest> {
    const ref = await this.begin(user, floorId, expected, scope), ledger = await this.ledger(floorId, ref);
    const state = await this.revision(floorId, ref, ledger);
    let display: MapDisplayManifest, bindings: MapSceneQueryManifest["displayLayerBindings"] = [];
    if (ledger.display) {
      const descriptor = ledger.display.manifest;
      const asset = await this.verifyAsset(floorId, descriptor, "map_display_manifest");
      const envelope = await this.cache.get(this.key(floorId, ref, descriptor, "display"), async () => {
        const raw = parseMapJson(await this.download(asset, descriptor, MAP_CHUNK_MAX_BYTES)) as { scene?: object };
        const result = displayEnvelopeSchema.parse({ ...raw, scene: { ...raw.scene, byteSize: descriptor.byteSize, sha256: descriptor.sha256 } });
        const byId = new Map(ledger.display!.tiles.map(tile => [tile.asset.assetId, tile]));
        if (result.scene.manifestAssetId !== descriptor.assetId || result.scene.tiles.length !== byId.size ||
          result.scene.width !== ref.width || result.scene.height !== ref.height || result.scene.gridSize !== ref.gridSize || result.scene.tiles.some(tile => {
            const stored = byId.get(tile.assetId);
            return !stored || tile.sha256 !== stored.asset.sha256 || tile.byteSize !== stored.asset.byteSize ||
              tile.tileX !== stored.tileX || tile.tileY !== stored.tileY || tile.lod !== stored.lod || tile.part !== stored.part || !sameBounds(tile.bounds, stored.bounds);
          })) throw new Error("map display ledger mismatch");
        return { value: result, size: descriptor.decodedByteSize };
      });
      display = envelope.scene; bindings = envelope.displayLayerBindings;
    } else display = emptyDisplay(ref);
    // Deleted canonical layers remain legal for masked base tiles. Bindings are
    // validated against immutable base metadata, never guessed from layer names.
    const layerIds = new Set(ledger.base.layers.map(layer => layer.id));
    if (new Set(bindings.map(binding => binding.layerName)).size !== bindings.length || bindings.some(binding => !layerIds.has(binding.layerId))) {
      throw new Error("map display layer binding mismatch");
    }
    await this.fresh(user, floorId, ref, scope);
    return { generationId: ref.generationId, revision: ref.revision, canonical: ref.manifest, display,
      displayLayerBindings: bindings, groups: state.groups, layers: state.layers };
  }

  async getTile(user: AuthenticatedUser, floorId: string, expected: Pick<MapDocumentRef, "generationId" | "revision">,
    assetId: string, scope?: MapQueryScope): Promise<Buffer> {
    const ref = await this.begin(user, floorId, expected, scope), ledger = await this.ledger(floorId, ref);
    const tile = ledger.display?.tiles.find(item => item.asset.assetId === assetId);
    if (!tile) throw new NotFoundException("map tile not referenced");
    const asset = await this.verifyAsset(floorId, tile.asset, "map_display_tile", tile.bounds);
    const result = await this.download(asset, tile.asset, 16 * 1024 * 1024);
    await this.fresh(user, floorId, ref, scope); return result;
  }

  async getElements(user: AuthenticatedUser, floorId: string, expected: Pick<MapDocumentRef, "generationId" | "revision">,
    input: unknown, scope?: MapQueryScope): Promise<MapElement[]> {
    const { ids } = parse(idsSchema, input);
    if (new Set(ids).size !== ids.length) throw new BadRequestException("duplicate map IDs");
    const ref = await this.begin(user, floorId, expected, scope), ledger = await this.ledger(floorId, ref);
    const state = await this.revision(floorId, ref, ledger), found = new Map<string, MapElement>();
    const overlay = new Map(state.overlay.map(e => [e.id, e])), deleted = new Set(state.deletedIds);
    const byShard = new Map<string, Set<string>>(), byChunk = new Map<number, Array<[string, number]>>();
    for (const id of ids) {
      if (overlay.has(id)) { found.set(id, overlay.get(id)!); continue; }
      if (deleted.has(id)) continue;
      const hash = mapIdHash(id), matches = ledger.base.indexes.filter(shard => hash.startsWith(shard.prefix));
      if (matches.length > 1) throw new Error("overlapping map index prefixes");
      if (!matches.length) continue;
      const prefix = matches[0].prefix, wanted = byShard.get(prefix) ?? new Set(); wanted.add(id); byShard.set(prefix, wanted);
    }
    let consumed = 0;
    const read = async (asset: MapAssetRef, kind: string) => {
      consumed += asset.decodedByteSize;
      if (consumed > READ_BYTES) throw new BadRequestException("map read budget exceeded; request fewer IDs");
      return this.payload(floorId, ref, asset, kind);
    };
    for (const [prefix, wanted] of byShard) {
      const shard = ledger.base.indexes.find(item => item.prefix === prefix)!;
      const entries = parseMapIndex(await read(shard.asset, "map_index"), prefix);
      if (entries.length !== shard.elementCount) throw new Error("map index count mismatch");
      for (const [id, ordinal, index] of entries) if (wanted.has(id)) {
        const targets = byChunk.get(ordinal) ?? []; targets.push([id, index]); byChunk.set(ordinal, targets);
      }
    }
    let responseBytes = 2;
    for (const [ordinal, targets] of byChunk) {
      const chunk = ledger.base.chunks[ordinal]; if (!chunk) throw new Error("map chunk locator mismatch");
      const elements = validateMapChunk(parseMapJson(await read(chunk.asset, "map_chunk")));
      if (elements.length !== chunk.elementCount) throw new Error("map chunk count mismatch");
      for (const [id, index] of targets) {
        const element = elements[index]; if (element?.id !== id) throw new Error("map element locator mismatch");
        responseBytes += Buffer.byteLength(JSON.stringify(element)) + 1;
        if (responseBytes > MAP_CHUNK_MAX_BYTES) throw new BadRequestException("map response byte limit exceeded");
        found.set(id, element);
      }
    }
    const result = ids.flatMap(id => found.has(id) ? [found.get(id)!] : []);
    if (Buffer.byteLength(JSON.stringify(result)) > MAP_CHUNK_MAX_BYTES) throw new BadRequestException("map response byte limit exceeded");
    await this.fresh(user, floorId, ref, scope); return result;
  }

  async getChanges(user: AuthenticatedUser, floorId: string, expected: Pick<MapDocumentRef, "generationId" | "revision">,
    cursor?: string, scope?: MapQueryScope): Promise<MapChangesPage> {
    const ref = await this.begin(user, floorId, expected, scope), ledger = await this.ledger(floorId, ref);
    const state = await this.revision(floorId, ref, ledger), operations: MapElementOp[] = [];
    const context = JSON.stringify([floorId, scope ?? null, ref, "changes"]);
    let size = 256;
    const nextCursor = await this.scan(floorId, ref, ledger, state, context, cursor, !ledger.display, true, op => {
      const bytes = Buffer.byteLength(JSON.stringify(op)) + 1;
      if (operations.length >= MAX_IDS || size + bytes > MAP_CHUNK_MAX_BYTES - 2048) {
        if (!operations.length) throw new BadRequestException("map operation exceeds page byte limit");
        return false;
      }
      operations.push(op); size += bytes; return true;
    });
    await this.fresh(user, floorId, ref, scope);
    return { generationId: ref.generationId, revision: ref.revision, operations, nextCursor };
  }

  async select(user: AuthenticatedUser, floorId: string, expected: Pick<MapDocumentRef, "generationId" | "revision">,
    input: unknown, scope?: MapQueryScope): Promise<MapSelectionPage> {
    const filter = parse(selectionSchema, input);
    const ref = await this.begin(user, floorId, expected, scope), ledger = await this.ledger(floorId, ref);
    const state = await this.revision(floorId, ref, ledger), ids: string[] = [];
    const groupIds = new Set(filter.groupId ? [filter.groupId] : []);
    // Reverse-ordered deep hierarchies must not turn a bounded metadata load
    // into quadratic work. Geometry itself stays chunk/page bounded.
    if (filter.groupId) {
      const children = new Map<string, string[]>();
      for (const group of state.groups) {
        const parent = group.parentId;
        if (parent !== null) { const ids = children.get(parent) ?? []; ids.push(group.id); children.set(parent, ids); }
      }
      const pending = [filter.groupId];
      for (let i = 0; i < pending.length; i++) for (const id of children.get(pending[i]) ?? []) if (!groupIds.has(id)) {
        groupIds.add(id); pending.push(id);
      }
    }
    const context = JSON.stringify([floorId, scope ?? null, ref, "selection", filter.groupId ?? null, filter.layerId ?? null, filter.bounds ?? null, filter.limit]);
    const nextCursor = await this.scan(floorId, ref, ledger, state, context, filter.cursor, true, false, op => {
      if (op.kind === "delete") return true;
      const e = op.element;
      if ((filter.groupId && (!e.groupId || !groupIds.has(e.groupId))) || (filter.layerId && e.layerId !== filter.layerId) ||
        (filter.bounds && !overlaps(filter.bounds, getMapElementBounds(e)))) return true;
      if (ids.length >= filter.limit) return false;
      ids.push(e.id); return true;
    }, filter.bounds);
    await this.fresh(user, floorId, ref, scope);
    return { generationId: ref.generationId, revision: ref.revision, ids, nextCursor };
  }

  private async scan(floorId: string, ref: MapDocumentRef, ledger: Ledger, state: Revision, context: string,
    cursor: string | undefined, includeBase: boolean, includeDeleted: boolean, visit: (op: MapElementOp) => boolean, bounds?: Bounds) {
    const position = this.decodeCursor(cursor, context), masked = new Set([...state.deletedIds, ...state.overlay.map(e => e.id)]);
    const available = position.phase === 0 ? state.deletedIds.length : position.phase === 1 ? state.overlay.length :
      ledger.base.chunks[position.chunk]?.elementCount ?? 0;
    if (position.index > available || (position.phase < 2 && position.chunk !== 0) ||
      position.chunk > ledger.base.chunks.length || (!includeBase && position.phase === 2 && (position.chunk !== 0 || position.index !== 0))) {
      throw new BadRequestException("invalid map cursor position");
    }
    let consumed = 0;
    if (position.phase === 0) {
      if (includeDeleted) for (; position.index < state.deletedIds.length; position.index++) {
        if (!visit({ kind: "delete", id: state.deletedIds[position.index] })) return this.encodeCursor(position, context);
      }
      position.phase = 1; position.index = 0;
    }
    if (position.phase === 1) {
      for (; position.index < state.overlay.length; position.index++) {
        if (!visit({ kind: "add", element: state.overlay[position.index] })) return this.encodeCursor(position, context);
      }
      position.phase = 2; position.index = 0;
    }
    if (includeBase) for (; position.chunk < ledger.base.chunks.length; position.chunk++, position.index = 0) {
      const chunk = ledger.base.chunks[position.chunk];
      if (bounds && !overlaps(bounds, chunk.bounds)) continue;
      if (consumed + chunk.asset.decodedByteSize > READ_BYTES) return this.encodeCursor(position, context);
      consumed += chunk.asset.decodedByteSize;
      const elements = validateMapChunk(parseMapJson(await this.payload(floorId, ref, chunk.asset, "map_chunk")));
      if (elements.length !== chunk.elementCount) throw new Error("map chunk count mismatch");
      for (; position.index < elements.length; position.index++) {
        const element = elements[position.index];
        if (!masked.has(element.id) && !visit({ kind: "add", element })) return this.encodeCursor(position, context);
      }
    }
    return null;
  }

  private async authorize(user: AuthenticatedUser, floorId: string, scope?: MapQueryScope) {
    const floor = await this.prisma.floor.findUnique({ where: { id: floorId }, select: { id: true, siteId: true, status: true } });
    if (!floor || floor.status !== "active") throw new NotFoundException("floor not found");
    await this.access.assert(user, floor.siteId, scope ? "manage" : "read");
  }
  private async reference(user: AuthenticatedUser, floorId: string, scope?: MapQueryScope): Promise<MapDocumentRef | null> {
    if (typeof scope === "object") {
      // Only U6's ready-stage authority can resolve a private preview. Reuse it
      // after I/O too; neither cached metadata nor a client generation is a pin.
      if (!this.stages) throw new ServiceUnavailableException("map stage preview reader not connected");
      return mapDocumentRefSchema.parse(await this.stages.resolvePreview(floorId, scope.stageId, user));
    }
    const jobId = scope;
    if (jobId) {
      const job = await this.prisma.floorImportJob.findFirst({ where: { id: jobId, floorId } });
      if (!job || job.floorId !== floorId || job.id !== jobId || job.status !== "review_required" || !job.preparedMapGenerationId) {
        throw new NotFoundException("prepared map review not found");
      }
      const generation = await this.prisma.floorMapGeneration.findFirst({ where: { id: job.preparedMapGenerationId, floorId }, include: { manifest: true } });
      if (!generation || generation.floorId !== floorId || generation.id !== job.preparedMapGenerationId || generation.status !== "prepared" || !generation.manifest) {
        throw new NotFoundException("prepared map review not found");
      }
      return mapDocumentRefSchema.parse({ formatVersion: generation.formatVersion, generationId: generation.id, revision: generation.baseRevision,
        width: generation.width, height: generation.height, gridSize: generation.gridSize, elementCount: generation.elementCount,
        manifest: { assetId: generation.manifest.id, byteSize: Number(generation.manifest.sizeBytes), sha256: generation.manifest.sha256, decodedByteSize: generation.manifestDecodedBytes } });
    }
    // U6 owns snapshot/checkpoint pointer semantics, including a new generation
    // at the same content revision. Re-resolve through it on every fresh check.
    const ref = this.revisions?.currentRef ? await this.revisions.currentRef(floorId)
      : await new MapDocumentRevisionData(this.prisma, this.storage, this.store).currentRef(floorId);
    return ref ? mapDocumentRefSchema.parse(ref) : null;
  }
  private async begin(user: AuthenticatedUser, floorId: string, expected: Pick<MapDocumentRef, "generationId" | "revision">, scope?: MapQueryScope) {
    await this.authorize(user, floorId, scope);
    const ref = await this.reference(user, floorId, scope);
    if (!ref) throw new NotFoundException("map document not found");
    if (ref.generationId !== expected.generationId || ref.revision !== expected.revision) throw new ConflictException("map document reference changed");
    return ref;
  }
  private async fresh(user: AuthenticatedUser, floorId: string, expected: MapDocumentRef, scope?: MapQueryScope) {
    const current = await this.reference(user, floorId, scope);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new ConflictException("map document reference changed");
  }
  private async ledger(floorId: string, ref: MapDocumentRef): Promise<Ledger> {
    await this.verifyAsset(floorId, ref.manifest, "map_manifest");
    const base = await this.cache.get(this.key(floorId, ref, ref.manifest, "canonical-ledger"), async () => ({
      value: await this.store.readManifest(floorId, ref), size: ref.manifest.decodedByteSize
    }));
    // Each persisted metadata asset has its own 8 MiB allowance. Combining the
    // canonical and display ledgers would reject otherwise valid large maps.
    const display = await this.cache.get(this.key(floorId, ref, ref.manifest, "display-ledger"), async () => {
      const value = await this.store.readDisplayAssets(floorId, ref);
      return { value, size: Buffer.byteLength(JSON.stringify(value)) };
    });
    return { base, display };
  }
  private async revision(floorId: string, ref: MapDocumentRef, ledger: Ledger): Promise<Revision> {
    if (ref.revision === ledger.base.baseRevision) return { document: ref, groups: ledger.base.groups, layers: ledger.base.layers, overlay: [], deletedIds: [] };
    if (!this.revisions) throw new ServiceUnavailableException("map revision reader not connected");
    const result = await this.revisions.readRevision(floorId, ref);
    if (JSON.stringify(result.document) !== JSON.stringify(ref)) throw new ConflictException("map revision reader mismatch");
    return result;
  }
  private async verifyAsset(floorId: string, reference: MapAssetRef, kind: string, bounds?: Bounds) {
    const ref = mapAssetRefSchema.parse(reference);
    const asset = await this.prisma.floorAsset.findUnique({ where: { id: ref.assetId } });
    const mime = kind === "map_display_manifest" ? "application/json" : "application/octet-stream";
    if (!asset || asset.floorId !== floorId || asset.kind !== kind || asset.status !== "ready" || asset.cleanupStartedAt ||
      asset.sha256 !== ref.sha256 || Number(asset.sizeBytes) !== ref.byteSize || asset.mimeType !== mime ||
      !asset.objectKey.startsWith(`floors/${floorId}/`) || !/^floors\/[^/]+\/[A-Za-z0-9._-]+$/.test(asset.objectKey)) {
      throw new NotFoundException("map asset not available");
    }
    await this.storage.verifyCadSceneObject(asset.objectKey, { sizeBytes: ref.byteSize, sha256: ref.sha256, contentType: mime, bounds });
    return asset;
  }
  private async download(asset: { objectKey: string; mimeType: string }, ref: MapAssetRef, limit: number) {
    const directory = await mkdtemp(join(tmpdir(), "map-query-"));
    try {
      const path = join(directory, "asset");
      await this.storage.downloadFloorAssetToFile(asset.objectKey, path, { maxBytes: limit, expectedBytes: ref.byteSize,
        expectedSha256: ref.sha256, expectedMimeType: asset.mimeType });
      const bytes = await readFile(path);
      if (bytes.length !== ref.byteSize || bytes.length > limit || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
        throw new Error("map query integrity mismatch");
      }
      return bytes;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  private async payload(floorId: string, ref: MapDocumentRef, asset: MapAssetRef, kind: string) {
    const row = await this.verifyAsset(floorId, asset, kind);
    // Chunk bytes are not retained in the ledger LRU: one bounded chunk is parsed
    // once per batch, then released. No document-wide geometry clone is created.
    return decodeMapPayload(await this.download(row, asset, MAP_ENCODED_MAX_BYTES), asset);
  }
  private key(floorId: string, ref: MapDocumentRef, asset: MapAssetRef, kind: string) {
    return JSON.stringify([floorId, ref.generationId, asset.assetId, asset.sha256, asset.byteSize, asset.decodedByteSize, kind]);
  }
  private encodeCursor(position: Position, context: string) {
    return Buffer.from(JSON.stringify({ version: 1, binding: this.cursorBinding(context), position })).toString("base64url");
  }
  private cursorBinding(context: string) {
    // This digest binds pagination state, not authority. Clients may choose an
    // offset; every replica still authorizes and validates current references
    // and referenced assets independently before serving any page.
    return createHash("sha256").update("map-document-query-cursor:v1:").update(context).digest("hex");
  }
  private decodeCursor(cursor: string | undefined, context: string): Position {
    if (!cursor) return { phase: 0, chunk: 0, index: 0 };
    if (cursor.length > 2048) throw new BadRequestException("invalid map cursor");
    try {
      const data = Buffer.from(cursor, "base64url");
      if (data.toString("base64url") !== cursor) throw new Error("noncanonical cursor");
      const envelope = cursorEnvelopeSchema.parse(JSON.parse(data.toString("utf8")));
      if (envelope.binding !== this.cursorBinding(context)) throw new Error("cursor scope mismatch");
      return envelope.position;
    }
    catch { throw new BadRequestException("invalid map cursor"); }
  }
}

function emptyDisplay(ref: MapDocumentRef): MapDisplayManifest {
  // Manual base geometry is paged separately; this valid zero-tile display uses
  // common map coordinates without loosening CAD source normalization rules.
  return mapDisplayManifestSchema.parse({ version: MAP_DISPLAY_VERSION, sceneId: ref.generationId, regionId: "manual-empty", manifestAssetId: ref.manifest.assetId,
    width: ref.width, height: ref.height, gridSize: ref.gridSize, padding: 0, tileSize: 512, lodMode: "additive",
    primitiveCount: 0, tileCount: 0, byteSize: ref.manifest.byteSize, sha256: ref.manifest.sha256,
    sourceBounds: { minX: 0, minY: 0, maxX: ref.width, maxY: ref.height },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] });
}
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input); if (!result.success) throw new BadRequestException("invalid map query"); return result.data;
}
function sameBounds(a: Bounds, b: Bounds) { return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY; }
function overlaps(a: Bounds, b: Bounds) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY; }
function freeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
}
