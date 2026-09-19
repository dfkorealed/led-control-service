import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { MapAssetRef, MapDocumentRef, MapElement, MapOp, SaveEditorStateInput } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { ObjectStorageService } from "../storage/object-storage.service";
import { MapDocumentStore, needsMapCheckpoint } from "./map-document-store";
import { MapDocumentRevisionData, MAP_NORMAL_DELTA_BYTES, checkpointRequired } from "./map-document-revision-data";
import { MapDocumentSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";
import { assertActiveFloorStatus } from "./floor-lifecycle";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { encodeMapPayload, MAP_CHUNK_MAX_BYTES } from "./map-document-codec";
import { planMapChanges } from "./map-document-mutations";

const ACTION = "floor_editor.document_saved";
const TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15_000 };
type Apply<T> = (tx: Prisma.TransactionClient, now: Date, document: MapDocumentRef) => Promise<{ result: T; snapshot: MapDocumentSnapshot }>;

@Injectable()
export class MapDocumentMutationService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly audit: AuditService, private readonly storage: ObjectStorageService,
    private readonly store: MapDocumentStore, private readonly data: MapDocumentRevisionData) {}

  async commit<T>(floorId: string, siteId: string, user: AuthenticatedUser, input: SaveEditorStateInput,
    rawInput: unknown, apply: Apply<T>): Promise<T> {
    if (!input.documentChanges) throw new ConflictException("common map documentChanges required");
    const hash = createHash("sha256").update(JSON.stringify(rawInput)).digest("hex");
    const preflight = await this.prisma.$transaction(tx => this.authorize<T>(tx, floorId, siteId, user, input, hash), TRANSACTION);
    if (preflight.replay !== undefined) return preflight.replay;
    const ref = preflight.document!;
    const state = await this.data.readRevision(floorId, ref);
    const operations: MapOp[] = [...input.documentChanges.operations];
    const groupIds = new Set(operations.flatMap(op => op.kind === "group.delete" ? [op.id] : []));
    const layerIds = new Set(operations.flatMap(op => op.kind === "layer.delete" ? [op.id] : []));
    // Deleting a group deletes its subtree, not registered fixtures or slots.
    // Expansion is deliberately limited to normal-save bounds; U6b owns bulk work.
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of state.groups) if (group.parentId !== null && groupIds.has(group.parentId) && !groupIds.has(group.id)) {
        groupIds.add(group.id); operations.push({ kind: "group.delete", id: group.id }); changed = true;
      }
    }
    const originals = new Map<string, MapElement>();
    if (groupIds.size || layerIds.size) {
      const explicit = new Set(operations.flatMap(op => op.kind === "add" || op.kind === "update" ? [op.element.id] : op.kind === "delete" ? [op.id] : []));
      for (const member of await state.getMembers(groupIds, layerIds)) {
        originals.set(member.id, member);
        if (!explicit.has(member.id)) operations.push({ kind: "delete", id: member.id });
      }
    }
    if (operations.length > 2000) checkpointRequired();
    const ids = operations.flatMap(op => op.kind === "add" || op.kind === "update" ? [op.element.id] : op.kind === "delete" ? [op.id] : []);
    for (const element of await state.getElements([...new Set(ids)].filter(id => !originals.has(id)))) originals.set(element.id, element);
    const planned = planMapChanges(ref, { elements: [...originals.values()], groups: state.groups, layers: state.layers }, operations);
    const forward = this.encodeOperations(planned.operations), inverse = this.encodeOperations(planned.inverse);
    const assets = [await this.writeAsset(floorId, forward), await this.writeAsset(floorId, inverse)];
    return this.prisma.$transaction(async tx => {
      const authority = await this.authorize<T>(tx, floorId, siteId, user, input, hash, forward.length);
      if (authority.replay !== undefined) return authority.replay;
      for (const asset of [...assets].sort((a, b) => a.assetId.localeCompare(b.assetId))) {
        const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "FloorAsset" WHERE "id" = ${asset.assetId} AND "floorId" = ${floorId}
          AND "status" = 'ready' AND "cleanupStartedAt" IS NULL FOR UPDATE`);
        if (rows.length !== 1) throw new ConflictException("map prepared asset unavailable");
      }
      await tx.floorMapChangeSet.create({ data: { floorId, generationId: ref.generationId,
        requestId: input.documentChanges!.requestId, baseRevision: ref.revision, resultRevision: ref.revision + 1,
        payloadHash: hash, payloadAssetId: assets[0].assetId, inverseAssetId: assets[1].assetId,
        decodedBytes: forward.length, inverseDecodedBytes: inverse.length } });
      const document = { ...ref, revision: ref.revision + 1, elementCount: planned.elementCount };
      const cas = await tx.floorMapDocument.updateMany({ where: { floorId, activeGenerationId: ref.generationId, revision: ref.revision },
        data: { revision: document.revision, changesSinceCheckpoint: { increment: 1 }, deltaDecodedBytes: { increment: forward.length } } });
      if (cas.count !== 1) throw new ConflictException("map document revision conflict");
      await tx.floor.update({ where: { id: floorId }, data: { mapRevision: document.revision } });
      const { result, snapshot } = await apply(tx, authority.now, document);
      const revision = await tx.floorMapRevision.create({ data: { floorId, revision: document.revision,
        snapshot: snapshot as Prisma.InputJsonValue, snapshotSha256: hashFloorEditorSnapshot(snapshot), changedBy: user.id,
        changeSummary: { documentOperations: operations.length, fixtureUpdates: input.fixtureUpdates.length,
          slotAssignments: input.slotAssignments.length, floorPlanChanged: input.floorPlan !== undefined } } });
      await this.store.pinRevision(tx, floorId, revision.id, document);
      // Persist the exact HTTP result, not a later re-read. A lost response may be
      // retried after subsequent saves or a lease expiry without a new revision.
      const serializableResult = JSON.parse(JSON.stringify(result));
      await this.audit.record({ organizationId: authority.organizationId, siteId, actorId: user.id,
        action: ACTION, targetType: "floor", targetId: floorId, outcome: "success",
        metadata: { requestId: input.documentChanges!.requestId, payloadHash: hash, result: serializableResult }, transaction: tx });
      return serializableResult as T;
    }, TRANSACTION);
  }

  private async authorize<T>(tx: Prisma.TransactionClient, floorId: string, siteId: string, user: AuthenticatedUser,
    input: SaveEditorStateInput, hash: string, addedDecodedBytes = 0) {
    const site = await this.access.assertManageInTransaction(tx, user, siteId);
    const [floor] = await tx.$queryRaw<Array<{ siteId: string; status: string; mapRevision: number; editorLeaseHolderId: string | null;
      editorLeaseFence: number; editorLeaseTokenHash: string | null; editorLeaseExpiresAt: Date | null }>>(Prisma.sql`
      SELECT "siteId", "status"::text, "mapRevision", "editorLeaseHolderId", "editorLeaseFence", "editorLeaseTokenHash", "editorLeaseExpiresAt"
      FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`);
    if (!floor || floor.siteId !== siteId) throw new NotFoundException("floor not found");
    assertActiveFloorStatus(floor.status);
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    const saved = await tx.auditLog.findFirst({ where: { siteId, action: ACTION, targetType: "floor", targetId: floorId,
      metadata: { path: ["requestId"], equals: input.documentChanges!.requestId }, outcome: "success" } });
    if (saved) {
      const metadata = saved.metadata as Record<string, unknown>;
      if (saved.actorId !== user.id || metadata.payloadHash !== hash) throw new ConflictException("map request ID payload conflict");
      return { now, organizationId: site.organizationId, replay: metadata.result as T, document: null };
    }
    if (floor.editorLeaseHolderId !== user.id || floor.editorLeaseFence !== input.leaseFence ||
      floor.editorLeaseTokenHash !== hashEditorLeaseToken(input.leaseToken) || !floor.editorLeaseExpiresAt || floor.editorLeaseExpiresAt <= now) {
      throw new ConflictException("floor editor lease is no longer active");
    }
    const document = await this.data.currentRef(floorId, tx);
    if (!document || floor.mapRevision !== input.expectedRevision || document.revision !== input.expectedRevision ||
      document.generationId !== input.documentChanges!.generationId) throw new ConflictException("map document revision conflict");
    const head = await tx.floorMapDocument.findUniqueOrThrow({ where: { floorId } });
    if (needsMapCheckpoint(head.changesSinceCheckpoint, head.deltaDecodedBytes) ||
      head.deltaDecodedBytes + BigInt(addedDecodedBytes) > BigInt(MAP_NORMAL_DELTA_BYTES)) checkpointRequired();
    if (input.floorPlan === null || (input.floorPlan && (input.floorPlan.width !== document.width ||
      input.floorPlan.height !== document.height || input.floorPlan.gridSize !== document.gridSize))) checkpointRequired();
    if (input.floorPlan && input.floorPlan.sourceType !== "none") throw new BadRequestException("common map backgrounds require import activation");
    return { now, organizationId: site.organizationId, replay: undefined, document };
  }
  private encodeOperations(operations: MapOp[]) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, operations }));
    if (bytes.length > MAP_CHUNK_MAX_BYTES) checkpointRequired();
    return bytes;
  }
  private async writeAsset(floorId: string, decoded: Buffer): Promise<MapAssetRef> {
    const encoded = encodeMapPayload(decoded), id = randomUUID();
    const sha256 = createHash("sha256").update(encoded).digest("hex"), objectKey = `floors/${floorId}/${id}.mdc`;
    const directory = await mkdtemp(join(tmpdir(), "led-map-change-"));
    try {
      const path = join(directory, "asset.mdc"); await writeFile(path, encoded, { flag: "wx", mode: 0o600 });
      await this.prisma.floorAsset.create({ data: { id, floorId, kind: "map_changeset", objectKey,
        mimeType: "application/octet-stream", sizeBytes: encoded.length, sha256, uploadExpiresAt: new Date(Date.now() + 3600_000) } });
      const expected = { sizeBytes: encoded.length, sha256, contentType: "application/octet-stream" };
      await this.storage.putCadSceneObjectFile(objectKey, path, expected); await this.storage.verifyCadSceneObject(objectKey, expected);
      const ready = await this.prisma.floorAsset.updateMany({ where: { id, status: "pending", cleanupStartedAt: null }, data: { status: "ready", readyAt: new Date() } });
      if (ready.count !== 1) throw new ConflictException("map asset cleanup conflict");
      return { assetId: id, sha256, byteSize: encoded.length, decodedByteSize: decoded.length };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
