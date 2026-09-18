import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Inject, Injectable } from "@nestjs/common";
import {
  CAD_SCENE_MAX_TILE_BYTE_SIZE,
  type CadBounds,
  type CadScenePrimitive
} from "@led-control/shared";
import { createHash } from "node:crypto";
import { decodeCadSceneTile } from "../floor-import/cad-scene-codec";
import {
  OBJECT_STORAGE_CLIENT,
  OBJECT_STORAGE_OPTIONS,
  type ObjectStorageOptions
} from "../storage/object-storage.service";

export interface CadSceneEvidenceTile {
  objectKey: string;
  byteSize: number;
  sha256: string;
  bounds: CadBounds;
}

@Injectable()
export class CadSceneEvidenceService {
  constructor(
    @Inject(OBJECT_STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(OBJECT_STORAGE_OPTIONS) private readonly options: ObjectStorageOptions
  ) {}

  async readTile(tile: CadSceneEvidenceTile): Promise<CadScenePrimitive[]> {
    this.assertLedger(tile);
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: tile.objectKey,
      ChecksumMode: "ENABLED"
    }), { abortSignal: AbortSignal.timeout(10_000) });

    const checksum = Buffer.from(tile.sha256, "hex").toString("base64");
    if (!result.Body || result.ContentLength !== tile.byteSize ||
        result.ContentType !== "application/vnd.led-control.cad-tile" ||
        result.ContentEncoding !== undefined || result.ChecksumSHA256 !== checksum) {
      throw new Error("CAD scene tile object does not match its ledger");
    }

    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const value of result.Body as AsyncIterable<Uint8Array | string>) {
      const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > tile.byteSize || sizeBytes > CAD_SCENE_MAX_TILE_BYTE_SIZE) {
        throw new Error("CAD scene tile byte limit exceeded");
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (sizeBytes !== tile.byteSize || hash.digest("hex") !== tile.sha256) {
      throw new Error("CAD scene tile bytes do not match its ledger");
    }

    return decodeCadSceneTile(Buffer.concat(chunks, sizeBytes), {
      byteSize: tile.byteSize,
      sha256: tile.sha256,
      bounds: tile.bounds
    });
  }

  private assertLedger(tile: CadSceneEvidenceTile) {
    if (!/^floors\/[^/]+\/[A-Za-z0-9._-]+$/.test(tile.objectKey) ||
        !Number.isSafeInteger(tile.byteSize) || tile.byteSize < 1 ||
        tile.byteSize > CAD_SCENE_MAX_TILE_BYTE_SIZE || !/^[a-f0-9]{64}$/.test(tile.sha256)) {
      throw new Error("CAD scene tile ledger metadata is invalid");
    }
  }
}
