import { FileTransfer, TemporaryFile, TransferFailure } from './file-transfer';

function memoryFile() {
  let data: number[] = []; let deleted = false; let closed = false;
  const file: TemporaryFile = { uri: 'file:///cache/app/report.pdf', append(bytes) { if (closed || deleted) throw new Error('closed'); data.push(...bytes); }, close() { closed = true; }, remove() { deleted = true; }, size() { return data.length; } };
  return { file, bytes: () => data, deleted: () => deleted };
}
function fixture(share = async (_file: TemporaryFile, _mime: string) => {}) {
  const memory = memoryFile();
  return { ...memory, transfer: new FileTransfer(() => memory.file, share) };
}
describe('bounded private file transfer', () => {
  afterEach(() => jest.useRealTimers());
  it('streams ordered chunks into a private sink and cleans after OS handoff', async () => {
    const { transfer, bytes, deleted } = fixture();
    transfer.start('one', 'report.pdf', 'application/pdf', 4);
    transfer.chunk('one', 0, new Uint8Array([37, 80])); transfer.chunk('one', 1, new Uint8Array([68, 70]));
    expect(bytes()).toEqual([37, 80, 68, 70]);
    expect(await transfer.finish('one')).toBe('handoff'); expect(deleted()).toBe(true);
  });
  it('rejects oversized declarations, path names and multiple concurrent files', () => {
    const { transfer } = fixture();
    for (const name of ['../report.pdf', '/report.pdf', 'report\\evil.pdf', 'report\u0000.pdf']) expect(() => transfer.start('bad', name, 'application/pdf', 1)).toThrow(TransferFailure);
    expect(() => transfer.start('large', 'report.pdf', 'application/pdf', 20 * 1024 * 1024 + 1)).toThrow(TransferFailure);
    transfer.start('one', 'report.pdf', 'application/pdf', 1);
    expect(() => transfer.start('two', 'report.pdf', 'application/pdf', 1)).toThrow(/busy/); transfer.cancel();
  });
  it('rejects wrong order, duplicate chunks, large chunks and actual count mismatch with partial cleanup', async () => {
    for (const index of [1, -1]) {
      const f = fixture(); f.transfer.start('one', 'report.pdf', 'application/pdf', 4);
      expect(() => f.transfer.chunk('one', index, new Uint8Array([1]))).toThrow(); expect(f.deleted()).toBe(true);
    }
    const duplicate = fixture(); duplicate.transfer.start('one', 'report.pdf', 'application/pdf', 4); duplicate.transfer.chunk('one', 0, new Uint8Array([1]));
    expect(() => duplicate.transfer.chunk('one', 0, new Uint8Array([2]))).toThrow(); expect(duplicate.deleted()).toBe(true);
    const big = fixture(); big.transfer.start('one', 'report.pdf', 'application/pdf', 100000);
    expect(() => big.transfer.chunk('one', 0, new Uint8Array(65537))).toThrow(); expect(big.deleted()).toBe(true);
    const missing = fixture(); missing.transfer.start('one', 'report.pdf', 'application/pdf', 2); missing.transfer.chunk('one', 0, new Uint8Array([1]));
    await expect(missing.transfer.finish('one')).rejects.toThrow(); expect(missing.deleted()).toBe(true);
  });
  it('times out inactivity, resets deadline on each chunk and cleans cancellations', () => {
    jest.useFakeTimers(); const f = fixture(); const timeout = jest.fn(); f.transfer.onTimeout = timeout;
    f.transfer.start('one', 'report.csv', 'text/csv', 2); jest.advanceTimersByTime(29000); f.transfer.chunk('one', 0, new Uint8Array([1]));
    jest.advanceTimersByTime(29000); expect(f.deleted()).toBe(false); jest.advanceTimersByTime(1000); expect(f.deleted()).toBe(true); expect(timeout).toHaveBeenCalledWith('one');
  });
  it('suppresses stale sharing responses after document change and retains temp file until OS closes', async () => {
    let complete!: () => void;
    const f = fixture(() => new Promise<void>(resolve => { complete = resolve; }));
    f.transfer.start('one', 'report.pdf', 'application/pdf', 1); f.transfer.chunk('one', 0, new Uint8Array([1]));
    const result = f.transfer.finish('one'); f.transfer.cancel(); expect(f.deleted()).toBe(false); complete();
    expect(await result).toBe('cancelled'); expect(f.deleted()).toBe(true);
  });
  it('does not throw from the inactivity timer when OS cleanup fails', () => {
    jest.useFakeTimers(); const timeout = jest.fn();
    const file: TemporaryFile = { uri: 'cache', append() {}, close() { throw new Error('OS failure'); }, remove() { throw new Error('OS failure'); }, size() { return 1; } };
    const transfer = new FileTransfer(() => file, async () => {}); transfer.onTimeout = timeout;
    transfer.start('one', 'report.pdf', 'application/pdf', 1);
    expect(() => jest.advanceTimersByTime(30000)).not.toThrow(); expect(timeout).toHaveBeenCalledWith('one');
  });
  it('cleans sharing failures', async () => {
    const f = fixture(async () => { throw new Error('OS unavailable'); });
    f.transfer.start('one', 'report.pdf', 'application/pdf', 1); f.transfer.chunk('one', 0, new Uint8Array([1]));
    await expect(f.transfer.finish('one')).rejects.toThrow(); expect(f.deleted()).toBe(true);
  });
});
