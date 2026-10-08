import { z } from "zod";

export const MOBILE_BRIDGE_VERSION = 1;
export const MOBILE_BRIDGE_MAX_MESSAGE_BYTES = 96 * 1024;
export const MOBILE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const MOBILE_FILE_MAX_CHUNK_BYTES = 64 * 1024;
export const MOBILE_FILE_INACTIVITY_TIMEOUT_MS = 30_000;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const envelope = { version: z.literal(1), documentId: id, requestId: id };
export const mobileAppStateSchema = z.enum(["active", "background", "inactive"]);
export const mobileFileErrorCodeSchema = z.enum([
  "FILE_TRANSFER_BUSY", "FILE_TIMEOUT", "FILE_WRITE_FAILED", "FILE_SHARE_FAILED",
  "FILE_INVALID_MESSAGE", "FILE_TOO_LARGE", "FILE_SEQUENCE_ERROR",
  "FILE_DOCUMENT_CHANGED", "FILE_UNSUPPORTED"
]);
export type MobileFileErrorCode = z.infer<typeof mobileFileErrorCodeSchema>;
export type MobileAppState = z.infer<typeof mobileAppStateSchema>;

const fileName = z.string().min(1).max(128).refine((value) =>
  value.trim() === value && !value.startsWith(".") &&
  !/[\\/:\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value),
"File name must be a safe basename");
const fileBegin = z.object({
  ...envelope, type: z.literal("file.begin"), action: z.enum(["save", "share"]),
  fileName, mimeType: z.enum(["application/pdf", "text/csv"]),
  byteLength: z.number().int().min(1).max(MOBILE_FILE_MAX_BYTES)
}).strict();
function validateFileFormat(value: z.infer<typeof fileBegin>, context: z.RefinementCtx) {
  const extension = value.mimeType === "application/pdf" ? ".pdf" : ".csv";
  if (!value.fileName.toLowerCase().endsWith(extension)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "File extension must match MIME type", path: ["fileName"] });
  }
}
export const mobileFileBeginSchema = fileBegin.superRefine(validateFileFormat);

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodedByteLength(value: string) {
  return value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}
const base64Chunk = z.string().min(4).max(Math.ceil(MOBILE_FILE_MAX_CHUNK_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .refine((value) => {
    // Reject nonzero padding bits: multiple base64 strings must not alias the same bytes.
    if (value.endsWith("==") && (base64Alphabet.indexOf(value.at(-3)!) & 15) !== 0) return false;
    if (value.endsWith("=") && !value.endsWith("==") && (base64Alphabet.indexOf(value.at(-2)!) & 3) !== 0) return false;
    return decodedByteLength(value) <= MOBILE_FILE_MAX_CHUNK_BYTES;
  }, "Chunk must be canonical base64 for at most 64 KiB");
export const mobileFileChunkSchema = z.object({
  ...envelope, type: z.literal("file.chunk"),
  index: z.number().int().min(0).max(MOBILE_FILE_MAX_BYTES - 1), dataBase64: base64Chunk
}).strict();
export const mobileFileEndSchema = z.object({
  ...envelope, type: z.literal("file.end"), chunkCount: z.number().int().min(1).max(MOBILE_FILE_MAX_BYTES)
}).strict();
export const mobileFileCancelSchema = z.object({ ...envelope, type: z.literal("file.cancel") }).strict();

export const webToMobileMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("web.ready") }).strict(),
  z.object({ ...envelope, type: z.literal("navigation.back.result"), handled: z.boolean(), canGoBack: z.boolean() }).strict(),
  fileBegin, mobileFileChunkSchema, mobileFileEndSchema, mobileFileCancelSchema
]).superRefine((value, context) => {
  if (value.type === "file.begin") validateFileFormat(value, context);
});

export const mobileToWebMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("mobile.bootstrap"), mobile: z.literal(true), state: mobileAppStateSchema, online: z.boolean() }).strict(),
  z.object({ ...envelope, type: z.literal("mobile.lifecycle"), state: mobileAppStateSchema, online: z.boolean() }).strict(),
  z.object({ ...envelope, type: z.literal("navigation.back") }).strict(),
  z.object({ ...envelope, type: z.literal("file.ack"), nextIndex: z.number().int().min(0).max(MOBILE_FILE_MAX_BYTES), receivedBytes: z.number().int().min(0).max(MOBILE_FILE_MAX_BYTES) }).strict(),
  z.object({ ...envelope, type: z.literal("file.result"), status: z.enum(["handoff", "cancelled", "failed"]), errorCode: mobileFileErrorCodeSchema.optional() }).strict()
]).superRefine((value, context) => {
  // Expo shareAsync cannot attest a completed save/share or infer user cancellation.
  // handoff = the OS API returned normally; cancelled = an explicit file.cancel only.
  if (value.type === "file.result" && ((value.status === "failed") !== (value.errorCode !== undefined))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only failed results require an error code", path: ["errorCode"] });
  }
});

export type WebToMobileMessage = z.infer<typeof webToMobileMessageSchema>;
export type MobileToWebMessage = z.infer<typeof mobileToWebMessageSchema>;
export type MobileFileBeginMessage = z.infer<typeof mobileFileBeginSchema>;
export type MobileFileChunkMessage = z.infer<typeof mobileFileChunkSchema>;
export type MobileFileResultMessage = Extract<MobileToWebMessage, { type: "file.result" }>;
export type MobileBootstrapMessage = Extract<MobileToWebMessage, { type: "mobile.bootstrap" }>;
export type MobileBridgeDirection = "mobile-to-web" | "web-to-mobile";

export function parseMobileBridgeMessage(raw: unknown, direction: "mobile-to-web"): MobileToWebMessage;
export function parseMobileBridgeMessage(raw: unknown, direction: "web-to-mobile"): WebToMobileMessage;
export function parseMobileBridgeMessage(raw: unknown, direction: MobileBridgeDirection): MobileToWebMessage | WebToMobileMessage;
export function parseMobileBridgeMessage(raw: unknown, direction: MobileBridgeDirection) {
  // Check raw size before JSON.parse and without Node Buffer or a Hermes TextEncoder dependency.
  if (typeof raw !== "string" || raw.length > MOBILE_BRIDGE_MAX_MESSAGE_BYTES || utf8ByteLength(raw) > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) {
    throw new Error("Mobile bridge message size exceeds the allowed limit");
  }
  const value: unknown = JSON.parse(raw);
  if (direction === "mobile-to-web") return mobileToWebMessageSchema.parse(value);
  if (direction === "web-to-mobile") return webToMobileMessageSchema.parse(value);
  throw new Error("Unknown mobile bridge direction");
}

function utf8ByteLength(value: string) {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) break;
  }
  return bytes;
}

export function getMobileFileChunkByteLength(dataBase64: string): number {
  return decodedByteLength(base64Chunk.parse(dataBase64));
}

export interface MobileFileTransferState extends MobileFileBeginMessage {
  receivedBytes: number;
  nextIndex: number;
  updatedAtMs: number;
  completed: boolean;
  cancelled: boolean;
}

export class MobileFileTransferError extends Error {
  constructor(public readonly code: MobileFileErrorCode) {
    super(code);
    this.name = "MobileFileTransferError";
  }
}

/** Metadata only. The native adapter owns temp bytes, origin checks, timers and cleanup.
 * Use one guard per WebView, not per request. nowMs must be a monotonic clock.
 * Failed validation never authorizes writing bytes. The adapter must release and
 * delete its partial file on a matched protocol failure or document change.
 */
export class MobileFileTransferGuard {
  private state: MobileFileTransferState | null = null;

  begin(message: unknown, nowMs: number): MobileFileTransferState {
    const value = mobileFileBeginSchema.parse(message);
    this.checkClock(nowMs);
    if (this.state) throw new MobileFileTransferError("FILE_TRANSFER_BUSY");
    this.state = { ...value, receivedBytes: 0, nextIndex: 0, updatedAtMs: nowMs, completed: false, cancelled: false };
    return { ...this.state };
  }

  chunk(message: unknown, nowMs: number): MobileFileTransferState {
    const value = mobileFileChunkSchema.parse(message);
    const state = this.active(value, nowMs);
    if (state.completed || value.index !== state.nextIndex) throw new MobileFileTransferError("FILE_SEQUENCE_ERROR");
    const receivedBytes = state.receivedBytes + decodedByteLength(value.dataBase64);
    if (receivedBytes > state.byteLength) throw new MobileFileTransferError("FILE_TOO_LARGE");
    this.state = { ...state, receivedBytes, nextIndex: state.nextIndex + 1, updatedAtMs: nowMs };
    return { ...this.state };
  }

  end(message: unknown, nowMs: number): MobileFileTransferState {
    const value = mobileFileEndSchema.parse(message);
    const state = this.active(value, nowMs);
    if (state.completed || state.receivedBytes !== state.byteLength || value.chunkCount !== state.nextIndex) {
      throw new MobileFileTransferError("FILE_SEQUENCE_ERROR");
    }
    this.state = { ...state, completed: true, updatedAtMs: nowMs };
    return { ...this.state };
  }

  cancel(message: unknown): MobileFileTransferState {
    const value = mobileFileCancelSchema.parse(message);
    const state = this.match(value.documentId, value.requestId);
    // A cancel cannot close Expo's OS sheet. Retain ownership until that API returns,
    // then release; otherwise a second export could start under the first sheet.
    if (state.completed) this.state = { ...state, cancelled: true };
    else this.state = null;
    return { ...state, cancelled: true };
  }

  release(documentId: string, requestId: string): void {
    this.match(documentId, requestId);
    this.state = null;
  }

  /** Native timer must delete the returned transfer's partial bytes and emit FILE_TIMEOUT. */
  expire(nowMs: number): MobileFileTransferState | null {
    this.checkClock(nowMs);
    const state = this.state;
    if (!state || state.completed || nowMs - state.updatedAtMs < MOBILE_FILE_INACTIVITY_TIMEOUT_MS) return null;
    this.state = null;
    return { ...state };
  }

  private checkClock(nowMs: number) {
    if (!Number.isFinite(nowMs) || nowMs < 0 || (this.state && nowMs < this.state.updatedAtMs)) {
      throw new MobileFileTransferError("FILE_INVALID_MESSAGE");
    }
  }

  private match(documentId: string, requestId: string): MobileFileTransferState {
    const state = this.state;
    if (!state || state.documentId !== documentId || state.requestId !== requestId) {
      throw new MobileFileTransferError("FILE_DOCUMENT_CHANGED");
    }
    return state;
  }

  private active(value: { documentId: string; requestId: string }, nowMs: number) {
    const state = this.match(value.documentId, value.requestId);
    if (this.expire(nowMs)) throw new MobileFileTransferError("FILE_TIMEOUT");
    return state;
  }
}
