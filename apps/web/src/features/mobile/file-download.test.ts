import { Blob as NodeBlob } from "node:buffer";
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadMobileAwareFile, downloadMobileAwareUrl, MobileFileExportError } from "./file-download";

const boot = { version: 1, type: "mobile.bootstrap", documentId: "doc-file", requestId: "boot-file", mobile: true, state: "active", online: true };
type Message = { type: string; requestId: string; documentId: string; index?: number; dataBase64?: string; [key: string]: unknown };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function native() {
  vi.stubGlobal("Blob", NodeBlob);
  const sent: Message[] = [];
  vi.stubGlobal("ReactNativeWebView", { postMessage: (raw: string) => { sent.push(JSON.parse(raw)); } });
  vi.stubGlobal("__LED_CONTROL_NATIVE_ENVIRONMENT__", boot);
  vi.stubGlobal("__LED_CONTROL_NATIVE_DOCUMENT_ID__", boot.documentId);
  return sent;
}
function reply(message: Message, fields: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: { version: 1, documentId: message.documentId, requestId: message.requestId, ...fields } }));
}
function pdf(size = 3) { return new NodeBlob([new Uint8Array(size)], { type: "application/pdf" }) as unknown as Blob; }
describe("mobile-aware file delivery", () => {
  it.each([403, 410, 404, 500])("preserves signed file HTTP %i as a web fetch failure, before native begins", async (status) => {
    const sent = native();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private details", { status })));
    const error = await downloadMobileAwareUrl({ url: "https://files.example/report.pdf?signature=secret", fileName: "report.pdf", mimeType: "application/pdf" }).catch(error => error);
    expect(error).toBeInstanceOf(MobileFileExportError);
    expect(error).toMatchObject({ code: "FILE_FETCH_FAILED", fetchFailure: { reason: "http", status } });
    expect(error.message).toBe("FILE_FETCH_FAILED");
    expect(sent).toHaveLength(0);
  });
  it("preserves an opaque network/CORS failure without exposing the signed URL or claiming a native write failed", async () => {
    const sent = native();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch https://files.example/report.pdf?signature=secret")));
    const error = await downloadMobileAwareUrl({ url: "https://files.example/report.pdf?signature=secret", fileName: "report.pdf", mimeType: "application/pdf" }).catch(error => error);
    expect(error).toBeInstanceOf(MobileFileExportError);
    expect(error).toMatchObject({ code: "FILE_FETCH_FAILED", fetchFailure: { reason: "network" } });
    expect(error.fetchFailure).not.toHaveProperty("status");
    expect(error.message).toBe("FILE_FETCH_FAILED");
    expect(sent).toHaveLength(0);
  });
  it("keeps ordinary browser download local to an anchor and revokes the object URL", async () => {
    vi.stubGlobal("ReactNativeWebView", undefined); vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Browser");
    const clicked: string[] = []; vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    vi.stubGlobal("URL", class extends URL { static createObjectURL() { return "blob:download"; } static revokeObjectURL = vi.fn(); });
    expect(await downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf" })).toBe("browser-download");
    expect(clicked).toEqual(["report.pdf"]); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });
  it("waits for exact ack byte counts and native result instead of claiming a save", async () => {
    const sent = native();
    const pending = downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf" });
    await waitFor(() => expect(sent[0]?.type).toBe("file.begin"));
    expect(sent).toHaveLength(1);
    reply(sent[0], { type: "file.ack", nextIndex: 0, receivedBytes: 0 });
    await waitFor(() => expect(sent[1]?.type).toBe("file.chunk"));
    expect(sent[1]).toMatchObject({ index: 0, dataBase64: "AAAA" });
    reply(sent[0], { type: "file.ack", nextIndex: 1, receivedBytes: 3 });
    await waitFor(() => expect(sent[2]?.type).toBe("file.end"));
    reply(sent[0], { type: "file.result", status: "handoff" });
    expect(await pending).toBe("handoff");
  });
  it("rejects wrong ack counters and sends matched cancellation without browser fallback", async () => {
    const sent = native(); const pending = downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf" });
    const rejected = pending.catch(error => error);
    await waitFor(() => expect(sent[0]).toBeDefined());
    reply(sent[0], { type: "file.ack", nextIndex: 2, receivedBytes: 3 });
    expect(await rejected).toMatchObject({ code: "FILE_SEQUENCE_ERROR" }); expect(sent.at(-1)?.type).toBe("file.cancel");
  });
  it("ignores stale document/request results and returns explicit failures", async () => {
    const sent = native(); const pending = downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf" });
    const rejected = pending.catch(error => error);
    await waitFor(() => expect(sent[0]).toBeDefined());
    reply({ ...sent[0], documentId: "old-doc" }, { type: "file.result", status: "handoff" });
    reply(sent[0], { type: "file.result", status: "failed", errorCode: "FILE_SHARE_FAILED" }); expect(await rejected).toMatchObject({ code: "FILE_SHARE_FAILED" });
  });
  it("rejects over-limit files before sending and keeps a single pending export", async () => {
    const sent = native();
    await expect(downloadMobileAwareFile({ blob: pdf(20 * 1024 * 1024 + 1), fileName: "report.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(sent).toHaveLength(0);
    const pending = downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf" });
    await waitFor(() => expect(sent[0]).toBeDefined());
    await expect(downloadMobileAwareFile({ blob: pdf(), fileName: "two.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "FILE_TRANSFER_BUSY" });
    reply(sent[0], { type: "file.result", status: "cancelled" }); expect(await pending).toBe("cancelled");
  });
  it("does not fall back while a native UA is waiting for bootstrap", async () => {
    vi.stubGlobal("ReactNativeWebView", undefined);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("LEDControlNative/1");
    await expect(downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "FILE_UNSUPPORTED" });
  });
  it("never includes credentials when fetching a cross-origin signed URL", async () => {
    const sent = native();
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))); vi.stubGlobal("fetch", fetch);
    const pending = downloadMobileAwareUrl({ url: "https://files.example/report.pdf?signature=public", fileName: "report.pdf", mimeType: "application/pdf" });
    await waitFor(() => expect(sent[0]).toBeDefined());
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit" });
    reply(sent[0], { type: "file.result", status: "cancelled" }); expect(await pending).toBe("cancelled");
  });
  it("cancels on an explicit AbortSignal and releases after native cancellation", async () => {
    const sent = native(); const controller = new AbortController();
    const pending = downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf", signal: controller.signal });
    await waitFor(() => expect(sent[0]).toBeDefined()); controller.abort();
    expect(sent.at(-1)?.type).toBe("file.cancel"); reply(sent[0], { type: "file.result", status: "cancelled" });
    expect(await pending).toBe("cancelled");
  });
  it("expires a missing ack at30seconds and sends a cancellation for exactly that request", async () => {
    vi.useFakeTimers(); const sent = native();
    const result = downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf" }).catch(error => error);
    await vi.advanceTimersByTimeAsync(29_999); expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(await result).toMatchObject({ code: "FILE_TIMEOUT" });
    expect(sent.at(-1)).toMatchObject({ type: "file.cancel", documentId: "doc-file", requestId: sent[0].requestId });
  });
  it("bounds decoded chunks to64KiB and waits for each exact ack", async () => {
    const sent = native(); const pending = downloadMobileAwareFile({ blob: pdf(65_537), fileName: "report.pdf", mimeType: "application/pdf" });
    reply(sent[0], { type: "file.ack", nextIndex: 0, receivedBytes: 0 });
    await waitFor(() => expect(sent[1]?.type).toBe("file.chunk"));
    expect(atob(sent[1].dataBase64!).length).toBe(65_536); expect(sent).toHaveLength(2);
    reply(sent[0], { type: "file.ack", nextIndex: 1, receivedBytes: 65_536 });
    await waitFor(() => expect(sent[2]?.type).toBe("file.chunk")); expect(sent[2]).toMatchObject({ index: 1, dataBase64: "AA==" });
    reply(sent[0], { type: "file.ack", nextIndex: 2, receivedBytes: 65_537 });
    await waitFor(() => expect(sent[3]?.type).toBe("file.end")); reply(sent[0], { type: "file.result", status: "handoff" }); expect(await pending).toBe("handoff");
  });
  it("retains ownership while an OS sheet is open even after abort, without a false30second result", async () => {
    const sent = native(); const controller = new AbortController();
    const pending = downloadMobileAwareFile({ blob: pdf(), fileName: "report.pdf", mimeType: "application/pdf", signal: controller.signal });
    let completed = false; void pending.then(() => { completed = true; });
    reply(sent[0], { type: "file.ack", nextIndex: 0, receivedBytes: 0 }); await waitFor(() => expect(sent[1]?.type).toBe("file.chunk"));
    reply(sent[0], { type: "file.ack", nextIndex: 1, receivedBytes: 3 }); await waitFor(() => expect(sent[2]?.type).toBe("file.end"));
    vi.useFakeTimers(); controller.abort(); await vi.advanceTimersByTimeAsync(60_000); expect(completed).toBe(false);
    await expect(downloadMobileAwareFile({ blob: pdf(), fileName: "other.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "FILE_TRANSFER_BUSY" });
    reply(sent[0], { type: "file.result", status: "cancelled" }); expect(await pending).toBe("cancelled");
  });
  it("rejects declared and actual over-limit URL bodies before native begin", async () => {
    const sent = native(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    fetch.mockResolvedValueOnce(new Response("x", { headers: { "content-length": "20971521" } }));
    await expect(downloadMobileAwareUrl({ url: "/report.pdf", fileName: "report.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    fetch.mockResolvedValueOnce(new Response(new Uint8Array(20 * 1024 * 1024 + 1)));
    await expect(downloadMobileAwareUrl({ url: "/report.pdf", fileName: "report.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(sent).toHaveLength(0);
  });
  it("rejects invalid or executable URLs with a stable code before fetching", async () => {
    native();
    for (const url of ["http://[bad", "javascript:alert(1)"]) await expect(downloadMobileAwareUrl({ url, fileName: "report.pdf", mimeType: "application/pdf" })).rejects.toMatchObject({ code: "FILE_UNSUPPORTED" });
  });
  it("disallows credential-bearing redirects from authorized same-origin fetches", async () => {
    const sent = native(); const fetch = vi.fn().mockResolvedValue(new Response("pdf")); vi.stubGlobal("fetch", fetch);
    const pending = downloadMobileAwareUrl({ url: "/report.pdf", fileName: "report.pdf", mimeType: "application/pdf" });
    await waitFor(() => expect(sent[0]).toBeDefined());
    const options = fetch.mock.calls[0][1]; reply(sent[0], { type: "file.result", status: "cancelled" }); await pending;
    expect(options).toMatchObject({ credentials: "include", redirect: "error" });
  });
});
