import { createHash } from "node:crypto";
import { encodeCadSceneTile } from "../floor-import/cad-scene-codec";
import { CadSceneEvidenceService } from "./cad-scene-evidence.service";

const primitive = {
  type: "line" as const,
  elementId: "cad-element-00000000000000000000000000000001",
  groupId: null,
  layerName: "WALL",
  sourceType: "LINE",
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  clipBounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 },
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 },
  geometry: { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }
};

describe("CadSceneEvidenceService", () => {
  it("reads a bounded private tile and validates ledger integrity before decoding", async () => {
    const payload = encodeCadSceneTile([primitive]);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const send = jest.fn().mockResolvedValue({
      Body: (async function* () { yield payload; })(),
      ContentLength: payload.length,
      ContentType: "application/vnd.led-control.cad-tile",
      ContentEncoding: undefined,
      ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64")
    });
    const service = new CadSceneEvidenceService(
      { send } as never,
      { bucket: "floor-assets", publicBaseUrl: "https://objects.invalid/floor-assets" }
    );

    await expect(service.readTile({
      objectKey: "floors/floor-1/tile.bin",
      byteSize: payload.length,
      sha256,
      bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
    })).resolves.toEqual([primitive]);
  });

  it("fails closed for mismatched object metadata or bytes", async () => {
    const payload = encodeCadSceneTile([primitive]);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const service = new CadSceneEvidenceService(
      { send: jest.fn().mockResolvedValue({
        Body: (async function* () { yield payload; })(),
        ContentLength: payload.length + 1,
        ContentType: "application/vnd.led-control.cad-tile",
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64")
      }) } as never,
      { bucket: "floor-assets", publicBaseUrl: "https://objects.invalid/floor-assets" }
    );

    await expect(service.readTile({
      objectKey: "floors/floor-1/tile.bin",
      byteSize: payload.length,
      sha256,
      bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
    })).rejects.toThrow("CAD scene tile object does not match its ledger");
  });
});
