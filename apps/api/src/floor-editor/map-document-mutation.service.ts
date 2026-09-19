import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { MapAssetRef, MapDocumentRef, MapElement, MapOp, SaveEditorStateInput, RestoreFloorEditorRevisionInput } from "@led-control/shared";
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
import { MapDocumentSnapshot, hashFloorEditorSnapshot, parseMapDocumentSnapshot } from "./floor-editor-snapshot";
import { assertActiveFloorStatus } from "./floor-lifecycle";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { encodeMapPayload, MAP_CHUNK_MAX_BYTES } from "./map-document-codec";
import { planMapChanges } from "./map-document-mutations";
import { MapDocumentCheckpointService } from "./map-document-checkpoint.service";

const ACTION = "floor_editor.document_saved";
const TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15_000 };
type Apply<T> = (tx: Prisma.TransactionClient, now: Date, document: MapDocumentRef) => Promise<{ result: T; snapshot: MapDocumentSnapshot }>;

@Injectable()
export class MapDocumentMutationService {
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly audit: AuditService, private readonly storage: ObjectStorageService,
    private readonly store: MapDocumentStore, private readonly data: MapDocumentRevisionData,
    @Optional() private readonly checkpoints = new MapDocumentCheckpointService(prisma, storage, store, data)) {}

  async commit<T>(floorId: string, siteId: string, user: AuthenticatedUser, input: SaveEditorStateInput,
    rawInput: unknown, apply: Apply<T>): Promise<T> {
    if (!input.documentChanges) throw new ConflictException("common map documentChanges required");
    const hash = createHash("sha256").update(JSON.stringify(rawInput)).digest("hex");
    const preflight = await this.prisma.$transaction(tx => this.authorize<T>(tx, floorId, siteId, user, input, hash), TRANSACTION);
    if (preflight.replay !== undefined) return preflight.replay;
    const ref = preflight.document!;
    const state = await this.data.readRevision(floorId, ref);
    const operations: MapOp[] = [...input.documentChanges.operations];
    const overlay = new Map<string, MapElement | null>(state.overlay.map(e => [e.id, e]));
    for (const id of state.deletedIds) overlay.set(id, null);
    for (const op of operations) {
      if (op.kind === "add" || op.kind === "update") overlay.set(op.element.id, op.element);
      if (op.kind === "delete") overlay.set(op.id, null);
    }
    const head = await this.prisma.floorMapDocument.findUniqueOrThrow({ where: { floorId } });
    if (needsMapCheckpoint(head.changesSinceCheckpoint + 1, head.deltaDecodedBytes + BigInt(Buffer.byteLength(JSON.stringify(operations)) + 64)) ||
      overlay.size > 2000 || Buffer.byteLength(JSON.stringify([...overlay])) > 8 * 1024 * 1024 ||
      operations.some(op => op.kind === "group.delete" || op.kind === "layer.delete") ||
      (input.floorPlan && (input.floorPlan.width !== ref.width || input.floorPlan.height !== ref.height || input.floorPlan.gridSize !== ref.gridSize))) {
      return this.commitReplacement(floorId, siteId, user, input, hash, ref, apply);
    }
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
    try {
      for (const element of await state.getElements([...new Set(ids)].filter(id => !originals.has(id)))) originals.set(element.id, element);
    } catch (error) {
      if (error instanceof ConflictException && (error.getResponse() as { code?: string }).code === "map_checkpoint_required") {
        return this.commitReplacement(floorId, siteId, user, input, hash, ref, apply);
      }
      throw error;
    }
    const planned = planMapChanges(ref, { elements: [...originals.values()], groups: state.groups, layers: state.layers }, operations);
    if (Buffer.byteLength(JSON.stringify({ version: 1, operations: planned.inverse })) > MAP_CHUNK_MAX_BYTES) {
      return this.commitReplacement(floorId, siteId, user, input, hash, ref, apply);
    }
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
    if (addedDecodedBytes && head.deltaDecodedBytes + BigInt(addedDecodedBytes) > BigInt(MAP_NORMAL_DELTA_BYTES)) checkpointRequired();
    if (input.floorPlan === null) throw new BadRequestException("common map requires dimensions");
    if (input.floorPlan && input.floorPlan.sourceType !== "none") throw new BadRequestException("common map backgrounds require import activation");
    return { now, organizationId: site.organizationId, replay: undefined, document };
  }
  private async commitReplacement<T>(floorId: string, siteId: string, user: AuthenticatedUser, input: SaveEditorStateInput,
    hash: string, ref: MapDocumentRef, apply: Apply<T>, source?: MapDocumentSnapshot): Promise<T> {
    const prepared = await this.checkpoints.prepare(floorId, source?.document ?? ref,
      (async function* () { if (!source) yield* input.documentChanges!.operations; })(),
      source ? { sourceType: "none", imageUrl: "", originalFileUrl: null, renderedImageUrl: null,
        width: source.document.width, height: source.document.height, gridSize: source.document.gridSize } : input.floorPlan);
    let published = false;
    try {
      return await this.prisma.$transaction(async tx => {
        const authority = await this.authorize<T>(tx, floorId, siteId, user, input, hash);
        if (authority.replay !== undefined) return authority.replay;
        await this.checkpoints.activate(tx, floorId, ref, prepared);
        const { result, snapshot } = await apply(tx, authority.now, prepared);
        const revision = await tx.floorMapRevision.create({ data: { floorId, revision: prepared.revision,
          snapshot: snapshot as Prisma.InputJsonValue, snapshotSha256: hashFloorEditorSnapshot(snapshot), changedBy: user.id,
          restoredFromRevision: source?.document.revision,
          changeSummary: { checkpoint: true, documentOperations: input.documentChanges!.operations.length } } });
        await this.store.pinRevision(tx, floorId, revision.id, prepared);
        const serializableResult = JSON.parse(JSON.stringify(result));
        await this.audit.record({ organizationId: authority.organizationId, siteId, actorId: user.id, action: ACTION,
          targetType: "floor", targetId: floorId, outcome: "success", transaction: tx,
          metadata: { requestId: input.documentChanges!.requestId, payloadHash: hash, result: serializableResult } });
        published = true;
        return serializableResult as T;
      }, { ...TRANSACTION, timeout: 30000 });
    } finally {
      if (!published) await this.store.discardPreparedGeneration(floorId, prepared.generationId);
    }
  }
  async restore<T>(floorId: string, siteId: string, user: AuthenticatedUser, revision: number, raw: RestoreFloorEditorRevisionInput,
    apply: (tx: Prisma.TransactionClient, now: Date, document: MapDocumentRef, source: MapDocumentSnapshot) => ReturnType<Apply<T>>): Promise<T> {
    const hash = createHash("sha256").update(JSON.stringify({ restore: revision, actorId: user.id, input: raw })).digest("hex");
    const current = await this.data.currentRef(floorId);
    const input: SaveEditorStateInput = { ...raw, fixtureUpdates: [], slotAssignments: [], objectCreates: [], objectUpdates: [], objectDeletes: [],
      documentChanges: { requestId: "restore-" + hash, generationId: current?.generationId ?? "missing", operations: [] } };
    const authority = await this.prisma.$transaction(tx => this.authorize<T>(tx, floorId, siteId, user, input, hash), TRANSACTION);
    if (authority.replay !== undefined) return authority.replay;
    const row = await this.prisma.floorMapRevision.findUnique({ where: { floorId_revision: { floorId, revision } } });
    if (!row) throw new NotFoundException("map revision not found");
    const source = parseMapDocumentSnapshot(row.snapshot);
    if (row.snapshotSha256 !== hashFloorEditorSnapshot(source)) throw new BadRequestException("map revision integrity mismatch");
    return this.commitReplacement(floorId, siteId, user, input, hash, authority.document!,
      (tx, now, document) => apply(tx, now, document, source), source);
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
