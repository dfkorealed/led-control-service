import { BadRequestException } from "@nestjs/common";
import { ObjectStorageService } from "./object-storage.service";

describe("ObjectStorageService", () => {
  const service = new ObjectStorageService({} as never, {
    bucket: "floor-assets",
    publicBaseUrl: "http://localhost:9000/floor-assets",
    presign: jest.fn().mockResolvedValue("https://upload.example/signed")
  });

  it.each(["image/jpeg", "image/png", "application/pdf"])("accepts supported MIME %s", async (mimeType) => {
    await expect(
      service.createUploadDescriptor({ floorId: "floor-1", mimeType, sizeBytes: 1024, sha256: "a".repeat(64) })
    ).resolves.toMatchObject({ uploadUrl: "https://upload.example/signed", publicUrl: expect.stringContaining("floor-assets/") });
  });

  it("rejects unsupported MIME, oversized files, and invalid checksums", async () => {
    await expect(
      service.createUploadDescriptor({ floorId: "floor-1", mimeType: "image/svg+xml", sizeBytes: 10, sha256: "a".repeat(64) })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createUploadDescriptor({ floorId: "floor-1", mimeType: "image/png", sizeBytes: 50 * 1024 * 1024 + 1, sha256: "a".repeat(64) })
    ).rejects.toThrow("50 MB");
    await expect(
      service.createUploadDescriptor({ floorId: "floor-1", mimeType: "image/png", sizeBytes: 10, sha256: "invalid" })
    ).rejects.toThrow("sha256");
  });

  it("deletes an uploaded object from the configured bucket", async () => {
    const send = jest.fn().mockResolvedValue({});
    const deletingService = new ObjectStorageService({ send } as never, {
      bucket: "floor-assets",
      publicBaseUrl: "http://localhost:9000/floor-assets"
    });

    await deletingService.deleteObject("floors/floor-1/file.png");

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      input: { Bucket: "floor-assets", Key: "floors/floor-1/file.png" }
    }));
  });
});
