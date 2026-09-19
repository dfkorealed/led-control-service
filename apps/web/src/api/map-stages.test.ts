import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapOp, SaveEditorStateInput } from "@led-control/shared";
import { mapOpSchema } from "@led-control/shared/map-document-contracts";
import { ApiError } from "./client";
import { createMapStageClient, MAP_STAGE_PART_BYTES, streamMapParts } from "./map-stages";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const envelope: SaveEditorStateInput = { expectedRevision: 3, leaseToken: "token", leaseFence: 2,
  fixtureUpdates: [], slotAssignments: [], objectCreates: [], objectUpdates: [], objectDeletes: [],
  documentChanges: { requestId: "request", generationId: "generation", operations: [] } };
const lease = { leaseToken: "token", leaseFence: 2 };
const dto = (status = "preparing") => ({ id: "stage", status, generationId: "generation", baseRevision: 3,
  partCount: 0, decodedBytes: 0, expiresAt: "2099-01-01T00:00:00.000Z", errorCode: null, result: null });
const preview = { formatVersion: 1, generationId: "prepared", revision: 4, width: 1000, height: 1000,
  gridSize: 10, elementCount: 0, manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
async function* operations(count = 10000): AsyncGenerator<MapOp> {
  for (let i = 0; i < count; i++) yield { kind: "delete", id: `한글-${i}-${"x".repeat(60)}` };
}
afterEach(() => vi.restoreAllMocks());

describe("bounded map stage transport", () => {
  it("streams exact UTF8 JSON and incremental SHA256 across 512KiB boundaries", async () => {
    const parts = [];
    for await (const part of streamMapParts(operations())) parts.push(part);
    expect(parts.length).toBeGreaterThan(1);
    const bytes = Buffer.concat(parts.map(part => Buffer.from(part.bytes)));
    const expected = [];
    for await (const op of operations()) expected.push(op);
    expect(bytes.toString()).toBe(JSON.stringify(expected));
    expect(parts.every(part => part.bytes.byteLength <= MAP_STAGE_PART_BYTES)).toBe(true);
    for (const part of parts) expect(part.sha256).toBe(hash(part.bytes));
    expect(parts.at(-1)!.streamSha256).toBe(hash(bytes));
  });

  it("applies upload backpressure and retries a lost part with identical bytes", async () => {
    let produced = 0, failed = false;
    async function* source() { for await (const op of operations(20000)) { produced++; yield op; } }
    const requests: Array<{ path: string; body: any }> = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, body });
      if (path.endsWith("/parts/0") && !failed) { failed = true; expect(produced).toBeLessThan(20000); throw new ApiError("lost", 503, null); }
      if (init?.method === undefined) return { ...dto("ready"), preview };
      return dto(path.endsWith("/prepare") ? "queued" : "preparing");
    });
    const client = createMapStageClient({ request, pollMs: 0 });
    const ready = await client.prepare("floor", envelope, source());
    expect(ready.preview).toEqual(preview);
    const first = requests.filter(item => item.path.endsWith("/parts/0"));
    expect(first).toHaveLength(2); expect(first[0]).toEqual(first[1]);
    expect(requests.some(item => item.path.endsWith("/commit"))).toBe(false);
    const body = requests.find(item => item.path.endsWith("/prepare"))!.body;
    expect(body).toMatchObject({ ...lease, partCount: ready.intent.partCount, decodedBytes: ready.intent.decodedBytes });
  });

  it.each([401, 403, 409])("does not retry authority failure %i", async status => {
    const request = vi.fn().mockRejectedValue(new ApiError("denied", status, null));
    await expect(createMapStageClient({ request }).prepare("floor", envelope, operations(1))).rejects.toThrow("denied");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("prepares history with lease-only intent and no parts/live commit", async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => init?.method ? dto() : { ...dto("ready"), preview });
    const ready = await createMapStageClient({ request, pollMs: 0 }).prepareHistory("floor", envelope, 1);
    expect(JSON.parse(String(request.mock.calls[0][1]!.body))).toMatchObject({ historySource: { revision: 1 } });
    expect(ready.intent).toEqual(lease);
    expect(request.mock.calls.some(([path]) => path.includes("/parts/") || path.endsWith("/commit"))).toBe(false);
  });

  it("does not call a failed cancellation cancelled; reconciles committed receipt", async () => {
    const request = vi.fn().mockRejectedValueOnce(new ApiError("already committed", 409, null)).mockResolvedValueOnce(dto("committed"));
    const status = await createMapStageClient({ request }).cancel("floor", "stage", lease);
    expect(status.status).toBe("committed");
    expect(request.mock.calls[1][1]?.method).toBeUndefined();
  });

  it("propagates aborted source without queueing a commit", async () => {
    const controller = new AbortController(); controller.abort();
    const request = vi.fn();
    await expect(createMapStageClient({ request }).prepare("floor", envelope, operations(1), { signal: controller.signal })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("hashes a greater-than-35MiB stream without retaining canonical arrays", async () => {
    const expected = createHash("sha256"); let produced = 0, count = 0, bytes = 0, finalHash = "";
    async function* source(): AsyncGenerator<MapOp> {
      expected.update("[");
      for (let i = 0; i < 3500; i++) {
        const op: MapOp = { kind: "add", element: { id: `text-${i}`, type: "text", groupId: null, layerId: "layer", zIndex: 0, visible: true, locked: false, provenance: null,
          transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 },
          geometry: { position: { x: 1, y: 1 }, width: 100, height: 100, fontSize: 16, text: "한".repeat(3600) } } };
        expected.update((i ? "," : "") + JSON.stringify(mapOpSchema.parse(op))); produced++; yield op;
      }
      expected.update("]");
    }
    for await (const part of streamMapParts(source())) {
      count++; bytes += part.bytes.length;
      expect(part.sha256).toBe(hash(part.bytes));
      if (count === 1) expect(produced).toBeLessThan(100);
      if (part.streamSha256) finalHash = part.streamSha256;
    }
    expect(bytes).toBeGreaterThan(35 * 1024 * 1024); expect(count).toBeGreaterThan(70);
    expect(finalHash).toBe(expected.digest("hex"));
  });

  it("does not turn failed DELETE and failed reconciliation into cancellation success", async () => {
    const request = vi.fn().mockRejectedValue(new ApiError("denied", 403, null));
    await expect(createMapStageClient({ request }).cancel("floor", "stage", lease)).rejects.toThrow("denied");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
