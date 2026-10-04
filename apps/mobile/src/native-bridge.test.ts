import { NativeBridge } from './native-bridge';
import type { TemporaryFile } from './file-transfer';

function setup(share: (file: TemporaryFile, mime: string) => Promise<void> = async () => {}) {
  let bytes: number[] = []; let deleted = false;
  const file: TemporaryFile = { uri: 'file:///private/report.pdf', append(chunk) { bytes.push(...chunk); }, size() { return bytes.length; }, close() {}, remove() { deleted = true; } };
  const messages: Record<string, unknown>[] = [];
  const exit = jest.fn(); const bridge = new NativeBridge('https://control.example.com', m => messages.push(m), () => file, share, exit);
  bridge.reset('doc-one');
  const environment = bridge.bootstrap('active', true);
  const message = (type: string, requestId = 'file-one', extra = {}, documentId = 'doc-one', url = 'https://control.example.com/login') => bridge.receive(JSON.stringify({ version: 1, type, requestId, documentId, ...extra }), url);
  message('web.ready', String(environment.requestId));
  return { bridge, message, messages, exit, bytes: () => bytes, deleted: () => deleted };
}
describe('origin and document-bound bridge consumer', () => {
  afterEach(() => jest.useRealTimers());
  it('rejects hostile origins and stale document requests before writing a file', () => {
    const f = setup(); const metadata = { action: 'share', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 1 };
    f.message('file.begin', 'file-one', metadata, 'doc-old'); f.message('file.begin', 'file-one', metadata, 'doc-one', 'https://evil.example.com');
    expect(f.messages).toHaveLength(0); expect(f.bytes()).toEqual([]);
  });
  it('acknowledges each successfully persisted chunk and emits handoff after OS return', async () => {
    const f = setup();
    f.message('file.begin', 'file-one', { action: 'save', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 4 });
    expect(f.messages.at(-1)).toMatchObject({ type: 'file.ack', nextIndex: 0, receivedBytes: 0 });
    f.message('file.chunk', 'file-one', { index: 0, dataBase64: 'JVBERg==' });
    expect(f.bytes()).toEqual([37,80,68,70]); expect(f.messages.at(-1)).toMatchObject({ nextIndex: 1, receivedBytes: 4 });
    await f.message('file.end', 'file-one', { chunkCount: 1 });
    expect(f.messages.at(-1)).toMatchObject({ type: 'file.result', status: 'handoff' }); expect(f.deleted()).toBe(true);
  });
  it('cleans matched protocol errors and reports stable codes without raw native details', async () => {
    const f = setup();
    f.message('file.begin', 'file-one', { action: 'share', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 4 });
    f.message('file.chunk', 'file-one', { index: 1, dataBase64: 'JVBERg==' });
    expect(f.deleted()).toBe(true); expect(f.messages.at(-1)).toMatchObject({ type: 'file.result', status: 'failed', errorCode: 'FILE_SEQUENCE_ERROR' });
  });
  it('releases inactivity partial files and reports timeout to that document', () => {
    jest.useFakeTimers(); const f = setup();
    f.message('file.begin', 'file-one', { action: 'share', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 4 });
    jest.advanceTimersByTime(30000); expect(f.deleted()).toBe(true); expect(f.messages.at(-1)).toMatchObject({ status: 'failed', errorCode: 'FILE_TIMEOUT' });
  });
  it('invalidates OS results after reset and keeps one OS sheet in flight', async () => {
    let finish!: () => void; const f = setup(() => new Promise<void>(r => { finish = r; }));
    f.message('file.begin', 'file-one', { action: 'share', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 4 }); f.message('file.chunk', 'file-one', { index: 0, dataBase64: 'JVBERg==' });
    const pending = f.message('file.end', 'file-one', { chunkCount: 1 });
    f.bridge.reset('doc-two'); finish(); await pending;
    expect(f.messages.filter(m => m.type === 'file.result')).toHaveLength(0); expect(f.deleted()).toBe(true);
  });
  it('does not emit a second success after a matched protocol failure under an OS sheet', async () => {
    let finish!: () => void; const f = setup(() => new Promise<void>(r => { finish = r; }));
    f.message('file.begin', 'file-one', { action: 'share', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 4 }); f.message('file.chunk', 'file-one', { index: 0, dataBase64: 'JVBERg==' });
    const pending = f.message('file.end', 'file-one', { chunkCount: 1 });
    f.message('file.end', 'file-one', { chunkCount: 1 }); finish(); await pending;
    expect(f.messages.filter(m => m.type === 'file.result')).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'FILE_SEQUENCE_ERROR' })]); expect(f.deleted()).toBe(true);
  });
  it('keeps cancelled OS sharing ownership until normal return and does not apply upload timeout to a sheet', async () => {
    jest.useFakeTimers(); let finish!: () => void; const f = setup(() => new Promise<void>(r => { finish = r; }));
    const metadata = { action: 'share', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 4 };
    f.message('file.begin', 'file-one', metadata); f.message('file.chunk', 'file-one', { index: 0, dataBase64: 'JVBERg==' }); const pending = f.message('file.end', 'file-one', { chunkCount: 1 });
    jest.advanceTimersByTime(60000); expect(f.deleted()).toBe(false);
    f.message('file.cancel'); f.message('file.begin', 'second', metadata);
    expect(f.messages.at(-1)).toMatchObject({ requestId: 'second', status: 'failed', errorCode: 'FILE_TRANSFER_BUSY' });
    finish(); await pending; expect(f.messages.at(-1)).toMatchObject({ requestId: 'file-one', status: 'cancelled' }); expect(f.deleted()).toBe(true);
  });
  it.each([
    JSON.stringify({ version: 1, type: 'file.chunk', documentId: 'doc-old', requestId: 'old-file', index: 0, dataBase64: '!!!!' }),
    JSON.stringify({ version: 1, type: 'file.chunk', documentId: 'doc-one', requestId: 'different-file', index: 0, dataBase64: '!!!!' }),
    '{broken JSON',
    'x'.repeat(98305)
  ])('does not abort an active file for uncorrelated malformed input case', async raw => {
    const f = setup();
    f.message('file.begin', 'file-one', { action: 'share', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 4 });
    f.bridge.receive(raw, 'https://control.example.com/login'); expect(f.deleted()).toBe(false);
    f.message('file.chunk', 'file-one', { index: 0, dataBase64: 'JVBERg==' }); await f.message('file.end', 'file-one', { chunkCount: 1 });
    expect(f.messages.at(-1)).toMatchObject({ status: 'handoff' });
  });
  it('cleans invalid input only when its independently valid envelope matches the active owner', () => {
    const f = setup(); f.message('file.begin', 'file-one', { action: 'share', fileName: 'report.pdf', mimeType: 'application/pdf', byteLength: 4 });
    f.message('file.chunk', 'file-one', { index: 0, dataBase64: 'JVBERg==', forbiddenURL: 'https://evil.example.com' });
    expect(f.deleted()).toBe(true); expect(f.messages.at(-1)).toMatchObject({ status: 'failed', errorCode: 'FILE_INVALID_MESSAGE' });
  });
  it('exits only after a ready document acknowledges the pending Android back request', () => {
    const f = setup(); f.bridge.back(); const request = f.messages.at(-1)!;
    expect(request.type).toBe('navigation.back'); expect(f.exit).not.toHaveBeenCalled();
    f.message('navigation.back.result', String(request.requestId), { handled: false, canGoBack: false }); expect(f.exit).toHaveBeenCalledTimes(1);
  });
});
