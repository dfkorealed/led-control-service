import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";

@Injectable()
export class FloorAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService
  ) {}

  async createUploadIntent(
    floorId: string,
    organizationId: string,
    input: { kind: "original" | "rendered"; mimeType: string; sizeBytes: number; sha256: string }
  ) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: floorId, site: { organizationId } },
      select: { id: true }
    });
    if (!floor) throw new NotFoundException("floor not found");
    if (input.kind !== "original" && input.kind !== "rendered") throw new BadRequestException("invalid floor asset kind");

    const descriptor = await this.storage.createUploadDescriptor({
      floorId,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256
    });
    const asset = await this.prisma.floorAsset.create({
      data: {
        floorId,
        kind: input.kind,
        status: "pending",
        objectKey: descriptor.objectKey,
        publicUrl: descriptor.publicUrl,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        sha256: input.sha256.toLowerCase()
      }
    });
    return {
      assetId: asset.id,
      uploadUrl: descriptor.uploadUrl,
      publicUrl: descriptor.publicUrl,
      expiresInSeconds: descriptor.expiresInSeconds
    };
  }

  async completeUpload(floorId: string, assetId: string, organizationId: string) {
    const asset = await this.prisma.floorAsset.findFirst({
      where: { id: assetId, floorId, floor: { site: { organizationId } } }
    });
    if (!asset) throw new NotFoundException("floor asset not found");
    if (asset.status === "ready") return { id: asset.id, status: asset.status, publicUrl: asset.publicUrl };

    const head = await this.storage.headObject(asset.objectKey);
    const expectedChecksum = Buffer.from(asset.sha256, "hex").toString("base64");
    if (
      head.ContentType !== asset.mimeType ||
      head.ContentLength !== Number(asset.sizeBytes) ||
      head.ChecksumSHA256 !== expectedChecksum
    ) {
      throw new BadRequestException("uploaded object metadata does not match upload intent");
    }
    const ready = await this.prisma.floorAsset.update({
      where: { id: asset.id },
      data: { status: "ready", readyAt: new Date() }
    });
    return { id: ready.id, status: ready.status, publicUrl: ready.publicUrl };
  }
}
