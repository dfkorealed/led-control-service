import { describe, expect, it } from "vitest";
import {
  mobileToWebMessageSchema, webToMobileMessageSchema, parseMobileBridgeMessage,
  MobileFileTransferGuard
} from "./mobile-webview-contracts";

const envelope = { version: 1, documentId: "document-1", requestId: "request-1" };
const begin = { ...envelope, type: "file.begin", action: "save", fileName: "현장 보고서.pdf", mimeType: "application/pdf", byteLength: 2 };
const chunk = { ...envelope, type: "file.chunk", index: 0, dataBase64: "AQI=" };
const end = { ...envelope, type: "file.end", chunkCount: 1 };

describe("mobile WebView v1 boundaries", () => {
  it("accepts the complete native bootstrap and web ready handshake", () => {
    expect(mobileToWebMessageSchema.parse({ ...envelope, type: "mobile.bootstrap", mobile: true, state: "active", online: false })).toEqual({ ...envelope, type: "mobile.bootstrap", mobile: true, state: "active", online: false });
    expect(webToMobileMessageSchema.parse({ ...envelope, type: "web.ready" }).type).toBe("web.ready");
  });

  it.each([
    { ...envelope, type: "mobile.bootstrap", mobile: true, state: "active" },
    { ...envelope, type: "mobile.bootstrap", mobile: false, state: "active", online: true },
    { ...envelope, version: 2, type: "mobile.lifecycle", state: "active", online: true },
    { ...envelope, type: "mobile.lifecycle", state: "unknown", online: true },
    { ...envelope, type: "navigation.back", password: "secret" },
    { ...envelope, documentId: "", type: "navigation.back" },
    { ...envelope, requestId: "x".repeat(65), type: "navigation.back" },
    { ...envelope, requestId: "../route", type: "navigation.back" }
  ])("rejects incomplete, unknown or privileged native payload %#", (value) => {
    expect(mobileToWebMessageSchema.safeParse(value).success).toBe(false);
  });

  it("does not accept messages travelling in the wrong direction", () => {
    expect(mobileToWebMessageSchema.safeParse({ ...envelope, type: "web.ready" }).success).toBe(false);
    expect(webToMobileMessageSchema.safeParse({ ...envelope, type: "navigation.back" }).success).toBe(false);
  });

  it("requires a correlated explicit back outcome, without native navigation URLs", () => {
    expect(webToMobileMessageSchema.parse({ ...envelope, type: "navigation.back.result", handled: true, canGoBack: false }).type).toBe("navigation.back.result");
    expect(webToMobileMessageSchema.safeParse({ ...envelope, type: "navigation.back.result", handled: true }).success).toBe(false);
    expect(webToMobileMessageSchema.safeParse({ ...envelope, type: "navigate", url: "https://evil.example" }).success).toBe(false);
  });

  it.each(["../report.pdf", "dir/report.pdf", "dir\\report.pdf", "report\n.pdf", ".hidden.pdf", "report.xlsx", "report.pdf:stream"])("rejects unsafe or non-PDF file names: %s", (fileName) => {
    expect(webToMobileMessageSchema.safeParse({ ...begin, fileName }).success).toBe(false);
  });

  it("bounds declared files to 20 MiB without accepting zero, URL fetch or cookie fields", () => {
    expect(webToMobileMessageSchema.safeParse({ ...begin, byteLength: 20 * 1024 * 1024 }).success).toBe(true);
    for (const value of [{ ...begin, byteLength: 0 }, { ...begin, byteLength: 20 * 1024 * 1024 + 1 }, { ...begin, url: "https://evil.example" }, { ...begin, cookie: "secret" }, { ...begin, mimeType: "application/vnd.ms-excel" }]) {
      expect(webToMobileMessageSchema.safeParse(value).success).toBe(false);
    }
  });

  it("counts actual decoded bytes and rejects invalid and noncanonical base64", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin(begin, 0);
    expect(guard.chunk(chunk, 1)).toMatchObject({ receivedBytes: 2, nextIndex: 1 });
    for (const dataBase64 of ["", "AQI", "!!!!", "AQI=\n", "AR==", "AQJ="]) {
      expect(webToMobileMessageSchema.safeParse({ ...chunk, dataBase64 }).success).toBe(false);
    }
  });

  it("accepts a 64 KiB decoded chunk and rejects the next byte", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin({ ...begin, byteLength: 65536 }, 0);
    expect(guard.chunk({ ...chunk, dataBase64: "AAAA".repeat(21845) + "AA==" }, 1).receivedBytes).toBe(65536);
    expect(webToMobileMessageSchema.safeParse({ ...chunk, dataBase64: "AAAA".repeat(21845) + "AAA=" }).success).toBe(false);
  });

  it("rejects out-of-order, duplicate, wrong request and abandoned document chunks", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin(begin, 0);
    for (const value of [{ ...chunk, index: 1 }, { ...chunk, requestId: "other" }, { ...chunk, documentId: "old-document" }]) {
      expect(() => guard.chunk(value, 1)).toThrow();
    }
    guard.chunk(chunk, 2);
    expect(() => guard.chunk(chunk, 3)).toThrow();
  });

  it("rejects declared-size overflow and premature or mismatched completion", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin(begin, 0);
    expect(() => guard.end(end, 1)).toThrow();
    expect(() => guard.chunk({ ...chunk, dataBase64: "AQID" }, 1)).toThrow();
    guard.chunk(chunk, 2);
    expect(() => guard.end({ ...end, chunkCount: 2 }, 3)).toThrow();
    expect(guard.end(end, 4)).toMatchObject({ completed: true, receivedBytes: 2 });
  });

  it("keeps one transfer busy until the native save/share result releases ownership", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin(begin, 0);
    expect(() => guard.begin({ ...begin, requestId: "second" }, 1)).toThrow();
    guard.chunk(chunk, 2);
    guard.end(end, 3);
    expect(() => guard.begin({ ...begin, requestId: "second" }, 4)).toThrow();
    expect(() => guard.release("old-document", "request-1")).toThrow();
    guard.release("document-1", "request-1");
    expect(guard.begin({ ...begin, action: "share", requestId: "second" }, 5).action).toBe("share");
  });

  it("expires incomplete transfers at 30 seconds of inactivity, not from total start time", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin({ ...begin, byteLength: 4 }, 0);
    guard.chunk(chunk, 29999);
    expect(guard.expire(59998)).toBeNull();
    expect(guard.expire(59999)).toMatchObject({ receivedBytes: 2 });
    expect(() => guard.chunk({ ...chunk, index: 1 }, 60000)).toThrow();
    expect(guard.begin(begin, 60001).receivedBytes).toBe(0);
  });

  it("rejects chunks at the deadline and resets only a matched cancellation", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin(begin, 0);
    expect(() => guard.chunk(chunk, 30000)).toThrow();
    guard.begin(begin, 30001);
    expect(() => guard.cancel({ ...envelope, type: "file.cancel", requestId: "other" })).toThrow();
    expect(guard.cancel({ ...envelope, type: "file.cancel" }).requestId).toBe("request-1");
    expect(guard.begin(begin, 30002).nextIndex).toBe(0);
  });

  it("reports only stable file outcomes and bounded acknowledgement progress", () => {
    for (const status of ["handoff", "cancelled"]) expect(mobileToWebMessageSchema.safeParse({ ...envelope, type: "file.result", status }).success).toBe(true);
    expect(mobileToWebMessageSchema.safeParse({ ...envelope, type: "file.result", status: "failed", errorCode: "FILE_WRITE_FAILED" }).success).toBe(true);
    for (const value of [{ ...envelope, type: "file.result", status: "failed" }, { ...envelope, type: "file.result", status: "handoff", errorCode: "FILE_WRITE_FAILED" }, { ...envelope, type: "file.result", status: "failed", errorCode: "exception stack" }, { ...envelope, type: "file.result", status: "saved" }, { ...envelope, type: "file.result", status: "shared" }, { ...envelope, type: "file.result", status: "handoff", path: "/private/file.pdf" }, { ...envelope, type: "file.ack", nextIndex: -1, receivedBytes: 0 }]) expect(mobileToWebMessageSchema.safeParse(value).success).toBe(false);
    expect(mobileToWebMessageSchema.safeParse({ ...envelope, type: "file.ack", nextIndex: 1, receivedBytes: 2 }).success).toBe(true);
  });

  it("checks raw character and UTF-8 byte limits before parsing JSON", () => {
    expect(parseMobileBridgeMessage(JSON.stringify({ ...envelope, type: "web.ready" }), "web-to-mobile").type).toBe("web.ready");
    expect(() => parseMobileBridgeMessage(" ".repeat(98305), "web-to-mobile")).toThrow();
    expect(() => parseMobileBridgeMessage(JSON.stringify({ x: "가".repeat(33000) }), "web-to-mobile")).toThrow(/size/i);
    expect(() => parseMobileBridgeMessage("{}", "web-to-mobile")).toThrow();
    expect(() => parseMobileBridgeMessage("{broken", "mobile-to-web")).toThrow();
  });

  it("preserves CSV separately from PDF and requires a matching MIME and extension", () => {
    const csv = { ...begin, fileName: "일별 전력.csv", mimeType: "text/csv" };
    expect(webToMobileMessageSchema.safeParse(csv).success).toBe(true);
    expect(webToMobileMessageSchema.safeParse({ ...csv, fileName: "report.pdf" }).success).toBe(false);
    expect(webToMobileMessageSchema.safeParse({ ...begin, fileName: "report.csv" }).success).toBe(false);
  });

  it("does not let callers mutate stored progress or revive a file with a backwards clock", () => {
    const guard = new MobileFileTransferGuard();
    const exposed = guard.begin(begin, 10);
    exposed.nextIndex = 7;
    expect(() => guard.chunk(chunk, 9)).toThrow();
    expect(guard.chunk(chunk, 11).nextIndex).toBe(1);
    expect(() => guard.expire(Number.NaN)).toThrow();
  });

  it("does not time out a completed file while the OS save/share sheet is open", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin(begin, 0);
    guard.chunk(chunk, 1);
    guard.end(end, 2);
    expect(guard.expire(30002)).toBeNull();
    expect(() => guard.begin({ ...begin, requestId: "second" }, 30003)).toThrow();
    expect(() => guard.chunk({ ...chunk, index: 1 }, 30003)).toThrow();
    guard.release("document-1", "request-1");
  });

  it("retains one-file ownership when an explicit cancel arrives while the OS sheet is open", () => {
    const guard = new MobileFileTransferGuard();
    guard.begin(begin, 0);
    guard.chunk(chunk, 1);
    guard.end(end, 2);
    expect(guard.cancel({ ...envelope, type: "file.cancel" }).cancelled).toBe(true);
    expect(() => guard.begin({ ...begin, requestId: "second" }, 3)).toThrow();
    guard.release("document-1", "request-1");
    expect(guard.begin({ ...begin, requestId: "second" }, 4).requestId).toBe("second");
  });
});
