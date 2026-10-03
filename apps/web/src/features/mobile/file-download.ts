import { MOBILE_FILE_MAX_BYTES, MOBILE_FILE_MAX_CHUNK_BYTES, MOBILE_FILE_INACTIVITY_TIMEOUT_MS, mobileFileBeginSchema, mobileToWebMessageSchema, type MobileFileErrorCode } from "@led-control/shared/mobile-webview-contracts";
import { getMobileEnvironment, requiresNativeBootstrap } from "./mobile-environment";
import { postMobileMessage } from "./mobile-runtime";

export type MobileFileDownloadOutcome = "browser-download" | "handoff" | "cancelled";
export interface MobileFileMetadata { fileName: string; mimeType: "application/pdf" | "text/csv"; signal?: AbortSignal }
/** Fetch happens in the authorized web context, before the native protocol.
 * Keep its HTTP status separate from OS write/share errors. Browsers cannot
 * distinguish CORS denial, redirect rejection and network loss from TypeError.
 */
export type MobileFileFetchFailure = { reason: "http"; status: number } | { reason: "network" };
export type MobileFileExportErrorCode = MobileFileErrorCode | "FILE_FETCH_FAILED";
export class MobileFileExportError extends Error {
  constructor(public readonly code: MobileFileExportErrorCode, public readonly fetchFailure?: MobileFileFetchFailure) { super(code); this.name = "MobileFileExportError"; }
}
let busy = false;
function fail(code: MobileFileErrorCode): never { throw new MobileFileExportError(code); }
function ensureMode() {
  const environment = getMobileEnvironment();
  if (!environment && requiresNativeBootstrap()) fail("FILE_UNSUPPORTED");
  return environment;
}
function validateMetadata(input: MobileFileMetadata, byteLength = 1) {
  if (byteLength > MOBILE_FILE_MAX_BYTES) fail("FILE_TOO_LARGE");
  const result = mobileFileBeginSchema.safeParse({ version: 1, documentId: "validation", requestId: "validation", type: "file.begin", action: "share", fileName: input.fileName, mimeType: input.mimeType, byteLength });
  if (!result.success) fail("FILE_INVALID_MESSAGE");
}
function browserDownload(url: string, fileName: string) {
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.rel = "noopener";
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}
export async function downloadMobileAwareFile(input: MobileFileMetadata & { blob: Blob }): Promise<MobileFileDownloadOutcome> {
  validateMetadata(input, input.blob.size);
  if (input.signal?.aborted) return "cancelled";
  const environment = ensureMode();
  if (!environment) {
    const url = URL.createObjectURL(input.blob);
    try { browserDownload(url, input.fileName); } finally { URL.revokeObjectURL(url); }
    return "browser-download";
  }
  if (busy) fail("FILE_TRANSFER_BUSY"); busy = true;
  try { return await transferFile(input, environment.documentId); } finally { busy = false; }
}
export async function downloadMobileAwareUrl(input: MobileFileMetadata & { url: string }): Promise<MobileFileDownloadOutcome> {
  validateMetadata(input);
  let url: URL;
  try { url = new URL(input.url, window.location.href); } catch { fail("FILE_UNSUPPORTED"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) fail("FILE_UNSUPPORTED");
  if (input.signal?.aborted) return "cancelled";
  const environment = ensureMode();
  if (!environment) { browserDownload(url.href, input.fileName); return "browser-download"; }
  if (busy) fail("FILE_TRANSFER_BUSY"); busy = true;
  let transferring = false;
  try {
    const blob = await fetchBoundedFile(url, input);
    if (input.signal?.aborted) return "cancelled";
    if (getMobileEnvironment()?.documentId !== environment.documentId) fail("FILE_DOCUMENT_CHANGED");
    validateMetadata(input, blob.size);
    transferring = true;
    return await transferFile({ ...input, blob }, environment.documentId);
  } catch (error) {
    if (input.signal?.aborted && !transferring) return "cancelled";
    if (error instanceof MobileFileExportError) throw error;
    fail("FILE_WRITE_FAILED");
  } finally { busy = false; }
}

async function fetchBoundedFile(url: URL, input: MobileFileMetadata): Promise<Blob> {
  const controller = new AbortController();
  const abort = () => controller.abort(); input.signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const deadline = () => setTimeout(() => { timedOut = true; controller.abort(); }, MOBILE_FILE_INACTIVITY_TIMEOUT_MS);
  let timer = deadline(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // Never send our session cookie to a cross-origin signed object-storage URL.
    const response = await fetch(url.href, { signal: controller.signal, redirect: "error", credentials: url.origin === location.origin ? "include" : "omit" });
    if (!response.ok) throw new MobileFileExportError("FILE_FETCH_FAILED", { reason: "http", status: response.status });
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MOBILE_FILE_MAX_BYTES) fail("FILE_TOO_LARGE");
    if (!response.body) fail("FILE_UNSUPPORTED");
    reader = response.body.getReader(); const parts: BlobPart[] = []; let received = 0;
    while (true) {
      clearTimeout(timer); timer = deadline();
      const result = await reader.read();
      if (result.done) break;
      received += result.value.byteLength;
      if (received > MOBILE_FILE_MAX_BYTES) fail("FILE_TOO_LARGE");
      // Copy into an owned ArrayBuffer: a stream view can alias/reuse its buffer.
      parts.push(new Uint8Array(result.value).buffer);
    }
    return new Blob(parts, { type: input.mimeType });
  } catch (error) {
    if (timedOut) fail("FILE_TIMEOUT");
    if (error instanceof MobileFileExportError) throw error;
    // Do not retain signed URLs, raw storage bodies, paths or exception messages.
    throw new MobileFileExportError("FILE_FETCH_FAILED", { reason: "network" });
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
    controller.abort(); await reader?.cancel().catch(() => {});
  }
}

function transferFile(input: MobileFileMetadata & { blob: Blob }, documentId: string): Promise<MobileFileDownloadOutcome> {
  const requestId = crypto.randomUUID();
  const envelope = { version: 1 as const, documentId, requestId };
  return new Promise((resolve, reject) => {
    let settled = false; let ended = false; let cancelled = false;
    let expected: { index: number; bytes: number; resume: () => void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => { if (timer) clearTimeout(timer); };
    const armDeadline = () => { clearDeadline(); timer = setTimeout(() => finish(new MobileFileExportError("FILE_TIMEOUT")), MOBILE_FILE_INACTIVITY_TIMEOUT_MS); };
    const sendCancel = () => { try { postMobileMessage({ ...envelope, type: "file.cancel" }); } catch { /* Document disposal revokes the old transport. */ } };
    const finish = (outcome: MobileFileDownloadOutcome | Error) => {
      if (settled) return; settled = true; clearDeadline();
      window.removeEventListener("led-control:native-message", receive); window.removeEventListener("pagehide", changed);
      input.signal?.removeEventListener("abort", cancel);
      // Wake a pending pump after cancellation/failure; it checks settled before sending.
      expected?.resume(); expected = undefined;
      if (outcome instanceof Error) { sendCancel(); reject(outcome); } else resolve(outcome);
    };
    const changed = () => finish(new MobileFileExportError("FILE_DOCUMENT_CHANGED"));
    const cancel = () => {
      if (settled || cancelled) return; cancelled = true; sendCancel(); expected?.resume(); expected = undefined;
      // A completed transfer may already own an OS sheet. Explicit cancellation
      // cannot close it, so retain the one-file slot until native result returns.
      if (!ended) armDeadline();
    };
    const receive = (event: Event) => {
      if (getMobileEnvironment()?.documentId !== documentId) { changed(); return; }
      const parsed = mobileToWebMessageSchema.safeParse((event as CustomEvent<unknown>).detail);
      if (!parsed.success || parsed.data.documentId !== documentId || parsed.data.requestId !== requestId) return;
      const message = parsed.data;
      if (message.type === "file.result") {
        if (message.status === "failed") finish(new MobileFileExportError(message.errorCode!));
        else if (message.status === "cancelled") finish("cancelled");
        else if (ended) finish("handoff");
        else finish(new MobileFileExportError("FILE_SEQUENCE_ERROR"));
      } else if (message.type === "file.ack" && !cancelled) {
        if (!expected || message.nextIndex !== expected.index || message.receivedBytes !== expected.bytes) { finish(new MobileFileExportError("FILE_SEQUENCE_ERROR")); return; }
        const resume = expected.resume; expected = undefined; clearDeadline(); resume();
      }
    };
    const ack = (index: number, bytes: number, send: () => void) => new Promise<void>((resume) => {
      expected = { index, bytes, resume }; armDeadline(); send();
    });
    window.addEventListener("led-control:native-message", receive); window.addEventListener("pagehide", changed);
    input.signal?.addEventListener("abort", cancel, { once: true });
    void (async () => {
      try {
        await ack(0, 0, () => postMobileMessage({ ...envelope, type: "file.begin", action: "share", fileName: input.fileName, mimeType: input.mimeType, byteLength: input.blob.size }));
        let index = 0;
        for (let offset = 0; offset < input.blob.size; offset += MOBILE_FILE_MAX_CHUNK_BYTES) {
          if (settled || cancelled) return;
          armDeadline();
          const bytes = new Uint8Array(await input.blob.slice(offset, offset + MOBILE_FILE_MAX_CHUNK_BYTES).arrayBuffer());
          if (settled || cancelled) return;
          const dataBase64 = encodeChunk(bytes);
          await ack(index + 1, offset + bytes.length, () => postMobileMessage({ ...envelope, type: "file.chunk", index, dataBase64 })); index++;
        }
        if (settled || cancelled) return;
        // OS sharing is not an inactivity-limited byte transfer. Do not convert
        // a user's slow sheet interaction into false success, failure or cancel.
        clearDeadline(); ended = true;
        postMobileMessage({ ...envelope, type: "file.end", chunkCount: index });
      } catch (error) { finish(error instanceof MobileFileExportError ? error : new MobileFileExportError("FILE_WRITE_FAILED")); }
    })();
  });
}
function encodeChunk(bytes: Uint8Array): string {
  // Bound the temporary string to one64KiB chunk, never the full file.
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
