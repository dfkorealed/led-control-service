import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMapDocumentSource } from "./map-document";

const sceneId = "00000000-0000-4000-8000-000000000001";
const manifestId = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const payload = new Uint8Array([1, 2, 3]);
const sha256 = createHash("sha256").update(payload).digest("hex");
const ref = { formatVersion: 1 as const, generationId: "generation-a", revision: 2, width: 1024, height: 1024,
  gridSize: 50, elementCount: 1, manifest: { assetId: manifestId, byteSize: 100, decodedByteSize: 100, sha256 } };
const tile = { version: 2 as const, sceneId, assetId, tileX: 0, tileY: 0, lod: 0 as const, part: 0,
  primitiveCount: 1, byteSize: payload.length, sha256, bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 } };
const manifest = { generationId: ref.generationId, revision: ref.revision, canonical: ref.manifest,
  groups: [], layers: [], displayLayerBindings: [{ layerName: "retired", layerId: "deleted-layer" }],
  display: { version: 2, sceneId, regionId: "manual", manifestAssetId: manifestId,
    width: 1024, height: 1024, padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", primitiveCount: 1,
    tileCount: 1, byteSize: 100, sha256, sourceBounds: { minX: 0, minY: 0, maxX: 1024, maxY: 1024 },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [tile] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const signal = () => new AbortController().signal;
const setup = (jobId?: string) => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher); vi.stubGlobal("crypto", webcrypto);
  return { fetcher, source: createMapDocumentSource({ floorId: "floor 1", authScope: "principal:1:session:2", jobId }) };
};
afterEach(() => vi.unstubAllGlobals());

describe("map document HTTP provider", () => {
  it("rejects common v1 manifests instead of accepting missing ordering metadata", async () => {
    const { source, fetcher } = setup();
    fetcher.mockResolvedValueOnce(json({ ...manifest, display: { ...manifest.display, version: 1,
      tiles: [{ ...tile, version: 1 }] } }));
    await expect(source.getManifest(ref, signal())).rejects.toThrow();
    await expect(source.loadDisplayTile(tile, signal())).rejects.toThrow("manifest");
  });

  it("uses the approved scoped routes and native nonempty manifest without canonical overview reads", async () => {
    const { source, fetcher } = setup("job 1");
    fetcher.mockResolvedValueOnce(json(manifest));
    expect(await source.getManifest(ref, signal())).toEqual(manifest);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/floors/floor%201/import-jobs/job%201/map-document/manifest?generationId=generation-a&revision=2");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "include", redirect: "error", cache: "no-store" });
    fetcher.mockResolvedValueOnce(json({ generationId: ref.generationId, revision: 2, operations: [], nextCursor: "next" }));
    expect((await source.getChanges(ref, "cursor /+", signal())).nextCursor).toBe("next");
    expect(String(fetcher.mock.calls[1][0])).toContain("cursor=cursor+%2F%2B");
    fetcher.mockResolvedValueOnce(json([]));
    expect(await source.getElements(ref, ["deleted"], signal())).toEqual([]);
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: "POST", body: '{"ids":["deleted"]}' });
  });

  it("pins tile identity to a manifest and verifies size and SHA-256", async () => {
    const { source, fetcher } = setup();
    await expect(source.loadDisplayTile(tile, signal())).rejects.toThrow("manifest");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(json(manifest)); await source.getManifest(ref, signal());
    fetcher.mockResolvedValueOnce(new Response(payload, { headers: { "Content-Type": "application/octet-stream", "Content-Length": "3" } }));
    expect(await source.loadDisplayTile(tile, signal())).toEqual(payload);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain(`/tiles/${assetId}?generationId=generation-a&revision=2`);
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 4])));
    await expect(source.loadDisplayTile(tile, signal())).rejects.toThrow("integrity");
    await expect(source.loadDisplayTile({ ...tile, sha256: "f".repeat(64) }, signal())).rejects.toThrow("manifest");
  });

  it("rejects streamed bodies over budget even with a false Content-Length and cancels the reader", async () => {
    const { source, fetcher } = setup();
    const cancel = vi.fn();
    fetcher.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel
    }), { headers: { "Content-Length": "1" } }));
    await expect(source.getChanges(ref, undefined, signal())).rejects.toThrow("byte limit");
    expect(cancel).toHaveBeenCalled();
  });

  it("aborts a hanging stream, rejects stale pages and preserves HTTP conflict status", async () => {
    const { source, fetcher } = setup(); const controller = new AbortController(); const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = source.getChanges(ref, undefined, controller.signal);
    await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(json({ generationId: ref.generationId, revision: 1, operations: [], nextCursor: null }));
    await expect(source.getChanges(ref, undefined, signal())).rejects.toThrow("reference");
    fetcher.mockResolvedValueOnce(json({ code: "STALE" }, 409));
    await expect(source.getChanges(ref, undefined, signal())).rejects.toMatchObject({ status: 409 });
  });

  it("bounds selection input and response to requested IDs without dropping missing IDs silently", async () => {
    const { source, fetcher } = setup();
    await expect(source.getElements(ref, Array.from({ length: 129 }, (_, i) => String(i)), signal())).rejects.toThrow("ID");
    await expect(source.getElements(ref, ["x", "x"], signal())).rejects.toThrow("ID");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(json([{ id: "outside" }]));
    await expect(source.getElements(ref, ["x"], signal())).rejects.toThrow();
    fetcher.mockResolvedValueOnce(json({ generationId: ref.generationId, revision: ref.revision, ids: ["a"], nextCursor: "next" }));
    expect(await source.getSelection(ref, { groupId: "group", limit: 128 }, signal())).toMatchObject({ ids: ["a"], nextCursor: "next" });
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ method: "POST", body: '{"groupId":"group","limit":128}' });
  });
});
