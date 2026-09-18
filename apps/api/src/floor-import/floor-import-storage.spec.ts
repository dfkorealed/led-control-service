import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ObjectStorageService } from "../storage/object-storage.service";

describe("floor import private object storage", () => {
  it("streams a private source to a bounded file and verifies size, MIME and SHA-256", async () => {
    const bytes = Buffer.from("private DXF bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const client: any = { send: jest.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      return { Body: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]), ContentLength: bytes.length,
        ContentType: "application/dxf", ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64") };
    }) };
    const storage = new ObjectStorageService(client, { bucket: "private-floors", publicBaseUrl: "https://example.test/private-floors" });
    const root = await mkdtemp(join(tmpdir(), "floor-source-")); const path = join(root, "source.dxf");
    try {
      await expect(storage.downloadFloorAssetToFile("floors/floor-1/source.dxf", path, {
        maxBytes: bytes.length, expectedBytes: bytes.length, expectedMimeType: "application/dxf", expectedSha256: sha256
      })).resolves.toEqual({ sizeBytes: bytes.length, sha256 });
      expect(await readFile(path)).toEqual(bytes);
      await expect(storage.downloadFloorAssetToFile("floors/floor-1/source.dxf", path, {
        maxBytes: bytes.length - 1, expectedBytes: bytes.length, expectedMimeType: "application/dxf", expectedSha256: sha256
      })).rejects.toThrow(/limit/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("writes rendered SVG as a private checksummed floor object", async () => {
    const client: any = { send: jest.fn().mockResolvedValue({}) };
    const storage = new ObjectStorageService(client, { bucket: "private-floors", publicBaseUrl: "https://example.test/private-floors" });
    const bytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    await storage.putFloorRenderedObject("floors/floor-1/render.svg", bytes, { width: 1200, height: 800 });
    const command = client.send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({ Bucket: "private-floors", Key: "floors/floor-1/render.svg",
      ContentType: "image/svg+xml", ContentLength: bytes.length, CacheControl: "private, no-store" });
    expect(command.input.Metadata).toEqual({ "cad-width": "1200", "cad-height": "800" });
    expect(command.input.ChecksumSHA256).toBe(createHash("sha256").update(bytes).digest("base64"));
  });

  it("reads rendered viewport metadata only when HEAD matches the locked asset ledger", async () => {
    const sha256 = "b".repeat(64);
    const client: any = { send: jest.fn().mockResolvedValue({
      ContentLength: 321,
      ContentType: "image/svg+xml",
      ContentEncoding: "gzip",
      ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      Metadata: { "cad-width": "640", "cad-height": "480" }
    }) };
    const storage = new ObjectStorageService(client, { bucket: "private-floors", publicBaseUrl: "https://example.test/private-floors" });

    await expect(storage.readFloorRenderedMetadata("floors/floor-1/render.svg", {
      sizeBytes: 321, sha256, mimeType: "image/svg+xml", contentEncoding: "gzip"
    })).resolves.toEqual({ width: 640, height: 480 });
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);

    await expect(storage.readFloorRenderedMetadata("floors/floor-1/render.svg", {
      sizeBytes: 321, sha256: "c".repeat(64), mimeType: "image/svg+xml", contentEncoding: "gzip"
    })).rejects.toThrow(/ledger/i);

    client.send.mockResolvedValueOnce({
      ContentLength: 321, ContentType: "image/svg+xml",
      ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      Metadata: { "cad-width": "640", "cad-height": "480" }
    });
    await expect(storage.readFloorRenderedMetadata("floors/floor-1/render.svg", {
      sizeBytes: 321, sha256, mimeType: "image/svg+xml", contentEncoding: "gzip"
    })).rejects.toThrow(/ledger/i);
  });

  it("rejects CAD tile objects whose size, hash, or bounds differ from the asset ledger", async () => {
    const sha256 = "d".repeat(64);
    const bounds = { minX: 0, minY: 0, maxX: 512, maxY: 512 };
    const validHead = {
      ContentLength: 128,
      ContentType: "application/vnd.led-control.cad-tile",
      ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      Metadata: {
        "cad-min-x": "0", "cad-min-y": "0", "cad-max-x": "512", "cad-max-y": "512"
      }
    };
    const client: any = { send: jest.fn() };
    const storage = new ObjectStorageService(client, {
      bucket: "private-floors",
      publicBaseUrl: "https://example.test/private-floors"
    });
    const expected = {
      sizeBytes: 128,
      sha256,
      contentType: "application/vnd.led-control.cad-tile",
      bounds
    };

    client.send.mockResolvedValueOnce(validHead);
    await expect(storage.verifyCadSceneObject("floors/floor-1/tile.bin", expected)).resolves.toBeUndefined();
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);

    client.send.mockResolvedValueOnce({ ...validHead, ContentLength: 127 });
    await expect(storage.verifyCadSceneObject("floors/floor-1/tile.bin", expected)).rejects.toThrow(/HEAD/);

    client.send.mockResolvedValueOnce({
      ...validHead,
      ChecksumSHA256: Buffer.from("e".repeat(64), "hex").toString("base64")
    });
    await expect(storage.verifyCadSceneObject("floors/floor-1/tile.bin", expected)).rejects.toThrow(/HEAD/);

    client.send.mockResolvedValueOnce({
      ...validHead,
      Metadata: { ...validHead.Metadata, "cad-max-x": "511" }
    });
    await expect(storage.verifyCadSceneObject("floors/floor-1/tile.bin", expected)).rejects.toThrow(/bounds/);
  });
});
