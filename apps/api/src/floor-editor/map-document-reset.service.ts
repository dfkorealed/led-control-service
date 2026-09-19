import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { MapDocumentRef, MapElement, mapDocumentRefSchema } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { MapDocumentStore } from "./map-document-store";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { assertActiveFloorStatus } from "./floor-lifecycle";
import { buildMapDocumentSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";

const resetInputSchema = z.object({
  requestId: z.string().min(1).max(128).refine(value => value.trim() === value && value.length > 0),
  baseRevision: z.number().int().min(0).max(2_147_483_646),
  leaseToken: z.string().min(1).max(256).refine(value => value.trim().length > 0),
  leaseFence: z.number().int().min(1).max(2_147_483_647)
}).strict();
export type MapDocumentResetInput = z.infer<typeof resetInputSchema>;
const EMPTY_MAP = { width: 1200, height: 800, gridSize: 10, groups: [],
  layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }] };
const ACTION = "floor_editor.reset";
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };
type LockedFloor = { siteId: string; status: string; mapRevision: number; editorLeaseFence: number;
  editorLeaseHolderId: string | null; editorLeaseTokenHash: string | null; editorLeaseExpiresAt: Date | null };

async function* emptyElements(): AsyncGenerator<MapElement> { /* An empty map has no imported or manual geometry. */ }

@Injectable()
export class MapDocumentResetService {
  private readonly logger = new Logger(MapDocumentResetService.name);
  constructor(private readonly prisma: PrismaService, private readonly access: SiteAccessService,
    private readonly audit: AuditService, private readonly store: MapDocumentStore) {}

  async reset(floorId: string, user: AuthenticatedUser, rawInput: unknown): Promise<MapDocumentRef> {
    const parsed = resetInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new BadRequestException("invalid map reset payload");
    const input = parsed.data;
    const payloadHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const floor = await this.prisma.floor.findUnique({ where: { id: floorId }, select: { siteId: true } });
    if (!floor) throw new NotFoundException("floor not found");
    await this.access.assert(user, floor.siteId, "manage");

    // Site -> Floor matches every existing editor/admin writer. Replays also
    // acquire these locks and reauthorize, but do not need the old lease renewed.
    const preflight = await this.prisma.$transaction(tx =>
      this.authorizeLocked(tx, floorId, floor.siteId, user, input, payloadHash), TRANSACTION_OPTIONS);
    if (preflight.replay) return preflight.replay;

    let prepared: MapDocumentRef;
    try {
      prepared = await this.store.prepareGeneration(floorId, emptyElements(), EMPTY_MAP);
    } catch (error) {
      // A concurrent same-request reset can discard this still-uploading
      // generation. Reauthorize and replay its committed result, never prepare
      // or publish again. With no committed replay, preserve the failure.
      const authority = await this.prisma.$transaction(tx =>
        this.authorizeLocked(tx, floorId, floor.siteId, user, input, payloadHash), TRANSACTION_OPTIONS);
      if (authority.replay) return authority.replay;
      throw error;
    }
    let published = false;
    try {
      const result = await this.prisma.$transaction(async tx => {
        const authority = await this.authorizeLocked(tx, floorId, floor.siteId, user, input, payloadHash);
        if (authority.replay) return authority.replay;
        await this.assertEmptyPreparation(tx, floorId, prepared, input.baseRevision + 1, authority.now);

        // Clearing status/owner/expiry fences all old attempts, including attempt
        // 3 (the bounded attempt counter must not be incremented past its limit).
        // Delete jobs only after scene/slot dependents: this also releases U4b's
        // preparedMapGenerationId FK and legacy source/rendered/preview pins.
        const cancelled = await tx.floorImportJob.updateMany({
          where: { floorId, status: { in: ["queued", "processing", "region_selection_required", "review_required", "applying"] } },
          data: { status: "cancelled", stage: "cancelled", leaseOwner: null, leaseExpiresAt: null,
            failureCode: null, failureMessage: null, cancelledAt: authority.now }
        });
        await tx.floorLightSlot.deleteMany({ where: { floorId } });
        await tx.floorCadScene.deleteMany({ where: { floorId } });
        await tx.floorMapObject.deleteMany({ where: { floorId } });
        await tx.floorMapRevision.deleteMany({ where: { floorId } });
        await tx.floorMapStage.deleteMany({ where: { floorId } });
        const imports = await tx.floorImportJob.deleteMany({ where: { floorId } });
        // Attempt cleanup tombstones intentionally survive job deletion: a late
        // PUT must still be discoverable. No S3 delete occurs in this transaction.
        const fixtures = await tx.fixture.updateMany({ where: { floorId },
          data: { x: 0, y: 0, placementStatus: "unplaced", positionVerifiedAt: null } });
        const plan = { imageUrl: "", sourceType: "none" as const, originalFileUrl: null, renderedImageUrl: null,
          width: EMPTY_MAP.width, height: EMPTY_MAP.height, gridSize: EMPTY_MAP.gridSize };
        await tx.floorPlan.upsert({ where: { floorId }, create: { floorId, ...plan }, update: { ...plan, version: { increment: 1 } } });

        const rows = await tx.fixture.findMany({ where: { floorId }, orderBy: { id: "asc" },
          select: { id: true, name: true, ratedWatt: true, x: true, y: true, size: true, placementStatus: true, positionVerifiedAt: true } });
        const snapshot = buildMapDocumentSnapshot({ document: prepared, lightSlots: [],
          fixtures: rows.map(row => ({ ...row, ratedWatt: row.ratedWatt.toString(), positionVerifiedAt: null })) });
        const snapshotSha256 = hashFloorEditorSnapshot(snapshot);
        const changeSummary = { reset: true, unplacedFixtures: fixtures.count, cancelledImports: cancelled.count, discardedImports: imports.count };
        const revision = await tx.floorMapRevision.create({ data: { floorId, revision: prepared.revision,
          snapshot: snapshot as Prisma.InputJsonValue, snapshotSha256, changeSummary, changedBy: user.id } });

        // pinRevision locks every prepared asset, rejects non-ready/claimed assets
        // and validates the ref. Publish only after that, in the SAME transaction.
        await this.store.pinRevision(tx, floorId, revision.id, prepared);
        await tx.floorMapDocument.upsert({ where: { floorId },
          create: { floorId, activeGenerationId: prepared.generationId, revision: prepared.revision },
          update: { activeGenerationId: prepared.generationId, revision: prepared.revision, changesSinceCheckpoint: 0, deltaDecodedBytes: 0 } });
        await tx.floorMapGeneration.update({ where: { id: prepared.generationId }, data: { status: "active" } });
        // Revisions, stage parts and import pins are gone and the active pointer
        // now names the new generation. Cascades release old chunk/index/display/
        // changeset refs, leaving asset ledgers for ordinary grace-period cleanup.
        // Include in-flight preparations: their next Floor-locked write will
        // fail its generation fence, and no old asset pin depends on a reaper.
        await tx.floorMapGeneration.deleteMany({ where: { floorId, id: { not: prepared.generationId } } });
        await tx.floor.update({ where: { id: floorId }, data: { mapRevision: prepared.revision } });
        await this.audit.record({ organizationId: authority.organizationId, siteId: floor.siteId, actorId: user.id,
          action: ACTION, targetType: "floor", targetId: floorId, outcome: "success", transaction: tx,
          metadata: { requestId: input.requestId, payloadHash, result: prepared, snapshotSha256, changeSummary } });
        return prepared;
      }, TRANSACTION_OPTIONS);
      published = result.generationId === prepared.generationId;
      return result;
    } finally {
      if (!published) {
        // Failed publication and losing same-request preparations have no live
        // refs. Cleanup failure must not replace the original error/result; the
        // durable preparation expiry/asset ledger remains the recovery path.
        try {
          if (await this.prisma.floorMapGeneration.findFirst({ where: { id: prepared.generationId, floorId } })) {
            await this.store.discardPreparedGeneration(floorId, prepared.generationId);
          }
        } catch { this.logger.warn("map reset preparation cleanup deferred"); }
      }
    }
  }

  private async authorizeLocked(tx: Prisma.TransactionClient, floorId: string, siteId: string,
    user: AuthenticatedUser, input: MapDocumentResetInput, payloadHash: string) {
    const site = await this.access.assertManageInTransaction(tx, user, siteId);
    const [floor] = await tx.$queryRaw<LockedFloor[]>(Prisma.sql`
      SELECT "siteId", "status"::text, "mapRevision", "editorLeaseFence", "editorLeaseHolderId",
        "editorLeaseTokenHash", "editorLeaseExpiresAt" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`);
    if (!floor || floor.siteId !== siteId) throw new NotFoundException("floor not found");
    assertActiveFloorStatus(floor.status);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    const existing = await tx.auditLog.findFirst({ where: { siteId, targetType: "floor", targetId: floorId,
      action: ACTION, outcome: "success", metadata: { path: ["requestId"], equals: input.requestId } } });
    if (existing) {
      const metadata = existing.metadata as Record<string, unknown>;
      if (existing.actorId !== user.id || metadata.payloadHash !== payloadHash) throw new ConflictException("map reset request ID conflict");
      return { organizationId: site.organizationId, now: clock.now, replay: mapDocumentRefSchema.parse(metadata.result) };
    }
    if (floor.editorLeaseHolderId !== user.id || floor.editorLeaseFence !== input.leaseFence ||
      floor.editorLeaseTokenHash !== hashEditorLeaseToken(input.leaseToken) || !floor.editorLeaseExpiresAt ||
      floor.editorLeaseExpiresAt <= clock.now) throw new ConflictException("floor editor lease is no longer active");
    if (floor.mapRevision !== input.baseRevision) throw new ConflictException("floor editor revision conflict");
    return { organizationId: site.organizationId, now: clock.now, replay: null };
  }

  private async assertEmptyPreparation(tx: Prisma.TransactionClient, floorId: string, ref: MapDocumentRef, revision: number, now: Date) {
    const generation = await tx.floorMapGeneration.findFirst({ where: { floorId, id: ref.generationId } });
    const head = await tx.floorMapDocument.findUnique({ where: { floorId } });
    if (!generation || generation.status !== "prepared" || generation.expiresAt <= now || generation.baseRevision !== revision || ref.revision !== revision ||
      generation.elementCount !== 0 || ref.elementCount !== 0 || generation.sourceGenerationId !== null ||
      generation.sourceRevision !== null || (head && head.revision !== revision - 1) ||
      await tx.floorMapChunk.count({ where: { generationId: ref.generationId } }) ||
      await tx.floorMapIndexShard.count({ where: { generationId: ref.generationId } }) ||
      await tx.floorMapDisplayAsset.count({ where: { generationId: ref.generationId } })) {
      throw new ConflictException("map reset preparation conflict");
    }
  }
}
