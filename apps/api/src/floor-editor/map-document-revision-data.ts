import { ConflictException, Injectable } from "@nestjs/common";
import { MapAssetRef, MapDocumentRef, MapElement, MapGroup, MapLayer, MapOp,
  editorDocumentChangesSchema, mapDocumentStateSchema } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { MapDocumentStore } from "./map-document-store";
import { parseMapDocumentSnapshot } from "./floor-editor-snapshot";
import { decodeMapPayload, MAP_ENCODED_MAX_BYTES, parseMapJson, validateMapChunk } from "./map-document-codec";
import { mapIdHash, parseMapIndex } from "./map-document-index";

export const MAP_NORMAL_READ_BYTES = 64 * 1024 * 1024;
export const MAP_NORMAL_DELTA_BYTES = 32 * 1024 * 1024;
export const MAP_NORMAL_SELECTED_BYTES = 8 * 1024 * 1024;
export function checkpointRequired(): never {
  throw new ConflictException({ code: "map_checkpoint_required", message: "변경 내용을 정리한 후 다시 저장해 주세요." });
}
export interface MapRevisionData {
  document: MapDocumentRef;
  groups: MapGroup[];
  layers: MapLayer[];
  overlay: MapElement[];
  deletedIds: string[];
  getElements(ids: readonly string[]): Promise<MapElement[]>;
  /** Mutation-only bounded scan, used only when structure deletion requires proof
   * that untouched members do not become dangling references. */
  getMembers(groupIds: ReadonlySet<string>, layerIds: ReadonlySet<string>): Promise<MapElement[]>;
}

/** Private revision data, NOT an authorization cache. HTTP callers must authorize
 * and compare the active reference before/after asynchronous reads. U7 owns that. */
@Injectable()
export class MapDocumentRevisionData {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService,
    private readonly store: MapDocumentStore) {}

  async currentRef(floorId: string, tx: Prisma.TransactionClient = this.prisma): Promise<MapDocumentRef | null> {
    const head = await tx.floorMapDocument.findUnique({ where: { floorId } });
    if (!head) return null;
    const row = await tx.floorMapRevision.findUniqueOrThrow({ where: { floorId_revision: { floorId, revision: head.revision } } });
    const ref = parseMapDocumentSnapshot(row.snapshot).document;
    if (ref.generationId !== head.activeGenerationId || ref.revision !== head.revision) throw new Error("map head snapshot mismatch");
    return ref;
  }

  async readRevision(floorId: string, ref: MapDocumentRef): Promise<MapRevisionData> {
    const manifest = await this.store.readManifest(floorId, ref);
    let consumed = ref.manifest.decodedByteSize;
    const read = async (asset: MapAssetRef, kind: string) => {
      consumed += asset.decodedByteSize;
      if (consumed > MAP_NORMAL_READ_BYTES) checkpointRequired();
      return this.readAsset(floorId, asset, kind);
    };
    const groups = new Map(manifest.groups.map(g => [g.id, g]));
    const layers = new Map(manifest.layers.map(l => [l.id, l]));
    const overlay = new Map<string, MapElement>(), deleted = new Set<string>();
    const deltas = await this.prisma.floorMapChangeSet.findMany({ where: { floorId, generationId: ref.generationId,
      resultRevision: { gt: manifest.baseRevision, lte: ref.revision } }, orderBy: { resultRevision: "asc" }, take: 101,
      include: { payload: true } });
    if (deltas.length > 100 || deltas.reduce((sum, row) => sum + row.decodedBytes, 0) > MAP_NORMAL_DELTA_BYTES) checkpointRequired();
    let revision = manifest.baseRevision, count = manifest.elementCount;
    for (const delta of deltas) {
      if (delta.baseRevision !== revision || delta.resultRevision !== revision + 1) throw new Error("map delta chain gap");
      const asset = { assetId: delta.payloadAssetId, sha256: delta.payload.sha256,
        byteSize: Number(delta.payload.sizeBytes), decodedByteSize: delta.decodedBytes };
      const operations = this.parseOperations(await read(asset, "map_changeset"));
      for (const op of operations) {
        if (op.kind === "add" || op.kind === "update") {
          overlay.set(op.element.id, op.element); deleted.delete(op.element.id);
          if (op.kind === "add") count++;
        } else if (op.kind === "delete") { overlay.delete(op.id); deleted.add(op.id); count--; }
        else if (op.kind === "group.put") groups.set(op.group.id, op.group);
        else if (op.kind === "layer.put") layers.set(op.layer.id, op.layer);
        else if (op.kind === "group.delete") groups.delete(op.id);
        else layers.delete(op.id);
      }
      revision = delta.resultRevision;
    }
    if (revision !== ref.revision || count !== ref.elementCount) throw new Error("map delta revision/count mismatch");
    const structure = { groups: [...groups.values()], layers: [...layers.values()] };
    mapDocumentStateSchema.parse({ ...structure, elements: [] });
    const getElements = async (ids: readonly string[]) => {
      if (ids.length > 2000 || new Set(ids).size !== ids.length) checkpointRequired();
      const found = new Map<string, MapElement>();
      const unresolved = new Set<string>();
      for (const id of ids) {
        if (overlay.has(id)) found.set(id, overlay.get(id)!);
        else if (!deleted.has(id)) unresolved.add(id);
      }
      const byShard = new Map<string, Set<string>>();
      for (const id of unresolved) {
        const hash = mapIdHash(id), matches = manifest.indexes.filter(shard => hash.startsWith(shard.prefix));
        if (matches.length > 1) throw new Error("overlapping map indexes");
        if (!matches.length) continue;
        const prefix = matches[0].prefix, set = byShard.get(prefix) ?? new Set(); set.add(id); byShard.set(prefix, set);
      }
      const byChunk = new Map<number, Array<[string, number]>>();
      for (const [prefix, wanted] of byShard) {
        const shard = manifest.indexes.find(s => s.prefix === prefix)!;
        const entries = parseMapIndex(await read(shard.asset, "map_index"), prefix);
        if (entries.length !== shard.elementCount) throw new Error("map index count mismatch");
        for (const [id, ordinal, index] of entries) if (wanted.has(id)) {
          const locators = byChunk.get(ordinal) ?? []; locators.push([id, index]); byChunk.set(ordinal, locators);
        }
      }
      for (const [ordinal, locators] of byChunk) {
        const chunk = manifest.chunks[ordinal]; if (!chunk) throw new Error("map locator mismatch");
        const elements = validateMapChunk(parseMapJson(await read(chunk.asset, "map_chunk")));
        if (elements.length !== chunk.elementCount) throw new Error("map chunk count mismatch");
        for (const [id, index] of locators) {
          if (elements[index]?.id !== id) throw new Error("map locator mismatch");
          found.set(id, elements[index]);
        }
      }
      const result = ids.flatMap(id => found.has(id) ? [found.get(id)!] : []);
      this.checkSelected(result);
      return result;
    };
    return { document: ref, ...structure, overlay: [...overlay.values()], deletedIds: [...deleted], getElements,
      getMembers: async (groupIds, layerIds) => {
        const members: MapElement[] = [];
        const matches = (e: MapElement) => (e.groupId !== null && groupIds.has(e.groupId)) || layerIds.has(e.layerId);
        for (const chunk of manifest.chunks) {
          const elements = validateMapChunk(parseMapJson(await read(chunk.asset, "map_chunk")));
          if (elements.length !== chunk.elementCount) throw new Error("map chunk count mismatch");
          for (const e of elements) if (!overlay.has(e.id) && !deleted.has(e.id) && matches(e)) members.push(e);
          this.checkSelected(members);
        }
        for (const e of overlay.values()) if (matches(e)) members.push(e);
        this.checkSelected(members); return members;
      } };
  }

  private checkSelected(elements: MapElement[]) {
    if (elements.length > 2000 || Buffer.byteLength(JSON.stringify(elements)) > MAP_NORMAL_SELECTED_BYTES) checkpointRequired();
  }
  private parseOperations(bytes: Buffer): MapOp[] {
    const value = parseMapJson(bytes) as { version: number; operations: unknown };
    if (value?.version !== 1) throw new Error("map delta version mismatch");
    return editorDocumentChangesSchema.parse({ requestId: "internal", generationId: "internal", operations: value.operations }).operations;
  }
  private async readAsset(floorId: string, ref: MapAssetRef, kind: string): Promise<Buffer> {
    const asset = await this.prisma.floorAsset.findUniqueOrThrow({ where: { id: ref.assetId } });
    if (asset.floorId !== floorId || asset.kind !== kind || asset.status !== "ready" || asset.cleanupStartedAt ||
      asset.sha256 !== ref.sha256 || Number(asset.sizeBytes) !== ref.byteSize) throw new Error("map asset ledger mismatch");
    const directory = await mkdtemp(join(tmpdir(), "led-map-revision-"));
    try {
      const path = join(directory, "asset.mdc");
      await this.storage.downloadFloorAssetToFile(asset.objectKey, path, { maxBytes: MAP_ENCODED_MAX_BYTES,
        expectedBytes: ref.byteSize, expectedMimeType: "application/octet-stream", expectedSha256: ref.sha256 });
      return decodeMapPayload(await readFile(path), ref);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
