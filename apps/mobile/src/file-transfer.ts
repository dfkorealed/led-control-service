import { MOBILE_FILE_MAX_BYTES, MOBILE_FILE_MAX_CHUNK_BYTES, MOBILE_FILE_INACTIVITY_TIMEOUT_MS } from '@led-control/shared/mobile-webview-contracts';
export interface TemporaryFile { uri: string; append(bytes: Uint8Array): void; close(): void; remove(): void; size(): number; }
export class TransferFailure extends Error {}
export function assertPrivateFileName(name: string): void {
  if (!name || name.length > 160 || /[\\/\x00-\x1f\x7f]/.test(name) || name.includes('..')) throw new TransferFailure('invalid-file-name');
}
type Session = { id: string; file: TemporaryFile; mime: string; expected: number; written: number; next: number; sharing: boolean; cancelled: boolean; timer?: ReturnType<typeof setTimeout> };

export class FileTransfer {
  onTimeout?: (id: string) => void;
  private session?: Session;
  constructor(private create: (name: string) => TemporaryFile, private share: (file: TemporaryFile, mime: string) => Promise<void>) {}
  start(id: string, name: string, mime: string, size: number): void {
    if (this.session) throw new TransferFailure('busy');
    assertPrivateFileName(name);
    if (!['application/pdf', 'text/csv'].includes(mime) || !Number.isSafeInteger(size) || size < 1 || size > MOBILE_FILE_MAX_BYTES) throw new TransferFailure('invalid-file');
    const file = this.create(name);
    this.session = { id, file, mime, expected: size, written: 0, next: 0, sharing: false, cancelled: false };
    this.touch(this.session);
  }
  chunk(id: string, index: number, bytes: Uint8Array): void {
    const s = this.require(id);
    if (s.sharing || index !== s.next || !bytes.length || bytes.length > MOBILE_FILE_MAX_CHUNK_BYTES || s.written + bytes.length > s.expected) { this.cancel(); throw new TransferFailure('invalid-chunk'); }
    try { s.file.append(bytes); s.written += bytes.length; s.next++; this.touch(s); }
    catch { this.cancel(); throw new TransferFailure('write-failed'); }
  }
  async finish(id: string): Promise<'handoff' | 'cancelled'> {
    const s = this.require(id);
    if (s.sharing || s.written !== s.expected || s.file.size() !== s.expected) { this.cancel(); throw new TransferFailure('size-mismatch'); }
    clearTimeout(s.timer); s.sharing = true;
    try {
      s.file.close(); await this.share(s.file, s.mime);
      // Expo cannot identify a share sheet's save/selection versus OS dismissal.
      return s.cancelled ? 'cancelled' : 'handoff';
    } finally { this.cleanup(s); }
  }
  cancel(): void {
    const s = this.session; if (!s) return;
    s.cancelled = true; clearTimeout(s.timer);
    // Removing a file while an OS share sheet still reads it can corrupt the handoff.
    // Suppress responses immediately, but release that file only after the sheet closes.
    if (!s.sharing) this.cleanup(s);
  }
  private require(id: string): Session {
    if (!this.session || this.session.id !== id || this.session.cancelled) throw new TransferFailure('stale-transfer');
    return this.session;
  }
  private touch(s: Session): void {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      try { this.cancel(); } catch { /* The request still reports failure; abandoned cache is retried at cold start. */ }
      this.onTimeout?.(s.id);
    }, MOBILE_FILE_INACTIVITY_TIMEOUT_MS);
  }
  private cleanup(s: Session): void {
    clearTimeout(s.timer);
    try { s.file.close(); } finally { try { s.file.remove(); } finally { if (this.session === s) this.session = undefined; } }
  }
}
