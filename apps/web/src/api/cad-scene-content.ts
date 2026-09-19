/** Bound decoded bytes too: Content-Length may describe compressed storage data. */
export async function readCadSceneBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid CAD response limit");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error("CAD response exceeds byte limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("CAD response exceeds byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readCadSceneJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readCadSceneBytes(response, maxBytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
