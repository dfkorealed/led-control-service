import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";

@Injectable()
export class FloorAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async createUploadIntent(
    user: AuthenticatedUser,
    floorId: string,
    input: { kind: "original" | "rendered"; mimeType: string; sizeBytes: number; sha256: string }
  ) {
    const floor = await this.findFloor(floorId);
    if (!floor) throw new NotFoundException("floor not found");
    await this.siteAccess.assert(user, floor.siteId, "manage");
    if (input.kind !== "original" && input.kind !== "rendered") throw new BadRequestException("invalid floor asset kind");

    const prepared = this.storage.prepareFloorAssetUpload({
      floorId,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256
    });
    const asset = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; siteId: string }>>(Prisma.sql`
        SELECT floor."id", floor."siteId"
        FROM "Floor" AS floor
        JOIN "Site" AS site ON site."id" = floor."siteId"
        WHERE floor."id" = ${floorId}
        FOR UPDATE OF site, floor
      `);
      if (locked.length !== 1 || locked[0].siteId !== floor.siteId) throw new NotFoundException("floor not found");
      await this.siteAccess.assertManageInTransaction(tx, user, floor.siteId);
      return tx.floorAsset.create({
        data: {
          floorId,
          kind: input.kind,
          status: "pending",
          objectKey: prepared.objectKey,
          mimeType: input.mimeType,
          sizeBytes: BigInt(input.sizeBytes),
          sha256: input.sha256.toLowerCase(),
          uploadExpiresAt: null
        }
      });
    });
    let uploadUrl: string;
    try {
      uploadUrl = await this.storage.createFloorAssetUploadUrl({
        objectKey: prepared.objectKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256
      });
    } catch {
      throw new ServiceUnavailableException("floor asset upload signing is temporarily unavailable");
    }
    const uploadExpiresAt = new Date(Date.now() + prepared.expiresInSeconds * 1000);
    try {
      const expiryRecorded = await this.prisma.floorAsset.updateMany({
        where: { id: asset.id, status: "pending", uploadExpiresAt: null, cleanupStartedAt: null },
        data: { uploadExpiresAt }
      });
      if (expiryRecorded.count !== 1) {
        throw new Error("floor asset upload ledger is no longer pending");
      }
    } catch {
      // The URL is never returned unless its exact lifetime is durable. A null expiry
      // remains recoverable by the abandoned-signing branch of the pending sweeper.
      throw new ServiceUnavailableException("floor asset upload signing is temporarily unavailable");
    }
    return {
      assetId: asset.id,
      uploadUrl,
      accessPath: this.accessPath(floorId, asset.id),
      expiresInSeconds: prepared.expiresInSeconds
    };
  }

  async completeUpload(user: AuthenticatedUser, floorId: string, assetId: string) {
    const floor = await this.findFloor(floorId);
    if (!floor) throw new NotFoundException("floor not found");
    await this.siteAccess.assert(user, floor.siteId, "manage");
    const asset = await this.prisma.floorAsset.findFirst({
      where: { id: assetId, floorId }
    });
    if (!asset) throw new NotFoundException("floor asset not found");
    if (asset.status === "ready") return this.assetResponse(asset, floorId);
    if (asset.cleanupStartedAt) {
      throw new ConflictException("floor asset upload expired and cleanup has started");
    }

    let head;
    try {
      head = await this.storage.headObject(asset.objectKey);
    } catch (error) {
      throw floorAssetHeadException(error);
    }
    const expectedChecksum = Buffer.from(asset.sha256, "hex").toString("base64");
    if (
      head.ContentType !== asset.mimeType ||
      head.ContentLength !== Number(asset.sizeBytes) ||
      head.ChecksumSHA256 !== expectedChecksum
    ) {
      throw new BadRequestException("uploaded object metadata does not match upload intent");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertManageInTransaction(tx, user, floor.siteId);
      const lockedAssets = await tx.$queryRaw<Array<{
        id: string;
        floorId: string;
        siteId: string;
        kind: string;
        status: string;
        objectKey: string;
        mimeType: string;
        sizeBytes: bigint;
        sha256: string;
        uploadExpiresAt: Date | null;
        cleanupStartedAt: Date | null;
        readyAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }>>(Prisma.sql`
        SELECT asset.*, floor."siteId"
        FROM "FloorAsset" AS asset
        JOIN "Floor" AS floor ON floor."id" = asset."floorId"
        WHERE asset."id" = ${assetId}
          AND asset."floorId" = ${floorId}
          AND floor."siteId" = ${floor.siteId}
        FOR UPDATE OF floor, asset
      `);
      const locked = lockedAssets[0];
      if (!locked) throw new NotFoundException("floor asset not found");
      if (locked.status === "ready") return this.assetResponse(locked, floorId);
      if (locked.cleanupStartedAt) {
        throw new ConflictException("floor asset upload expired while completion was in progress");
      }
      if (locked.objectKey !== asset.objectKey) {
        throw new ConflictException("floor asset changed while completion was in progress");
      }
      const lockedExpectedChecksum = Buffer.from(locked.sha256, "hex").toString("base64");
      if (
        head.ContentType !== locked.mimeType ||
        head.ContentLength !== Number(locked.sizeBytes) ||
        head.ChecksumSHA256 !== lockedExpectedChecksum
      ) {
        throw new BadRequestException("uploaded object metadata does not match upload intent");
      }

      const readyAt = new Date();
      const promoted = await tx.floorAsset.update({
        where: { id: locked.id },
        data: { status: "ready", readyAt }
      });
      return this.assetResponse(promoted, floorId);
    });
  }

  async listAssets(user: AuthenticatedUser, floorId: string) {
    const floor = await this.findFloor(floorId);
    if (!floor) throw new NotFoundException("floor not found");
    await this.siteAccess.assert(user, floor.siteId, "read");
    const assets = await this.prisma.floorAsset.findMany({
      where: { floorId, status: "ready" },
      orderBy: { createdAt: "asc" }
    });
    // Upload validation caps assets at 50 MiB, safely within JSON's exact integer range.
    return assets.map((asset) => this.assetResponse(asset, floorId));
  }

  async getContentRedirect(user: AuthenticatedUser, floorId: string, assetId: string) {
    const floor = await this.findFloor(floorId);
    if (!floor) throw new NotFoundException("floor not found");
    await this.siteAccess.assert(user, floor.siteId, "read");
    const asset = await this.prisma.floorAsset.findFirst({
      where: { id: assetId, floorId, status: "ready" },
      select: { objectKey: true }
    });
    if (!asset) throw new NotFoundException("floor asset not found");
    try {
      return { url: await this.storage.createFloorAssetDownloadUrl(asset.objectKey) };
    } catch {
      throw new ServiceUnavailableException("floor asset download signing is temporarily unavailable");
    }
  }

  private findFloor(floorId: string) {
    return this.prisma.floor.findUnique({ where: { id: floorId }, select: { id: true, siteId: true } });
  }

  private assetResponse(asset: {
    id: string;
    floorId?: string;
    kind?: string;
    status: string;
    mimeType?: string;
    sizeBytes?: bigint;
    sha256?: string;
    readyAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
  }, floorId: string) {
    return {
      id: asset.id,
      ...(asset.kind === undefined ? {} : { kind: asset.kind }),
      status: asset.status,
      ...(asset.mimeType === undefined ? {} : { mimeType: asset.mimeType }),
      ...(asset.sizeBytes === undefined ? {} : { sizeBytes: Number(asset.sizeBytes) }),
      ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
      ...(asset.readyAt === undefined ? {} : { readyAt: asset.readyAt }),
      ...(asset.createdAt === undefined ? {} : { createdAt: asset.createdAt }),
      ...(asset.updatedAt === undefined ? {} : { updatedAt: asset.updatedAt }),
      accessPath: this.accessPath(floorId, asset.id)
    };
  }

  private accessPath(floorId: string, assetId: string) {
    return `/api/floors/${encodeURIComponent(floorId)}/assets/${encodeURIComponent(assetId)}/content`;
  }
}

function floorAssetHeadException(error: unknown) {
  const storageError = error as {
    name?: string;
    code?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = storageError?.$metadata?.httpStatusCode;
  const code = storageError?.name ?? storageError?.code ?? storageError?.Code;

  // Only a confirmed absent object is a client-visible 404. Authorization failures
  // indicate broken server-side storage access and must remain distinguishable.
  if (status === 404 || code === "NotFound" || code === "NoSuchKey" || code === "NoSuchObject") {
    return new NotFoundException("uploaded floor asset object not found");
  }
  if (status === 401 || status === 403 || code === "AccessDenied" || code === "Forbidden") {
    return new ServiceUnavailableException("floor asset storage authorization failed");
  }
  return new ServiceUnavailableException("floor asset storage is temporarily unavailable");
}
