import { describe, expect, it, vi } from "vitest";
import { readCadSceneBytes, readCadSceneJson } from "./cad-scene-content";

describe("bounded CAD response reader", () => {
  it("accepts the exact decoded limit and parses JSON", async () => {
    await expect(readCadSceneBytes(new Response(new Uint8Array([1, 2, 3])), 3))
      .resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(readCadSceneJson(new Response('{"ok":true}'), 11)).resolves.toEqual({ ok: true });
  });

  it("rejects an oversized declared body before reading it", async () => {
    const response = new Response("1234", { headers: { "Content-Length": "4" } });
    const read = vi.spyOn(response.body!, "getReader");
    await expect(readCadSceneBytes(response, 3)).rejects.toThrow("limit");
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels a chunked or decompressed body when actual bytes exceed the limit", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel
    });
    const response = new Response(stream, { headers: { "Content-Length": "1", "Content-Encoding": "gzip" } });
    await expect(readCadSceneBytes(response, 3)).rejects.toThrow("limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("propagates aborted streams and rejects malformed UTF-8/JSON", async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new DOMException("aborted", "AbortError")); } });
    await expect(readCadSceneBytes(new Response(stream), 16)).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.locked).toBe(false);
    await expect(readCadSceneJson(new Response(new Uint8Array([255])), 16)).rejects.toThrow();
    await expect(readCadSceneJson(new Response("{"), 16)).rejects.toThrow();
  });
});
