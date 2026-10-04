import {
  MobileFileTransferGuard, MobileFileTransferError, parseMobileBridgeMessage, MOBILE_BRIDGE_MAX_MESSAGE_BYTES,
  type MobileAppState, type MobileBootstrapMessage, type MobileToWebMessage,
  type WebToMobileMessage, type MobileFileErrorCode
} from '@led-control/shared/mobile-webview-contracts';
import { BackNavigation } from './back-navigation';
import { decodeChunk } from './base64';
import { FileTransfer, TransferFailure, type TemporaryFile } from './file-transfer';
import { navigationDecision } from './runtime';

type FileContext = { documentId: string; requestId: string; sharing: boolean; failed?: boolean };
const bootstrapRequestId = 'native-bootstrap';

export class NativeBridge {
  private documentId = '';
  private ready = false;
  private guard = new MobileFileTransferGuard();
  private fileContext?: FileContext;
  private files: FileTransfer;
  private backNavigation: BackNavigation;
  onBackTimeout?: () => void;
  constructor(private origin: string, private send: (message: MobileToWebMessage) => void, create: (name: string) => TemporaryFile, share: (file: TemporaryFile, mime: string) => Promise<void>, exit: () => void) {
    this.files = new FileTransfer(create, share);
    this.files.onTimeout = id => {
      const context = this.fileContext;
      if (!context || context.requestId !== id) return;
      this.release(context); this.fileContext = undefined;
      this.result(context, 'failed', 'FILE_TIMEOUT');
    };
    this.backNavigation = new BackNavigation(request => this.send({ version: 1, type: 'navigation.back', ...request }), exit);
    this.backNavigation.onTimeout = () => this.onBackTimeout?.();
  }
  reset(documentId: string): void {
    this.ready = false; this.backNavigation.reset();
    this.cancelFiles(); this.fileContext = undefined;
    this.guard = new MobileFileTransferGuard(); this.documentId = documentId;
  }
  bootstrap(state: string, online: boolean): MobileBootstrapMessage {
    return { version: 1, type: 'mobile.bootstrap', documentId: this.documentId, requestId: bootstrapRequestId, mobile: true, state: normalizeState(state), online };
  }
  lifecycle(state: string, online: boolean): void {
    if (this.ready) this.send({ version: 1, type: 'mobile.lifecycle', documentId: this.documentId, requestId: 'native-lifecycle', state: normalizeState(state), online });
  }
  back(): void { if (this.ready) this.backNavigation.request(); }
  receive(raw: string, url: string): void | Promise<void> {
    if (navigationDecision(url, this.origin) !== 'internal') return;
    let message: WebToMobileMessage;
    try { message = parseMobileBridgeMessage(raw, 'web-to-mobile'); }
    catch {
      // No raw payload, URL, path or OS exception is exposed to the web or user.
      const active = this.fileContext;
      if (active && malformedInputBelongsTo(raw, active)) {
        if (!active.sharing) this.failFile(active, 'FILE_INVALID_MESSAGE');
        else if (!active.failed) { active.failed = true; this.cancelFiles(); this.result(active, 'failed', 'FILE_INVALID_MESSAGE'); }
      }
      return;
    }
    if (message.documentId !== this.documentId) return;
    if (message.type === 'web.ready') {
      if (message.requestId === bootstrapRequestId) { this.ready = true; this.backNavigation.bind(this.documentId); }
      return;
    }
    if (!this.ready) return;
    if (message.type === 'navigation.back.result') { this.backNavigation.result(message); return; }
    const context: FileContext = { documentId: message.documentId, requestId: message.requestId, sharing: false };
    try {
      if (message.type === 'file.begin') {
        const state = this.guard.begin(message, performance.now());
        try { this.files.start(message.requestId, message.fileName, message.mimeType, message.byteLength); }
        catch (error) { this.release(context); throw error; }
        this.fileContext = context;
        this.send({ version: 1, type: 'file.ack', documentId: message.documentId, requestId: message.requestId, nextIndex: state.nextIndex, receivedBytes: state.receivedBytes });
      } else if (message.type === 'file.chunk') {
        const state = this.guard.chunk(message, performance.now());
        // Expo FileHandle.writeBytes is synchronous. No await permits another
        // onMessage callback to advance an offset/end while this write is pending.
        this.files.chunk(message.requestId, message.index, decodeChunk(message.dataBase64));
        this.send({ version: 1, type: 'file.ack', documentId: message.documentId, requestId: message.requestId, nextIndex: state.nextIndex, receivedBytes: state.receivedBytes });
      } else if (message.type === 'file.end') {
        this.guard.end(message, performance.now());
        const active = this.fileContext!; active.sharing = true;
        const guard = this.guard;
        return this.finishFile(active, guard);
      } else if (message.type === 'file.cancel') {
        const state = this.guard.cancel(message);
        this.cancelFiles();
        if (!state.completed) { this.fileContext = undefined; this.result(context, 'cancelled'); }
        // An active OS sheet retains the engine/guard slot until its API returns.
      }
    } catch (error) {
      const code: MobileFileErrorCode = error instanceof MobileFileTransferError ? error.code : error instanceof TransferFailure && error.message === 'busy' ? 'FILE_TRANSFER_BUSY' : 'FILE_WRITE_FAILED';
      if (this.fileContext?.requestId === context.requestId) {
        if (!this.fileContext.sharing) this.failFile(context, code);
        else if (!this.fileContext.failed) {
          this.fileContext.failed = true; this.cancelFiles();
          this.result(context, 'failed', code);
        }
      } else this.result(context, 'failed', code);
    }
  }
  private async finishFile(context: FileContext, guard: MobileFileTransferGuard): Promise<void> {
    try {
      const status = await this.files.finish(context.requestId);
      if (!context.failed) this.result(context, status);
    } catch { if (!context.failed) this.result(context, 'failed', 'FILE_SHARE_FAILED'); }
    finally {
      try { guard.release(context.documentId, context.requestId); } catch { /* Cancel/reset may have already released the metadata owner. */ }
      if (this.fileContext === context) this.fileContext = undefined;
    }
  }
  private result(context: FileContext, status: 'handoff' | 'cancelled' | 'failed', errorCode?: MobileFileErrorCode): void {
    if (!this.ready || context.documentId !== this.documentId) return;
    this.send({ version: 1, type: 'file.result', documentId: context.documentId, requestId: context.requestId, status, ...(status === 'failed' ? { errorCode: errorCode! } : {}) });
  }
  private failFile(context: FileContext, code: MobileFileErrorCode): void {
    this.cancelFiles(); this.release(context); this.fileContext = undefined; this.result(context, 'failed', code);
  }
  private cancelFiles(): void {
    try { this.files.cancel(); } catch { /* Retry abandoned-cache cleanup on the next cold start; never crash a navigation handler. */ }
  }
  private release(context: FileContext): void {
    try { this.guard.release(context.documentId, context.requestId); } catch { /* Timeout/cancel may already have released ownership. */ }
  }
}
function normalizeState(state: string): MobileAppState { return state === 'active' || state === 'background' ? state : 'inactive'; }

/** Correlation only: this never authorizes a write or accepts unknown fields.
 * A stale/foreign/unparseable envelope has no right to cancel the current owner.
 */
function malformedInputBelongsTo(raw: unknown, owner: FileContext): boolean {
  if (typeof raw !== 'string' || raw.length > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) return false;
  let bytes = 0;
  for (const character of raw) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > MOBILE_BRIDGE_MAX_MESSAGE_BYTES) return false;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const envelope = value as Record<string, unknown>;
    return envelope.version === 1 &&
      typeof envelope.type === 'string' && ['file.begin', 'file.chunk', 'file.end', 'file.cancel'].includes(envelope.type) &&
      envelope.documentId === owner.documentId && envelope.requestId === owner.requestId;
  } catch { return false; }
}
