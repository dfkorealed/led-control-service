import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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
});
