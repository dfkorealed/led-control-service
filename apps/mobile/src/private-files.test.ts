const entries = new Map<string, number[] | null>();
jest.mock('expo-file-system', () => {
  const path = (parts: Array<string | { uri: string }>) => parts.map(p => typeof p === 'string' ? p : p.uri).join('/');
  class Directory {
    uri: string; constructor(...parts: Array<string | { uri: string }>) { this.uri = path(parts); }
    get exists() { return entries.has(this.uri); }
    create() { entries.set(this.uri, null); }
    delete() { for (const p of entries.keys()) if (p === this.uri || p.startsWith(this.uri + '/')) entries.delete(p); }
  }
  class File {
    uri: string; constructor(...parts: Array<string | { uri: string }>) { this.uri = path(parts); }
    create() { entries.set(this.uri, []); }
    get size() { return entries.get(this.uri)?.length ?? 0; }
    open() { return { writeBytes: (bytes: Uint8Array) => entries.get(this.uri)?.push(...bytes), close() {} }; }
  }
  return { Directory, File, Paths: { cache: 'file:///private/cache' } };
});
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => {}) }));
import { createPrivateFile, cleanAbandonedShares, sharePrivateFile } from './private-files';
import { shareAsync, isAvailableAsync } from 'expo-sharing';

afterEach(() => { entries.clear(); jest.clearAllMocks(); });
describe('private Expo file adapter', () => {
  it('never lets a standalone caller create a user-controlled parent path', () => {
    expect(() => createPrivateFile('../secret.pdf')).toThrow(); expect(entries.size).toBe(0);
  });
  it('streams bytes into isolated cache locations and deletes only its own transfer folder', () => {
    const first = createPrivateFile('report.pdf'); const second = createPrivateFile('report.pdf');
    expect(first.uri).toMatch(/^file:\/\/\/private\/cache\/led-control-shares\/[^/]+\/report.pdf$/); expect(first.uri).not.toBe(second.uri);
    first.append(new Uint8Array([37,80])); first.append(new Uint8Array([68,70])); expect(entries.get(first.uri)).toEqual([37,80,68,70]); expect(first.size()).toBe(4);
    first.close(); first.remove(); expect(entries.has(first.uri)).toBe(false); expect(entries.has(second.uri)).toBe(true);
    cleanAbandonedShares(); expect(entries.size).toBe(0);
  });
  it('hands an app-private file to OS sharing and reports unavailable sharing as a failure', async () => {
    const file = createPrivateFile('report.pdf'); file.close(); await sharePrivateFile(file, 'application/pdf');
    expect(shareAsync).toHaveBeenCalledWith(file.uri, expect.objectContaining({ mimeType: 'application/pdf', UTI: 'com.adobe.pdf' }));
    jest.mocked(isAvailableAsync).mockResolvedValueOnce(false); await expect(sharePrivateFile(file, 'application/pdf')).rejects.toThrow('sharing-unavailable');
  });
});
