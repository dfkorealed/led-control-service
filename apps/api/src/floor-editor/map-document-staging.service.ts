import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { MapDocumentRef, SaveEditorStateInput, mapDocumentRefSchema } from "@led-control/shared";
import { FloorMapStage, Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { ObjectStorageService } from "../storage/object-storage.service";
import { MapDocumentStore } from "./map-document-store";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { MapDocumentCheckpointService } from "./map-document-checkpoint.service";
import { FloorEditorService } from "./floor-editor.service";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { assertActiveFloorStatus } from "./floor-lifecycle";
import { hashFloorEditorSnapshot, parseMapDocumentSnapshot } from "./floor-editor-snapshot";
import { stageCreateSchema, stagePartSchema, stageCommitSchema, stageLeaseSchema, stagePartIndex,
  StageLeaseInput, MAP_STAGE_TOTAL_BYTES, MAP_STAGE_LIFETIME_MS } from "./map-document-stage-contracts";
import { decodeMapPayload } from "./map-document-codec";
import { decodeStageOperations } from "./map-document-stage-decoder";

const TX = { maxWait: 5000, timeout: 30000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const historySourceSchema = z.object({ revision: z.number().int().positive().max(2147483646) }).strict();
type Metadata = { save: Omit<SaveEditorStateInput, "leaseToken">; historySource?: { revision: number } };

@Injectable()
export class MapDocumentStagingService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(MapDocumentStagingService.name);
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly audit: AuditService, private readonly storage: ObjectStorageService,
    private readonly store: MapDocumentStore, private readonly data: MapDocumentRevisionData,
    private readonly checkpoints: MapDocumentCheckpointService, private readonly editor: FloorEditorService) {}
  onModuleInit() { this.timer = setInterval(() => { void this.processPending().catch(() => this.logger.error("map stage worker failed")); }, 1000); this.timer.unref(); }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.running; }

  async create(floorId: string, user: AuthenticatedUser, raw: unknown) {
    const { historySource: source, ...envelope } = this.parse(z.record(z.unknown()), raw);
    const input = this.parse(stageCreateSchema, envelope);
    const historySource = source === undefined ? undefined : this.parse(historySourceSchema, source);
    const { leaseToken: _token, ...save } = input;
    const metadata: Metadata = { save, ...(historySource ? { historySource } : {}) };
    return this.prisma.$transaction(async tx => {
      const authority = await this.authority(tx, floorId, user);
      const existing = await tx.floorMapStage.findUnique({ where: { floorId_requestId: { floorId, requestId: input.documentChanges!.requestId } } });
      if (existing) {
        if (existing.userId !== user.id || existing.requestHash !== digest(raw)) throw new ConflictException("stage request payload conflict");
        return this.dto(existing);
      }
      this.lease(authority, user.id, hashEditorLeaseToken(input.leaseToken), input.leaseFence);
      const ref = await this.data.currentRef(floorId, tx);
      if (!ref || ref.revision !== input.expectedRevision || ref.generationId !== input.documentChanges!.generationId) throw new ConflictException("stage base revision conflict");
      if (historySource) await this.history(tx, floorId, historySource.revision);
      const stage = await tx.floorMapStage.create({ data: { floorId, userId: user.id, generationId: ref.generationId,
        baseRevision: ref.revision, requestId: input.documentChanges!.requestId, requestHash: digest(raw),
        leaseTokenHash: hashEditorLeaseToken(input.leaseToken), leaseFence: input.leaseFence,
        metadata: metadata as unknown as Prisma.InputJsonValue, expiresAt: new Date(authority.now.getTime() + MAP_STAGE_LIFETIME_MS) } });
      return this.dto(stage);
    }, TX);
  }

  async part(floorId: string, id: string, partInput: string, user: AuthenticatedUser, raw: unknown) {
    const part = this.parse(stagePartIndex, partInput), input = this.parse(stagePartSchema, raw);
    const bytes = Buffer.from(input.data, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new BadRequestException("stage part hash mismatch");
    const check = async (tx: Prisma.TransactionClient) => {
      const scope = await this.scope(tx, floorId, id, user); this.binding(scope, user, input);
      const existing = await tx.floorMapStagePart.findUnique({ where: { stageId_part: { stageId: id, part } } });
      if (existing) {
        if (existing.sha256 !== input.sha256 || existing.decodedBytes !== bytes.length) throw new ConflictException("stage part is immutable");
        return { ...scope, existing };
      }
      if (scope.stage.status !== "preparing" || part !== scope.stage.partCount ||
        scope.stage.decodedBytes + BigInt(bytes.length) > BigInt(MAP_STAGE_TOTAL_BYTES)) throw new ConflictException("stage part sequence or size conflict");
      return { ...scope, existing: null };
    };
    const before = await this.prisma.$transaction(check, TX);
    if (before.existing) return this.dto(before.stage);
    const asset = await this.checkpoints.writeAsset(floorId, "map_stage_part", bytes);
    return this.prisma.$transaction(async tx => {
      const scope = await check(tx); if (scope.existing) return this.dto(scope.stage);
      await this.lockAsset(tx, floorId, asset.assetId);
      await tx.floorMapStagePart.create({ data: { floorId, stageId: id, part, assetId: asset.assetId, sha256: input.sha256, decodedBytes: bytes.length } });
      return this.dto(await tx.floorMapStage.update({ where: { id }, data: { partCount: { increment: 1 }, decodedBytes: { increment: bytes.length },
        expiresAt: new Date(scope.now.getTime() + MAP_STAGE_LIFETIME_MS) } }));
    }, TX);
  }

  async commit(floorId: string, id: string, user: AuthenticatedUser, raw: unknown) {
    return this.queue(floorId, id, user, raw, true);
  }
  async prepare(floorId: string, id: string, user: AuthenticatedUser, raw: unknown) {
    return this.queue(floorId, id, user, raw, false);
  }
  private async queue(floorId: string, id: string, user: AuthenticatedUser, raw: unknown, commit: boolean) {
    return this.prisma.$transaction(async tx => {
      const scope = await this.scope(tx, floorId, id, user), stage = scope.stage;
      const isHistory = Boolean(this.metadata(stage).historySource);
      const input = isHistory ? this.parse(stageLeaseSchema, raw) : this.parse(stageCommitSchema, raw);
      if (!isHistory) {
        const intent = input as z.infer<typeof stageCommitSchema>;
        if (stage.payloadHash && (stage.payloadHash !== intent.sha256 || stage.expectedPartCount !== intent.partCount ||
          stage.expectedDecodedBytes !== BigInt(intent.decodedBytes))) throw new ConflictException("stage commit intent is immutable");
        if (stage.partCount !== intent.partCount || stage.decodedBytes !== BigInt(intent.decodedBytes)) throw new ConflictException("stage parts are incomplete");
      }
      // Successful receipts outlive upload TTL and the original lease, but still
      // require this actor's freshly checked site manage authority.
      if (stage.status === "committed") return this.dto(stage);
      this.binding(scope, user, input);
      if (["expired", "cancelled"].includes(stage.status)) throw new ConflictException("stage is terminal");
      if (stage.status === "processing" || stage.status === "queued") {
        if (stage.commitRequested !== commit) throw new ConflictException("stage preparation is in progress");
        return this.dto(stage);
      }
      const intent = input as z.infer<typeof stageCommitSchema>;
      return this.dto(await tx.floorMapStage.update({ where: { id }, data: {
        status: "queued", commitRequested: commit, errorCode: null,
        ...(isHistory ? {} : { expectedPartCount: intent.partCount, expectedDecodedBytes: intent.decodedBytes, payloadHash: intent.sha256 }),
        expiresAt: new Date(scope.now.getTime() + MAP_STAGE_LIFETIME_MS) } }));
    }, TX);
  }

  async status(floorId: string, id: string, user: AuthenticatedUser) {
    return this.prisma.$transaction(async tx => {
      const scope = await this.scope(tx, floorId, id, user);
      return { ...this.dto(scope.stage), ...(scope.stage.status === "ready" ? { preview: await this.preview(tx, scope, user) } : {}) };
    }, TX);
  }
  async cancel(floorId: string, id: string, user: AuthenticatedUser, raw: unknown) {
    const input = this.parse(stageLeaseSchema, raw);
    return this.prisma.$transaction(async tx => {
      const scope = await this.scope(tx, floorId, id, user);
      if (scope.stage.status === "committed") throw new ConflictException("committed stage cannot be cancelled");
      this.binding(scope, user, input);
      return this.dto(await tx.floorMapStage.update({ where: { id }, data: { status: "cancelled", preparedGenerationId: null,
        workerToken: null, workerExpiresAt: null } }));
    }, TX);
  }
  resolvePreview(floorId: string, id: string, user: AuthenticatedUser): Promise<MapDocumentRef> {
    return this.prisma.$transaction(async tx => this.preview(tx, await this.scope(tx, floorId, id, user), user), TX);
  }

  processPending(): Promise<void> {
    if (!this.running) this.running = this.work().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async work() {
    await this.reapExpired();
    const candidates = await this.prisma.floorMapStage.findMany({ where: { OR: [{ status: "queued" },
      { status: "processing", workerExpiresAt: { lte: new Date() } }] }, orderBy: { updatedAt: "asc" }, take: 4 });
    for (const candidate of candidates) {
      const workerToken = randomUUID();
      let prepared: MapDocumentRef | undefined;
      try {
        const user = await this.workerUser(candidate.userId);
        const claim = await this.prisma.$transaction(async tx => {
          const scope = await this.scope(tx, candidate.floorId, candidate.id, user);
          if (scope.stage.status !== "queued" && !(scope.stage.status === "processing" && scope.stage.workerExpiresAt && scope.stage.workerExpiresAt <= scope.now)) return null;
          this.binding(scope, user);
          const stage = await tx.floorMapStage.update({ where: { id: candidate.id }, data: { status: "processing",
            workerToken, workerExpiresAt: new Date(scope.now.getTime() + 5 * 60000) } });
          return { stage, current: (await this.data.currentRef(candidate.floorId, tx))! };
        }, TX);
        if (!claim) continue;
        const metadata = this.metadata(claim.stage);
        const source = metadata.historySource ? await this.history(this.prisma, candidate.floorId, metadata.historySource.revision) : undefined;
        const check = () => { if (Date.now() >= claim.stage.workerExpiresAt!.getTime()) throw new ConflictException("stage worker claim expired"); };
        if (claim.stage.preparedGenerationId) prepared = await this.preparedRef(this.prisma, claim.stage);
        else {
          const operations = source ? (async function* () {})() : decodeStageOperations(this.parts(claim.stage), { deadline: claim.stage.workerExpiresAt!.getTime() });
          prepared = await this.checkpoints.prepare(candidate.floorId, source?.document ?? claim.current, operations,
            source ? { sourceType: "none", imageUrl: "", originalFileUrl: null, renderedImageUrl: null,
              width: source.document.width, height: source.document.height, gridSize: source.document.gridSize } : metadata.save.floorPlan, check);
        }
        await this.prisma.$transaction(async tx => {
          const scope = await this.scope(tx, candidate.floorId, candidate.id, user); this.binding(scope, user);
          if (scope.stage.status !== "processing" || scope.stage.workerToken !== workerToken || !scope.stage.workerExpiresAt ||
            scope.stage.workerExpiresAt <= scope.now) throw new ConflictException("stage worker fenced");
          if (!scope.stage.commitRequested) {
            await tx.floorMapStage.update({ where: { id: candidate.id }, data: { status: "ready", preparedGenerationId: prepared!.generationId,
              workerToken: null, workerExpiresAt: null, expiresAt: new Date(scope.now.getTime() + MAP_STAGE_LIFETIME_MS) } });
            return;
          }
          await this.checkpoints.activate(tx, candidate.floorId, claim.current, prepared!);
          const applied = source
            ? await this.editor.applyDocumentRestore(tx, candidate.floorId, source, scope.now, prepared!)
            : await this.editor.applyDocumentSave(tx, candidate.floorId, { ...metadata.save, leaseToken: "internal-authority" }, scope.now, prepared!);
          const revision = await tx.floorMapRevision.create({ data: { floorId: candidate.floorId, revision: prepared!.revision,
            snapshot: applied.snapshot as Prisma.InputJsonValue, snapshotSha256: hashFloorEditorSnapshot(applied.snapshot),
            changedBy: user.id, changeSummary: { stageId: candidate.id, staged: true }, restoredFromRevision: metadata.historySource?.revision } });
          await this.store.pinRevision(tx, candidate.floorId, revision.id, prepared!);
          const parts = await tx.floorMapStagePart.findMany({ where: { stageId: candidate.id } });
          for (const part of parts) await this.lockAsset(tx, candidate.floorId, part.assetId);
          if (parts.length) await tx.floorMapRevisionAsset.createMany({ data: parts.map(part => ({ revisionId: revision.id,
            floorId: candidate.floorId, generationId: candidate.generationId, assetId: part.assetId })) });
          const result = JSON.parse(JSON.stringify({ ...applied.result,
            history: { undo: { revision: candidate.baseRevision }, redo: { revision: prepared!.revision } } }));
          await tx.floorMapStage.update({ where: { id: candidate.id }, data: { status: "committed", result,
            preparedGenerationId: prepared!.generationId, workerToken: null, workerExpiresAt: null } });
          await this.audit.record({ organizationId: scope.site.organizationId, siteId: scope.site.id, actorId: user.id,
            action: "floor_editor.stage_committed", targetType: "floor", targetId: candidate.floorId, outcome: "success", transaction: tx,
            metadata: { stageId: candidate.id, requestId: candidate.requestId, requestHash: candidate.requestHash, revision: prepared!.revision } });
        }, TX);
        prepared = undefined;
      } catch (error) {
        // Never store raw exceptions: storage URLs, query text and credentials
        // are not client diagnostics. An owned failed claim can be retried with
        // the same immutable intent; cancellation/another worker wins its CAS.
        await this.prisma.floorMapStage.updateMany({ where: { id: candidate.id, status: { in: ["queued", "processing"] },
          OR: [{ workerToken }, { workerToken: null }] }, data: { status: "failed", workerToken: null, workerExpiresAt: null,
          preparedGenerationId: null, errorCode: error instanceof ConflictException ? "stage_conflict" : error instanceof BadRequestException ? "stage_invalid" : "stage_preparation_failed" } });
        this.logger.warn("map stage preparation or activation failed");
      } finally {
        if (prepared) {
          try { await this.store.discardPreparedGeneration(candidate.floorId, prepared.generationId); }
          catch { this.logger.warn("map stage preparation cleanup deferred"); }
        }
      }
    }
  }

  async reapExpired() {
    const candidates = await this.prisma.floorMapStage.findMany({ where: { status: { in: ["preparing", "ready", "queued", "processing", "failed", "expired", "cancelled"] },
      expiresAt: { lte: new Date() }, OR: [{ status: { not: "expired" } }, { parts: { some: {} } }, { preparedGenerationId: { not: null } }] },
      take: 25, orderBy: { expiresAt: "asc" } });
    for (const candidate of candidates) await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id"=${candidate.floorId} FOR UPDATE`;
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
      const stage = await tx.floorMapStage.findUnique({ where: { id: candidate.id } });
      if (!stage || stage.status === "committed" || stage.expiresAt > clock.now) return;
      await tx.floorMapStage.update({ where: { id: stage.id }, data: { status: "expired", preparedGenerationId: null, workerToken: null, workerExpiresAt: null } });
      await tx.floorMapStagePart.deleteMany({ where: { stageId: stage.id } });
    }, TX);
  }

  private async *parts(stage: FloorMapStage) {
    const rows = await this.prisma.floorMapStagePart.findMany({ where: { stageId: stage.id }, orderBy: { part: "asc" }, include: { asset: true } });
    if (rows.length !== stage.expectedPartCount) throw new BadRequestException("stage parts missing");
    const hash = createHash("sha256"); let total = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], asset = row.asset;
      if (row.part !== index || row.floorId !== stage.floorId || asset.floorId !== stage.floorId ||
        asset.kind !== "map_stage_part" || asset.status !== "ready" || asset.cleanupStartedAt) throw new BadRequestException("stage part ledger mismatch");
      const directory = await mkdtemp(join(tmpdir(), "led-stage-part-"));
      try {
        const path = join(directory, "part");
        await this.storage.downloadFloorAssetToFile(asset.objectKey, path, { maxBytes: 1024 * 1024,
          expectedBytes: Number(asset.sizeBytes), expectedSha256: asset.sha256, expectedMimeType: "application/octet-stream" });
        const bytes = decodeMapPayload(await readFile(path), { byteSize: Number(asset.sizeBytes), decodedByteSize: row.decodedBytes, sha256: asset.sha256 });
        if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new BadRequestException("stage decoded hash mismatch");
        hash.update(bytes); total += bytes.length; yield bytes;
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    if (total !== Number(stage.expectedDecodedBytes) || hash.digest("hex") !== stage.payloadHash) throw new BadRequestException("stage stream hash mismatch");
  }
  private async authority(tx: Prisma.TransactionClient, floorId: string, user: AuthenticatedUser) {
    const found = await tx.floor.findUnique({ where: { id: floorId }, select: { siteId: true } });
    if (!found) throw new NotFoundException("floor not found");
    const site = await this.access.assertManageInTransaction(tx, user, found.siteId);
    await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id"=${floorId} FOR UPDATE`;
    const floor = await tx.floor.findUniqueOrThrow({ where: { id: floorId } });
    assertActiveFloorStatus(floor.status);
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    return { floor, site, now };
  }
  private async scope(tx: Prisma.TransactionClient, floorId: string, id: string, user: AuthenticatedUser) {
    const authority = await this.authority(tx, floorId, user);
    const stage = await tx.floorMapStage.findFirst({ where: { id, floorId, userId: user.id } });
    if (!stage) throw new NotFoundException("stage not found");
    const head = await tx.floorMapDocument.findUnique({ where: { floorId } });
    return { ...authority, stage, head };
  }
  private lease(scope: Awaited<ReturnType<MapDocumentStagingService["authority"]>>, userId: string, hash: string, fence: number) {
    const f = scope.floor;
    if (f.editorLeaseHolderId !== userId || f.editorLeaseTokenHash !== hash || f.editorLeaseFence !== fence ||
      !f.editorLeaseExpiresAt || f.editorLeaseExpiresAt <= scope.now) throw new ConflictException("stage editor lease expired");
  }
  private binding(scope: Awaited<ReturnType<MapDocumentStagingService["scope"]>>, user: AuthenticatedUser, input?: StageLeaseInput) {
    const stage = scope.stage;
    if (input && (hashEditorLeaseToken(input.leaseToken) !== stage.leaseTokenHash || input.leaseFence !== stage.leaseFence)) throw new ConflictException("stage lease binding mismatch");
    this.lease(scope, user.id, stage.leaseTokenHash, stage.leaseFence);
    if (stage.expiresAt <= scope.now || scope.floor.mapRevision !== stage.baseRevision ||
      scope.head?.activeGenerationId !== stage.generationId || scope.head.revision !== stage.baseRevision) throw new ConflictException("stage base or expiry changed");
  }
  private async preparedRef(tx: Prisma.TransactionClient, stage: FloorMapStage) {
    const g = await tx.floorMapGeneration.findFirst({ where: { id: stage.preparedGenerationId ?? "", floorId: stage.floorId }, include: { manifest: true } });
    const a = g?.manifest;
    if (!g || g.status !== "prepared" || g.baseRevision !== stage.baseRevision + 1 || !a || a.floorId !== stage.floorId ||
      a.status !== "ready" || a.cleanupStartedAt || a.kind !== "map_manifest") throw new ConflictException("stage preview unavailable");
    return mapDocumentRefSchema.parse({ formatVersion: 1, generationId: g.id, revision: g.baseRevision, width: g.width, height: g.height,
      gridSize: g.gridSize, elementCount: g.elementCount, manifest: { assetId: a.id, sha256: a.sha256, byteSize: Number(a.sizeBytes), decodedByteSize: g.manifestDecodedBytes } });
  }
  private async preview(tx: Prisma.TransactionClient, scope: Awaited<ReturnType<MapDocumentStagingService["scope"]>>, user: AuthenticatedUser) {
    this.binding(scope, user);
    if (scope.stage.status !== "ready") throw new ConflictException("stage preview is not ready");
    return this.preparedRef(tx, scope.stage);
  }
  private async history(tx: Prisma.TransactionClient, floorId: string, revision: number) {
    const row = await tx.floorMapRevision.findUnique({ where: { floorId_revision: { floorId, revision } } });
    if (!row) throw new NotFoundException("map history not found");
    const snapshot = parseMapDocumentSnapshot(row.snapshot);
    if (hashFloorEditorSnapshot(snapshot) !== row.snapshotSha256) throw new BadRequestException("map history integrity mismatch");
    return snapshot;
  }
  private metadata(stage: FloorMapStage): Metadata { return stage.metadata as unknown as Metadata; }
  private async workerUser(id: string): Promise<AuthenticatedUser> {
    const row = await this.prisma.user.findUnique({ where: { id }, include: { organization: true } });
    if (!row || row.status !== "active" || row.mustChangePassword) throw new ConflictException("stage user inactive");
    return { ...row, organizationType: row.organization.type };
  }
  private dto(stage: FloorMapStage) {
    return { id: stage.id, status: stage.status, generationId: stage.generationId, baseRevision: stage.baseRevision,
      partCount: stage.partCount, decodedBytes: Number(stage.decodedBytes), expiresAt: stage.expiresAt.toISOString(),
      errorCode: stage.errorCode, result: stage.status === "committed" ? stage.result : null };
  }
  private async lockAsset(tx: Prisma.TransactionClient, floorId: string, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "FloorAsset" WHERE "id"=${id} AND "floorId"=${floorId}
      AND "status"='ready' AND "cleanupStartedAt" IS NULL FOR UPDATE`;
    if (rows.length !== 1) throw new ConflictException("stage asset unavailable");
  }
  private parse<T>(schema: z.ZodType<T, z.ZodTypeDef, any>, input: unknown): T {
    const parsed = schema.safeParse(input); if (!parsed.success) throw new BadRequestException("invalid stage request"); return parsed.data;
  }
}
