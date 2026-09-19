import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Bounds, MapAssetRef, MapDocumentRef, MapElement, MapOp, SaveEditorStateInput } from "@led-control/shared";
import { FloorAssetKind, Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { MapDocumentStore, MapDisplayAssets } from "./map-document-store";
import { MapDocumentRevisionData, MapRevisionData } from "./map-document-revision-data";
import { prepareBulkMap } from "./map-document-bulk";
import { buildMapDisplay } from "./map-display-builder";
import { encodeMapPayload } from "./map-document-codec";

@Injectable()
export class MapDocumentCheckpointService {
  private active = false;
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService,
    private readonly store: MapDocumentStore, private readonly data: MapDocumentRevisionData) {}

  async prepare(floorId: string, source: MapDocumentRef, operations: AsyncIterable<MapOp>,
    floorPlan?: SaveEditorStateInput["floorPlan"], check = () => {}): Promise<MapDocumentRef> {
    if (this.active) throw new ServiceUnavailableException("map preparation capacity exhausted");
    this.active = true;
    let directory: string | undefined;
    let prepared: MapDocumentRef | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "led-map-checkpoint-"));
      const state = await this.data.readRevision(floorId, source);
      const dimensions = floorPlan ?? source;
      const bulk = await prepareBulkMap(directory, this.iterate(floorId, source, state), operations,
        { ...state, width: dimensions.width, height: dimensions.height }, check);
      prepared = await this.store.prepareGeneration(floorId, bulk.elements(), {
        width: dimensions.width, height: dimensions.height, gridSize: dimensions.gridSize, groups: bulk.groups, layers: bulk.layers
      });
      check();
      await this.display(floorId, prepared, bulk.layers.map(layer => ({ layerName: layer.id, layerId: layer.id })), check);
      return prepared;
    } catch (error) {
      if (prepared) await this.store.discardPreparedGeneration(floorId, prepared.generationId);
      throw error;
    } finally {
      this.active = false;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async *iterate(floorId: string, ref: MapDocumentRef, state?: MapRevisionData): AsyncGenerator<MapElement> {
    const revision = state ?? await this.data.readRevision(floorId, ref);
    // Existing persisted delta accounting bounds this overlay to 32 MiB. Base
    // geometry remains one <=8 MiB chunk, regardless of canonical element count.
    const overlay = new Map(revision.overlay.map(element => [element.id, element]));
    const deleted = new Set(revision.deletedIds);
    for await (const element of this.store.iterateGeneration(floorId, ref)) {
      if (!overlay.has(element.id) && !deleted.has(element.id)) yield element;
    }
    yield* overlay.values();
  }

  async activate(tx: Prisma.TransactionClient, floorId: string, expected: MapDocumentRef, prepared: MapDocumentRef) {
    const generation = await tx.floorMapGeneration.findFirst({ where: { id: prepared.generationId, floorId, status: "prepared" } });
    if (!generation || generation.baseRevision !== expected.revision + 1 || prepared.revision !== expected.revision + 1 ||
      generation.manifestAssetId !== prepared.manifest.assetId) throw new ConflictException("map preparation revision conflict");
    const changed = await tx.floorMapDocument.updateMany({ where: { floorId, activeGenerationId: expected.generationId, revision: expected.revision },
      data: { activeGenerationId: prepared.generationId, revision: prepared.revision, changesSinceCheckpoint: 0, deltaDecodedBytes: 0 } });
    if (changed.count !== 1) throw new ConflictException("map document revision conflict");
    await tx.floorMapGeneration.update({ where: { id: expected.generationId }, data: { status: "retired" } });
    await tx.floorMapGeneration.update({ where: { id: prepared.generationId }, data: { status: "active" } });
    await tx.floor.update({ where: { id: floorId }, data: { mapRevision: prepared.revision } });
  }

  async writeAsset(floorId: string, kind: Extract<FloorAssetKind, "map_stage_part" | "map_changeset" | "map_display_manifest" | "map_display_tile">,
    decoded: Buffer, options: { id?: string; bounds?: Bounds } = {}): Promise<MapAssetRef> {
    const binary = kind === "map_stage_part" || kind === "map_changeset";
    const bytes = binary ? encodeMapPayload(decoded) : decoded;
    const id = options.id ?? randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex");
    const mimeType = kind === "map_display_manifest" ? "application/json" : "application/octet-stream";
    const objectKey = `floors/${floorId}/${id}.bin`, directory = await mkdtemp(join(tmpdir(), "led-map-asset-"));
    try {
      const path = join(directory, "asset"); await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      await this.prisma.floorAsset.create({ data: { id, floorId, kind, objectKey, mimeType, sizeBytes: bytes.length, sha256,
        uploadExpiresAt: new Date(Date.now() + 3600000) } });
      const b = options.bounds, metadata = b ? { "cad-min-x": String(b.minX), "cad-min-y": String(b.minY),
        "cad-max-x": String(b.maxX), "cad-max-y": String(b.maxY) } : undefined;
      const expected = { sizeBytes: bytes.length, sha256, contentType: mimeType, metadata, bounds: b };
      await this.storage.putCadSceneObjectFile(objectKey, path, expected);
      await this.storage.verifyCadSceneObject(objectKey, expected);
      const ready = await this.prisma.floorAsset.updateMany({ where: { id, status: "pending", cleanupStartedAt: null },
        data: { status: "ready", readyAt: new Date(), uploadExpiresAt: null } });
      if (ready.count !== 1) throw new ConflictException("map asset cleanup conflict");
      return { assetId: id, sha256, byteSize: bytes.length, decodedByteSize: decoded.length };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async display(floorId: string, ref: MapDocumentRef, displayLayerBindings: Array<{ layerName: string; layerId: string }>, check: () => void) {
    const tiles: MapDisplayAssets["tiles"] = [];
    const manifest = await buildMapDisplay(ref, this.store.iterateGeneration(floorId, ref), async tile => {
      check();
      const asset = await this.writeAsset(floorId, "map_display_tile", tile.payload, { id: tile.descriptor.assetId, bounds: tile.descriptor.bounds });
      const { tileX, tileY, lod, part, bounds } = tile.descriptor;
      tiles.push({ asset, tileX, tileY, lod, part, bounds });
    }, check);
    const { byteSize: _bytes, sha256: _hash, ...scene } = manifest;
    const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, scene, displayLayerBindings,
      unsupportedEntityCounts: {}, unconvertedEntityCounts: {} }));
    if (bytes.length > 8 * 1024 * 1024) throw new Error("map display manifest budget exceeded");
    const asset = await this.writeAsset(floorId, "map_display_manifest", bytes, { id: manifest.manifestAssetId });
    await this.store.attachDisplayAssets(floorId, ref, { manifest: asset, tiles });
  }
}
