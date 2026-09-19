import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mapDisplayManifestSchema, mapDocumentRefSchema, type MapDisplayManifest, type MapDocumentRef } from "@led-control/shared";
import { MapDocumentStore, type MapDisplayAssets } from "../floor-editor/map-document-store";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { CAD_MAP_MAX_METADATA_BYTES } from "./map-element-converter";
import { readCanonicalElements, readCanonicalMetadata, readVerifiedCadArtifact, type CadCanonicalArtifact } from "./cad-canonical-spool";
import { decodeMapDisplayTile } from "./cad-scene-codec";

const counts = z.record(z.number().int().nonnegative());
export const cadMapDisplayManifestSchema = z.object({ formatVersion: z.literal(1), scene: mapDisplayManifestSchema,
  displayLayerBindings: z.array(z.object({ layerName: z.string(), layerId: z.string() }).strict()),
  unsupportedEntityCounts: counts, unconvertedEntityCounts: counts }).strict();
export type CadMapDisplayManifest = z.infer<typeof cadMapDisplayManifestSchema>;
export interface CadMapAttemptFence { id: string; floorId: string; attemptCount: number; leaseOwner: string }

@Injectable()
export class CadMapPreparationService {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService,
    private readonly store: MapDocumentStore) {}

  async prepare(floorId: string, directory: string, canonical: CadCanonicalArtifact,
    sceneInput: MapDisplayManifest, signal?: AbortSignal): Promise<MapDocumentRef> {
    signal?.throwIfAborted();
    const metadata = await readCanonicalMetadata(directory, canonical);
    const scene = mapDisplayManifestSchema.parse(sceneInput);
    if (metadata.width !== scene.width || metadata.height !== scene.height) throw new Error("canonical/display dimensions mismatch");
    const ref = await this.store.prepareGeneration(floorId, readCanonicalElements(directory, canonical, signal), metadata);
    try {
      signal?.throwIfAborted();
      const display: MapDisplayAssets = { manifest: ref.manifest, tiles: [] };
      const mappedTiles: MapDisplayManifest["tiles"] = [];
      for (const tile of scene.tiles) {
        signal?.throwIfAborted();
        const path = join(directory, `${tile.assetId}.bin`);
        // The decoder validates bounded binary framing, hash, IDs and primitive
        // counts. This reads one compact tile, never reconstructs canonical geometry.
        const bytes = await readVerifiedCadArtifact(directory,
          { filename: `${tile.assetId}.bin`, byteSize: tile.byteSize, sha256: tile.sha256 }, 16 * 1024 * 1024);
        decodeMapDisplayTile(bytes, tile);
        const asset = await this.writeDisplayAsset(floorId, ref.generationId, "map_display_tile", path, bytes,
          "application/octet-stream", signal, tile.bounds);
        mappedTiles.push({ ...tile, assetId: asset.assetId });
        display.tiles.push({ asset, tileX: tile.tileX, tileY: tile.tileY, lod: tile.lod, part: tile.part, bounds: tile.bounds });
      }
      const manifestId = randomUUID();
      // U9 reads this small envelope directly; layer bindings and diagnostics are
      // not hidden inside the original DWG, canonical chunks or temporary spool.
      const envelope = cadMapDisplayManifestSchema.parse({ formatVersion: 1,
        scene: { ...scene, manifestAssetId: manifestId, tiles: mappedTiles },
        displayLayerBindings: metadata.displayLayerBindings,
        unsupportedEntityCounts: metadata.unsupportedEntityCounts, unconvertedEntityCounts: metadata.unconvertedEntityCounts });
      // Like the existing CAD manifest, its own byte size/hash live in the
      // immutable asset ledger, not in a self-referential JSON hash field.
      const { byteSize: _byteSize, sha256: _sha256, ...storedScene } = envelope.scene;
      const bytes = Buffer.from(JSON.stringify({ ...envelope, scene: storedScene }));
      if (bytes.length > CAD_MAP_MAX_METADATA_BYTES) throw new Error("map display manifest byte budget exceeded");
      const path = join(directory, `${manifestId}.json`);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      display.manifest = await this.writeDisplayAsset(floorId, ref.generationId, "map_display_manifest", path, bytes,
        "application/json", signal, undefined, manifestId);
      await this.store.attachDisplayAssets(floorId, ref, display);
      signal?.throwIfAborted();
      return ref;
    } catch (error) {
      await this.store.discardPreparedGeneration(floorId, ref.generationId);
      throw error;
    }
  }

  private async writeDisplayAsset(floorId: string, generationId: string, kind: "map_display_manifest" | "map_display_tile",
    path: string, bytes: Buffer, mimeType: string, signal?: AbortSignal,
    bounds?: { minX: number; minY: number; maxX: number; maxY: number }, id = randomUUID()) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `floors/${floorId}/${generationId}-${id}.${kind === "map_display_tile" ? "bin" : "json"}`;
    await this.prisma.floorAsset.create({ data: { id, floorId, kind, objectKey, mimeType,
      sizeBytes: bytes.length, sha256, uploadExpiresAt: new Date(Date.now() + 60 * 60_000) } });
    const metadata = bounds ? { "cad-min-x": String(bounds.minX), "cad-min-y": String(bounds.minY),
      "cad-max-x": String(bounds.maxX), "cad-max-y": String(bounds.maxY) } : undefined;
    const expected = { sizeBytes: bytes.length, sha256, contentType: mimeType, metadata, bounds };
    await this.storage.putCadSceneObjectFile(objectKey, path, expected, signal);
    await this.storage.verifyCadSceneObject(objectKey, expected, signal);
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`;
      const updated = await tx.floorAsset.updateMany({ where: { id, floorId, status: "pending", cleanupStartedAt: null },
        data: { status: "ready", readyAt: new Date(), uploadExpiresAt: null } });
      if (updated.count !== 1) throw new Error("map display cleanup conflict");
    });
    return { assetId: id, byteSize: bytes.length, decodedByteSize: bytes.length, sha256 };
  }

  /** Called inside the worker's final transaction, before review_required. This
   * does not activate the map. Floor -> job locking is shared with reset/cancel. */
  async pinPrepared(tx: Prisma.TransactionClient, attempt: CadMapAttemptFence, ref: MapDocumentRef) {
    await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${attempt.floorId} FOR UPDATE`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT job."id" FROM "FloorImportJob" job
      JOIN "FloorMapGeneration" generation ON generation."id" = ${ref.generationId} AND generation."floorId" = job."floorId"
      WHERE job."id" = ${attempt.id} AND job."floorId" = ${attempt.floorId} AND job."status" = 'processing'
        AND job."leaseOwner" = ${attempt.leaseOwner} AND job."attemptCount" = ${attempt.attemptCount}
        AND job."leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') AND job."preparedMapGenerationId" IS NULL
        AND generation."status" = 'prepared' AND generation."manifestAssetId" = ${ref.manifest.assetId}
        AND EXISTS (SELECT 1 FROM "FloorMapDisplayAsset" display WHERE display."generationId" = generation."id" AND display."role" = 'manifest')
      FOR UPDATE OF job, generation`;
    if (!rows[0]) throw new Error("CAD_IMPORT_LEASE_LOST");
    await tx.floorImportJob.update({ where: { id: attempt.id }, data: { preparedMapGenerationId: ref.generationId } });
  }

  /** Internal U6 handoff only: caller still performs authorization, lease and
   * Floor CAS (mapRevision === ref.revision - 1) in the activation transaction. */
  async readPrepared(floorId: string, jobId: string): Promise<MapDocumentRef> {
    const job = await this.prisma.floorImportJob.findFirstOrThrow({ where: { id: jobId, floorId },
      include: { preparedMapGeneration: { include: { manifest: true } } } });
    const generation = job.preparedMapGeneration;
    if (!generation || generation.status !== "prepared" || !generation.manifest ||
      !["queued", "processing", "review_required", "applying"].includes(job.status)) throw new Error("CAD prepared map unavailable");
    return mapDocumentRefSchema.parse({ formatVersion: generation.formatVersion, generationId: generation.id,
      revision: generation.baseRevision, width: generation.width, height: generation.height, gridSize: generation.gridSize,
      elementCount: generation.elementCount, manifest: { assetId: generation.manifest.id, byteSize: Number(generation.manifest.sizeBytes),
        decodedByteSize: generation.manifestDecodedBytes, sha256: generation.manifest.sha256 } });
  }

  /** U7/U9 internal bounded adapter. The controller must check current reference
   * and authorization; this primitive never returns signed canonical URLs. */
  async readDisplayManifest(floorId: string, ref: MapDocumentRef): Promise<CadMapDisplayManifest> {
    const display = await this.store.readDisplayAssets(floorId, ref);
    if (!display) throw new Error("map display unavailable");
    const asset = await this.prisma.floorAsset.findFirstOrThrow({ where: { id: display.manifest.assetId, floorId } });
    const directory = await mkdtemp(join(tmpdir(), "cad-map-manifest-"));
    try {
      const path = join(directory, "manifest.json");
      await this.storage.downloadFloorAssetToFile(asset.objectKey, path, { maxBytes: CAD_MAP_MAX_METADATA_BYTES,
        expectedBytes: display.manifest.byteSize, expectedSha256: display.manifest.sha256, expectedMimeType: "application/json" });
      const raw = JSON.parse((await readFile(path)).toString("utf8"));
      const result = cadMapDisplayManifestSchema.parse({ ...raw,
        scene: { ...raw.scene, byteSize: display.manifest.byteSize, sha256: display.manifest.sha256 } });
      const byId = new Map(display.tiles.map(tile => [tile.asset.assetId, tile]));
      if (result.scene.manifestAssetId !== display.manifest.assetId || result.scene.tiles.length !== display.tiles.length ||
        result.scene.tiles.some(tile => {
          const stored = byId.get(tile.assetId);
          return !stored || stored.asset.sha256 !== tile.sha256 || stored.asset.byteSize !== tile.byteSize || stored.tileX !== tile.tileX ||
            stored.tileY !== tile.tileY || stored.lod !== tile.lod || stored.part !== tile.part ||
            Object.entries(tile.bounds).some(([key, value]) => stored.bounds[key as keyof typeof stored.bounds] !== value);
        })) throw new Error("map display manifest ledger mismatch");
      return result;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  discard(floorId: string, generationId: string) { return this.store.discardPreparedGeneration(floorId, generationId); }
  reap() { return this.store.reapExpiredPreparations(); }
}
